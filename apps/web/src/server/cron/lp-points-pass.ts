import "server-only";
import type { Connection } from "@solana/web3.js";
import {
  decodeLpPosition,
  decodeVaultV2State,
  deriveV2StatePda,
  deriveVaultPda,
  type LpPositionAccount,
} from "@playkaboom/sdk";
import { getConnection } from "../connection";
import { db } from "../db/pg";
import { kPointsLpPerSolHourMicro, programId } from "../env";
import type { PointsSource } from "../points";
import { unitsToLamports } from "../vault-math";
import { LP_POSITION_DATASIZE } from "./lp-pass";

/**
 * K Points for LP providers (owner, 2026-11-05): K_POINTS_LP_PER_SOL_HOUR
 * (default 10) per SOL of LP value per hour, credited live every UTC hour.
 *
 * The first tick of each UTC hour reads every LpPosition and the vault, values
 * each position's active units at that moment's unit value, and adds value x
 * rate to the position's exact accrual (public.lp_points_accrual), crediting
 * the whole points that crosses into points_ledger ('lp_hourly',
 * lp:<owner>:<YYYY-MM-DDTHH>). Fractions carry to the next hour.
 *
 * Earns nothing: a position with a withdrawal pending (from the request until
 * it completes or is cancelled; cancelled, it earns again from the next hour,
 * even if the pass re-runs later in the same hour),
 * an empty position, and the house and seed capital (they have no LpPosition;
 * their units only dilute the unit value through total_units).
 *
 * An hour with no successful run (cron or RPC down for the whole hour) is not
 * back-filled: the next run credits only its own hour.
 */

const SOURCE: PointsSource = "lp_hourly";
/** Accrual unit: lamports (1e-9 SOL) x rate in millionths (1e-6) = 1e-15 K Points. */
const E15 = 10n ** 15n;

/** "2026-11-05T11": the UTC hour, also the ledger key suffix. */
export const hourKey = (d: Date) => d.toISOString().slice(0, 13);

/** Adds one hour at `valueLamports`; `award` is the whole points newly crossed. */
export function accrue(prevE15: bigint, valueLamports: bigint, rateMicro: bigint) {
  const accruedE15 = prevE15 + valueLamports * rateMicro;
  return { accruedE15, award: accruedE15 / E15 - prevE15 / E15 };
}

/** The positions that earn this hour, valued at the live unit value (floor). */
export function earningPositions(positions: LpPositionAccount[], totalUnits: bigint, assets: bigint) {
  const out: { owner: string; valueLamports: bigint }[] = [];
  for (const p of positions) {
    if (p.pendingUnits > 0n) continue; // withdrawal requested: points stop
    const valueLamports = unitsToLamports(p.units, assets, totalUnits);
    if (valueLamports > 0n) out.push({ owner: p.user.toBase58(), valueLamports });
  }
  return out;
}

export type LpSnapshot = { positions: LpPositionAccount[]; totalUnits: bigint; assets: bigint };

/** Every LpPosition plus the vault's unit value inputs (assets = lamports - rent, as /api/vault/state). */
export async function readLpSnapshot(conn: Connection = getConnection()): Promise<LpSnapshot | null> {
  const pid = programId();
  const [accounts, [vault, v2Info]] = await Promise.all([
    conn.getProgramAccounts(pid, { commitment: "confirmed", filters: [{ dataSize: LP_POSITION_DATASIZE }] }),
    conn.getMultipleAccountsInfo([deriveVaultPda(pid)[0], deriveV2StatePda(pid)[0]], "confirmed"),
  ]);
  if (!vault || !v2Info) return null;
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(vault.data.length));
  const lamports = BigInt(vault.lamports);
  const positions: LpPositionAccount[] = [];
  for (const a of accounts) {
    try {
      positions.push(decodeLpPosition(a.account.data));
    } catch {
      // not an LpPosition (same size, other discriminator)
    }
  }
  return {
    positions,
    totalUnits: decodeVaultV2State(v2Info.data).totalUnits,
    assets: lamports > rent ? lamports - rent : 0n,
  };
}

