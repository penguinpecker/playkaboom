import "server-only";
import type { AccountInfo, PublicKey } from "@solana/web3.js";
import {
  buildExpireGame,
  buildSettleGame,
  decodeGameSession,
  type GameSessionAccount,
} from "@playkaboom/sdk";
import { BPS, GAME_EXPIRY_SLOTS } from "@playkaboom/shared";
import { getConnection } from "../connection";
import { housePubkey, programId, treasuryPubkey } from "../env";
import { query } from "../db/pg";
import { decryptSession, type SessionPayload } from "../session";
import { saltBuffer } from "../game";
import { fetchPlayerReferrer } from "../player";
import { sendHouseTx, waitConfirmed } from "../solana";
import { logger } from "../logger";

/**
 * Legacy (commit-reveal) wind-down passes. On the relaunch program start_game
 * always fails 6057, so these scans are normally empty; they exist so a stray
 * legacy game can never freeze the vault.
 *
 *   d (F2). Playing and past expiry (slot > start + 300):
 *        refund branch (no reveals, or multiplier < 1x): expire_game, 10 per tx;
 *        cash branch: [expire_game, settle_game(layout, salt, referrer)] when the
 *        server still holds the session, else expire_game alone (the player is
 *        paid; the reservation is released by their close_unsettled_game).
 *   e.   Won/Lost and not settled, session held: settle_game WITH the referrer
 *        (release-stuck-obligations; it used to skip the referral cut).
 * A session row is deleted only after its settle CONFIRMS.
 */
const GAMESESSION_DATASIZE = 180;
const EXPIRE_PER_TX = 10; // 31,460 CU and ~1,070 bytes with the compute-budget ixs
const MAX_TX = 15;

type Scanned = { pubkey: PublicKey; account: AccountInfo<Buffer> };

/** getProgramAccounts(dataSize 180), retried on RPC rate limits. */
export async function scanGameSessions(): Promise<readonly Scanned[]> {
  const conn = getConnection();
  const delays = [0, 2_500, 5_000, 9_000];
  let lastErr: unknown;
  for (const d of delays) {
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    try {
      return await conn.getProgramAccounts(programId(), {
        filters: [{ dataSize: GAMESESSION_DATASIZE }],
        commitment: "confirmed",
      });
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/429|Too Many Requests|throttled|rate ?limit/i.test(msg)) throw e;
      logger.warn({ msg }, "legacy scan: 429 from RPC, retrying");
    }
  }
  throw lastErr ?? new Error("getProgramAccounts failed after retries");
}

