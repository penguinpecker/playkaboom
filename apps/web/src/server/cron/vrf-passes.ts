import "server-only";
import { PublicKey, type Finality } from "@solana/web3.js";
import bs58 from "bs58";
import {
  accountDiscriminator,
  buildForceUndelegateVrf,
  buildRefundStalledVrf,
  decodeVrfClaim,
  decodeVrfGame,
  deriveVrfGamePda,
  DELEGATION_PROGRAM,
  type VrfClaimAccount,
  type VrfGameAccount,
} from "@playkaboom/sdk";
import { getConnection, getErConnection, msPerSlot } from "../connection";
import { housePubkey, programId, vrfModeEnabled } from "../env";
import { sendHouseErTx, sendHouseTx } from "../solana";
import { indexFreshSignature } from "../inline-ingest";
import { mirrorVrfSettle, sendSettleVrf } from "../vrf-settle";
import { logger } from "../logger";

/**
 * FIXES.md 9.3 a, b, c, c': the VRF house passes, in one scan.
 *
 * L1 (program-owned VrfGame, i.e. undelegated):
 *   a.  WON / LOST, last successful L1 tx on the game >= 60 s old (the player's
 *       client settles first) or claim >= 30 min old
 *                             -> settle_vrf (referral PDA mandatory, F5)
 *   c.  VOID                  -> refund_stalled_vrf, house-signed, at once
 *   c'. PLAYING, safe 0, not pending, claim >= 60 s old
 *                             -> refund_stalled_vrf (a start that was never delegated)
 * ER (claim whose game is DLP-owned on L1, i.e. still delegated):
 *   b.  WON / LOST / VOID and idle >= 60 s on the ER, or PLAYING, not pending and
 *       idle >= 300 s on the ER; any of these once the claim is >= 30 min old.
 *       "Idle" is time since the game's last successful ER tx; a game the ER
 *       never touched is idle since its start (claim age).
 *                             -> force_undelegate_vrf (house-signed ER tx). The
 *       game comes back WON or VOID and a later tick's a / c closes it.
 *
 * A VrfGame with no claim is an F6 orphan (admin release): nothing to do here,
 * the player's next start reuses it.
 *
 * Claim age is slots × the MEASURED slot time (msPerSlot). These windows are
 * wall-clock intents; a nominal 400 ms/slot ran every one of them at about
 * half its length on mainnet's ~214 ms slots.
 */
const SETTLED_IDLE_MS = 60_000; // let the player's own client finish first (claim age, or since the last tx on the game)
// Absolute cap for EVERY status (audit A1). The idle signal is "newest tx that
// lists the game", and anyone can send one, so idle alone could hold a finished
// game (and its reserve) forever. ~30 min is where a PLAYING game is already
// taken from the player, so no honest game is still the player's to finish
// past it; settle_vrf pays the recorded player whoever sends it.
const FORCE_AGE_MS = 30 * 60_000;
const FORCE_IDLE_MS = 300_000; // 5 min with no ER tx on the game
const SIG_WINDOW = 20; // newest txs scanned for the last successful one
const MAX_TX_PER_KIND = 15;

type Delegated = { player: PublicKey; game: PublicKey; claim: VrfClaimAccount };
type At = { game: PublicKey; status: string; ageMs: number };

const WARN_EVERY_MS = 60_000;
// ponytail: per-process map, cleared wholesale past 10k games; enough for one replica.
const lastWarn = new Map<string, number>();

/**
 * Warn that the cron left a game alone this tick for a reason other than "not
 * idle yet" (RPC failure, per-tick cap, failed send, ER has no game). A stuck
 * game warns at most once a minute.
 */
function warnSkip(at: At, reason: string) {
  const game = at.game.toBase58();
  const now = Date.now();
  const last = lastWarn.get(game);
  if (last !== undefined && now - last < WARN_EVERY_MS) return;
  if (lastWarn.size > 10_000) lastWarn.clear();
  lastWarn.set(game, now);
  logger.warn({ game, status: at.status, ageS: Math.round(at.ageMs / 1000), reason }, "cron: vrf game skipped");
}

const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

function decodeOr<T>(f: (b: Buffer) => T, data: Buffer): T | null {
  try {
    return f(data);
  } catch {
    return null;
  }
}

