import "server-only";
import { decodeVaultV2State, deriveV2StatePda, deriveVaultPda } from "@playkaboom/sdk";
import { getConnection } from "./connection";
import { query, upsert } from "./db/pg";
import { programId } from "./env";
import { healthBps, unitValueE18 } from "./vault-math";

/**
 * Vault unit-value history, the input of the LP "realised return".
 *
 * Only the retired non-VRF settle_game emitted VaultUnitValueUpdated, so VRF
 * play wrote no history at all. The cron snapshots the unit value from chain
 * instead (cadence in cron/passes.ts), computed exactly as /api/vault/state
 * does (assets = vault lamports - rent minimum), scoped by program.
 */
export async function snapshotVaultUnitValue(conn = getConnection()) {
  const pid = programId();
  const {
    context,
    value: [vault, v2Info],
  } = await conn.getMultipleAccountsInfoAndContext([deriveVaultPda(pid)[0], deriveV2StatePda(pid)[0]], "confirmed");
  if (!vault || !v2Info) return { skipped: "vault or v2 state missing" };
  const v2 = decodeVaultV2State(v2Info.data as Buffer);
  if (v2.totalUnits === 0n) return { skipped: "no units" };
  const lamports = BigInt(vault.lamports);
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(vault.data.length));
  const assets = lamports > rent ? lamports - rent : 0n;
  const uv = unitValueE18(assets, v2.totalUnits);
  await upsert(
    "vault_unit_value_history",
    {
      slot: context.slot,
      program: pid.toBase58(),
      vault_assets: assets.toString(),
      total_units: v2.totalUnits.toString(),
      unit_value_e18: uv.toString(),
      health_bps: healthBps(v2, assets),
      block_time: new Date().toISOString(),
    },
    ["slot"],
  );
  return { slot: context.slot, unitValueE18: uv.toString() };
}

const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** past -> now growth over `ageMs`, compounded to a year. */
export function annualisedReturn(pastE18: bigint, nowE18: bigint, ageMs: number): number | null {
  if (pastE18 <= 0n || nowE18 <= 0n || !(ageMs > 0)) return null;
  const r = Math.pow(Number(nowE18) / Number(pastE18), YEAR_MS / ageMs) - 1;
  return Number.isFinite(r) ? r : null;
}

/**
 * Trailing return: the newest reading at least 30 days old for this program,
 * annualised by that reading's real age (not an assumed 30 days). Null until a
 * 30-day-old reading exists, or when the lookup fails.
 */
export async function trailingApy(nowE18: bigint, now = new Date()): Promise<number | null> {
  const rows = await query<{ uv: string; t: number }>(
    "select unit_value_e18::text as uv, extract(epoch from block_time)::float8 as t from public.vault_unit_value_history where program = $1 and block_time <= $2 order by block_time desc limit 1",
    [programId().toBase58(), new Date(now.getTime() - WINDOW_MS).toISOString()],
  ).catch(() => []);
  const row = rows[0];
  return row ? annualisedReturn(BigInt(row.uv), nowE18, now.getTime() - row.t * 1000) : null;
}