/**
 * Credits `owner` for `hour` at most once: the accrual row is locked, moved on
 * and stamped with the hour, and the ledger row written, in one transaction.
 * Returns the points awarded (0 while a fraction builds up), or null when this
 * hour was already credited (second run, other replica, restart).
 */
export async function creditLpHour(
  owner: string,
  valueLamports: bigint,
  rateMicro: bigint,
  hour: string,
): Promise<bigint | null> {
  const c = await db().connect();
  let broken = false;
  const onError = () => {
    broken = true; // a checked-out client has no error listener; without one a dropped socket crashes the process
  };
  c.on("error", onError);
  try {
    await c.query("begin");
    await c.query("insert into public.lp_points_accrual (owner) values ($1) on conflict (owner) do nothing", [owner]);
    const { rows } = await c.query<{ acc: string }>(
      "select accrued_e15::text as acc from public.lp_points_accrual where owner = $1 and (last_hour is null or last_hour < $2::timestamptz) for update",
      [owner, `${hour}:00Z`],
    );
    let award: bigint | null = null;
    if (rows[0]) {
      const next = accrue(BigInt(rows[0].acc), valueLamports, rateMicro);
      award = next.award;
      await c.query(
        "update public.lp_points_accrual set accrued_e15 = $2::numeric, last_hour = $3::timestamptz, updated_at = now() where owner = $1",
        [owner, next.accruedE15.toString(), `${hour}:00Z`],
      );
      if (award > 0n) {
        await c.query(
          "insert into public.points_ledger (player, source_key, source, base_points, total_points, notes) values ($1, $2, $3, $4, $4, $5) on conflict (source_key, source) do nothing",
          [owner, `lp:${owner}:${hour}`, SOURCE, award.toString(), `lp value ${valueLamports} lamports`],
        );
      }
    }
    await c.query("commit");
    return award;
  } catch (e) {
    await c.query("rollback").catch(() => (broken = true));
    throw e;
  } finally {
    c.off("error", onError);
    c.release(broken);
  }
}

// The hour this process finished, so the other ticks of the hour cost no RPC.
// The DB guard above is what makes a second run harmless.
let doneHour: string | null = null;

export async function runLpPointsHourly(now = new Date(), read: () => Promise<LpSnapshot | null> = readLpSnapshot) {
  const hour = hourKey(now);
  if (hour === doneHour) return { skipped: "hour done", hour };
  const rateMicro = kPointsLpPerSolHourMicro();
  const snap = await read();
  if (!snap) {
    doneHour = hour;
    return { skipped: "vault not initialized", hour };
  }
  const earning = earningPositions(snap.positions, snap.totalUnits, snap.assets);
  // Pending positions are stamped for the hour at value 0, so a later run this
  // hour (restart, other replica, retry) cannot credit them after a cancel.
  const stopped = snap.positions
    .filter((p) => p.pendingUnits > 0n)
    .map((p) => ({ owner: p.user.toBase58(), valueLamports: 0n }));
  const res = { hour, positions: snap.positions.length, earning: earning.length, credited: 0, points: 0n, errors: [] as string[] };
  for (const p of [...earning, ...stopped]) {
    try {
      const award = await creditLpHour(p.owner, p.valueLamports, rateMicro, hour);
      if (award !== null && p.valueLamports > 0n) {
        res.credited++;
        res.points += award;
      }
    } catch (e) {
      res.errors.push(`${p.owner.slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    }
  }
  if (!res.errors.length) doneHour = hour; // else the next tick retries the rest
  return { ...res, points: res.points.toString() };
}

/** Test hook: forget the finished hour (a fresh process). */
export function resetLpPointsHour(): void {
  doneHour = null;
}