async function getMany(conn: ReturnType<typeof getConnection>, keys: PublicKey[]) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")));
  }
  return out;
}

export async function runVrfPasses() {
  if (!vrfModeEnabled()) return { skipped: "vrf mode disabled" };
  const conn = getConnection();
  const pid = programId();
  const house = housePubkey();
  const disc = (name: string) => [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator(name)) } }];
  const [claimAccs, gameAccs, slot, slotMs] = await Promise.all([
    conn.getProgramAccounts(pid, { commitment: "confirmed", filters: disc("VrfClaim") }),
    conn.getProgramAccounts(pid, { commitment: "confirmed", filters: disc("VrfGame") }),
    conn.getSlot("confirmed"),
    msPerSlot(conn),
  ]);

  const claims = new Map<string, VrfClaimAccount>();
  for (const a of claimAccs) {
    const c = decodeOr(decodeVrfClaim, a.account.data);
    if (c && !c.settled) claims.set(c.player.toBase58(), c);
  }

  const res = { claims: claims.size, settled: 0, refunded: 0, forced: 0, errors: [] as string[], needsReview: [] as string[] };
  const fail = (what: string, player: PublicKey, e: unknown, at: At) => {
    res.errors.push(`${what} ${player.toBase58().slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    warnSkip(at, `${what} failed: ${errMsg(e)}`);
  };
  const refund = async (player: PublicKey, at: At) => {
    if (res.refunded >= MAX_TX_PER_KIND) return warnSkip(at, `refund cap (${MAX_TX_PER_KIND}/tick) reached`);
    try {
      const sig = await sendHouseTx([buildRefundStalledVrf({ ctx: { programId: pid }, player, caller: house })]);
      void indexFreshSignature(sig);
      res.refunded++;
      logger.info({ player: player.toBase58(), sig }, "cron: vrf refund");
    } catch (e) {
      fail("refund", player, e, at);
    }
  };

  // ── L1: a, c, c' ──────────────────────────────────────────────────────────
  const onL1 = new Set<string>();
  for (const a of gameAccs) {
    const g = decodeOr(decodeVrfGame, a.account.data);
    if (!g) continue; // zero-closed (refunded) games keep their length with zeroed data
    const key = g.player.toBase58();
    onL1.add(key);
    const claim = claims.get(key);
    if (!claim) continue; // F6 orphan or already closed
    const at: At = { game: a.pubkey, status: g.status, ageMs: (slot - Number(claim.startSlot)) * slotMs };
    if (g.status === "Won" || g.status === "Lost") {
      if (res.settled >= MAX_TX_PER_KIND) {
        warnSkip(at, `settle cap (${MAX_TX_PER_KIND}/tick) reached`);
        continue;
      }
      if (!(await settleDue(conn, a.pubkey, slot - Number(claim.startSlot), slotMs, g.status))) continue;
      try {
        const sig = await sendSettleVrf(g.player);
        void indexFreshSignature(sig);
        void mirrorVrfSettle(sig, g.player, claim, g);
        res.settled++;
        logger.info({ player: key, sig, status: g.status, ageS: Math.round(at.ageMs / 1000) }, "cron: vrf settle");
      } catch (e) {
        fail("settle", g.player, e, at);
      }
    } else if (g.status === "Void") {
      await refund(g.player, at);
    } else if (g.safeReveals === 0 && !g.pending) {
      if ((slot - Number(claim.startSlot)) * slotMs >= SETTLED_IDLE_MS) await refund(g.player, at);
    } else {
      // PLAYING with progress on L1 cannot happen after the round-2 F3 fix
      // (an undelegate ends the game first). Never refund it: that would
      // destroy the winnings. Surface it instead.
      res.needsReview.push(key);
    }
  }

  // ── ER: b ────────────────────────────────────────────────────────────────
  const candidates: Delegated[] = [];
  for (const [key, claim] of claims) {
    if (onL1.has(key)) continue;
    candidates.push({ player: claim.player, game: deriveVrfGamePda(pid, claim.player)[0], claim });
  }
  if (candidates.length > 0) {
    const l1 = await getMany(conn, candidates.map((c) => c.game));
    const delegated = candidates.filter((_, i) => l1[i]?.owner.equals(DELEGATION_PROGRAM));
    if (delegated.length > 0) {
      const er = getErConnection();
      const erGames = await getMany(er, delegated.map((d) => d.game));
      for (let i = 0; i < delegated.length; i++) {
        const d = delegated[i]!;
        const info = erGames[i];
        const g: VrfGameAccount | null = info ? decodeOr(decodeVrfGame, info.data) : null;
        const ageMs = (slot - Number(d.claim.startSlot)) * slotMs;
        if (!g) {
          warnSkip({ game: d.game, status: "unknown", ageMs }, "delegated on L1 but the ER returned no decodable game");
          continue;
        }
        const at: At = { game: d.game, status: g.status, ageMs };
        if (res.forced >= MAX_TX_PER_KIND) {
          // Same stop as before (no RPC, no send); terminal games left over are reported.
          if (g.status !== "Playing") warnSkip(at, `force cap (${MAX_TX_PER_KIND}/tick) reached`);
          continue;
        }
        if (!(await shouldForce(er, d, g, slot, slotMs))) continue;
        try {
          const sig = await sendHouseErTx([
            buildForceUndelegateVrf({ ctx: { programId: pid }, player: d.player, house }),
          ]);
          res.forced++;
          logger.info(
            { player: d.player.toBase58(), sig, status: g.status, ageS: Math.round(ageMs / 1000) },
            "cron: vrf force undelegate",
          );
        } catch (e) {
          fail("force", d.player, e, at);
        }
      }
    }
  }

  if (res.needsReview.length) logger.warn({ players: res.needsReview }, "vrf games PLAYING with progress on L1 — manual review");
  return res;
}

/** Pass a gate for a WON / LOST game on L1: the player's grace is over, or the claim hit the age cap. `age` is in slots. */
export async function settleDue(
  conn: ReturnType<typeof getConnection>,
  game: PublicKey,
  age: number,
  slotMs: number,
  status: string,
): Promise<boolean> {
  const ageMs = age * slotMs;
  if (ageMs >= FORCE_AGE_MS) return true;
  try {
    const t = await lastOkTxTime(conn, game, "confirmed");
    return t == null || Date.now() - t * 1000 >= SETTLED_IDLE_MS;
  } catch (e) {
    warnSkip({ game, status, ageMs }, `L1 idle check RPC failed: ${errMsg(e)}`);
    return false; // retry next tick
  }
}

export async function shouldForce(
  er: ReturnType<typeof getErConnection>,
  d: Delegated,
  g: VrfGameAccount,
  slot: number,
  slotMs: number,
): Promise<boolean> {
  const ageMs = (slot - Number(d.claim.startSlot)) * slotMs;
  const playing = g.status === "Playing";
  if (playing && g.pending) return false; // the oracle answers first; force would fail 6044
  if (ageMs >= FORCE_AGE_MS) return true;
  // Terminal games: the grace runs from the last ER tx (the cash-out / loss),
  // not from the start, so the player's own undelegate lands first.
  const idleMs = playing ? FORCE_IDLE_MS : SETTLED_IDLE_MS;
  try {
    const t = await lastOkTxTime(er, d.game);
    // No ER tx (delegated, never revealed) or no time: idle since the start.
    if (t == null) return ageMs >= idleMs;
    return Date.now() - t * 1000 >= idleMs;
  } catch (e) {
    // No idle signal: the age cap above forces it later.
    warnSkip({ game: d.game, status: g.status, ageMs }, `ER idle check RPC failed: ${errMsg(e)}`);
    return false;
  }
}

/**
 * blockTime of the newest successful tx on `account`, or null (none / no time).
 * A failed tx cannot change the game, so it is not activity. If every scanned
 * tx failed, the last good one is older than the oldest scanned: use that.
 */
async function lastOkTxTime(
  conn: ReturnType<typeof getConnection>,
  account: PublicKey,
  commitment?: Finality,
): Promise<number | null> {
  const sigs = await conn.getSignaturesForAddress(account, { limit: SIG_WINDOW }, commitment);
  return (sigs.find((s) => s.err == null) ?? sigs[sigs.length - 1])?.blockTime ?? null;
}