/** The stored session for this game, checked against the chain, or why not. */
async function sessionFor(pda: PublicKey, game: GameSessionAccount): Promise<SessionPayload | string> {
  let row: { ciphertext: string } | undefined;
  try {
    [row] = await query<{ ciphertext: string }>(
      "select ciphertext from public.game_sessions where game = $1",
      [pda.toBase58()],
    );
  } catch (e) {
    return `db select error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!row?.ciphertext) return "no server session";
  let session: SessionPayload;
  try {
    session = decryptSession(row.ciphertext);
  } catch (e) {
    return `decrypt failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (session.player !== game.player.toBase58()) return "session player mismatch";
  if (session.commitment !== Buffer.from(game.commitment).toString("hex")) {
    return "commitment mismatch (session is for a different game)";
  }
  return session;
}

async function settleIx(player: PublicKey, session: SessionPayload) {
  return buildSettleGame({
    ctx: { programId: programId() },
    player,
    houseAuthority: housePubkey(),
    treasury: treasuryPubkey(),
    mineLayout: session.mineLayout,
    salt: saltBuffer(session),
    // Throws on an RPC error: settling without a known referrer would skip the cut.
    referrer: (await fetchPlayerReferrer(player)) ?? undefined,
  });
}

/** Delete the session row once `sig` confirms (never before: a dropped settle needs it). */
async function deleteSessionAfter(sig: string, pda: PublicKey): Promise<void> {
  if (await waitConfirmed(sig)) {
    await query("delete from public.game_sessions where game = $1", [pda.toBase58()]).catch(() => undefined);
  }
}

export interface ReleaseResult {
  game: string;
  player: string;
  status: string;
  releasedLamports: string;
  signature?: string;
  reason?: string;
}

/** Pass e. Also the body of POST /api/admin/release-stuck-obligations. */
export async function releaseStuckObligations(accounts?: readonly Scanned[]) {
  const scanned = accounts ?? (await scanGameSessions());
  const candidates: { pda: PublicKey; game: GameSessionAccount }[] = [];
  for (const a of scanned) {
    try {
      const game = decodeGameSession(a.account.data);
      if ((game.status === "Won" || game.status === "Lost") && !game.settled) {
        candidates.push({ pda: a.pubkey, game });
      }
    } catch {
      /* not a GameSession */
    }
  }
  const fixed: ReleaseResult[] = [];
  const skipped: ReleaseResult[] = [];
  const errors: ReleaseResult[] = [];
  for (const { pda, game } of candidates.slice(0, MAX_TX)) {
    const result: ReleaseResult = {
      game: pda.toBase58(),
      player: game.player.toBase58(),
      status: game.status,
      releasedLamports: game.maxPayout.toString(),
    };
    const session = await sessionFor(pda, game);
    if (typeof session === "string") {
      result.reason = session;
      (session === "no server session" ? skipped : errors).push(result);
      continue;
    }
    try {
      const sig = await sendHouseTx([await settleIx(game.player, session)]);
      result.signature = sig;
      fixed.push(result);
      logger.info({ game: result.game, player: result.player, sig }, "release-stuck: settled");
      await deleteSessionAfter(sig, pda);
    } catch (e) {
      result.reason = e instanceof Error ? e.message : String(e);
      errors.push(result);
      logger.warn({ ...result }, "release-stuck: settle failed");
    }
  }
  const totalReleasedLamports = fixed.reduce((sum, r) => sum + BigInt(r.releasedLamports), 0n);
  return {
    scanned: scanned.length,
    candidates: candidates.length,
    fixed: fixed.length,
    skipped: skipped.length,
    errors: errors.length,
    totalReleasedLamports: totalReleasedLamports.toString(),
    totalReleasedSol: Number(totalReleasedLamports) / 1e9,
    details: { fixed, skipped, errors },
  };
}

/** Pass d (F2): expire every Playing legacy game past its expiry. */
export async function expireLegacyGames(accounts: readonly Scanned[]) {
  const slot = await getConnection().getSlot("confirmed");
  const ctx = { programId: programId() };
  const refunds: PublicKey[] = [];
  const cash: { pda: PublicKey; game: GameSessionAccount }[] = [];
  for (const a of accounts) {
    let game: GameSessionAccount;
    try {
      game = decodeGameSession(a.account.data);
    } catch {
      continue;
    }
    if (game.status !== "Playing" || slot <= Number(game.startSlot) + GAME_EXPIRY_SLOTS) continue;
    if (game.safeReveals === 0 || game.multiplierBps < BigInt(BPS)) refunds.push(game.player);
    else cash.push({ pda: a.pubkey, game });
  }
  const res = { expiredRefund: 0, expiredCash: 0, errors: [] as string[] };
  let txs = 0;
  for (let i = 0; i < refunds.length && txs < MAX_TX; i += EXPIRE_PER_TX, txs++) {
    const batch = refunds.slice(i, i + EXPIRE_PER_TX);
    try {
      await sendHouseTx(batch.map((player) => buildExpireGame({ ctx, player })));
      res.expiredRefund += batch.length;
    } catch (e) {
      res.errors.push(`expire batch @${i}: ${(e as Error)?.message ?? e}`);
    }
  }
  for (const { pda, game } of cash) {
    if (txs++ >= MAX_TX) break;
    try {
      const session = await sessionFor(pda, game);
      const ixs = [buildExpireGame({ ctx, player: game.player })];
      if (typeof session !== "string") ixs.push(await settleIx(game.player, session));
      const sig = await sendHouseTx(ixs);
      res.expiredCash++;
      if (typeof session !== "string") await deleteSessionAfter(sig, pda);
      else logger.warn({ game: pda.toBase58(), why: session }, "expire_game cash branch without settle");
    } catch (e) {
      res.errors.push(`expire cash ${game.player.toBase58().slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    }
  }
  return res;
}

/** Tick pass: one scan, then d and e. */
export async function runLegacyPasses() {
  const accounts = await scanGameSessions();
  if (accounts.length === 0) return { scanned: 0 };
  const expire = await expireLegacyGames(accounts);
  const release = await releaseStuckObligations(accounts);
  return { scanned: accounts.length, expire, release: { fixed: release.fixed, skipped: release.skipped, errors: release.errors } };
}
