import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildSettleGame,
  decodeGameSession,
  type GameSessionAccount,
} from "@playkaboom/sdk";
import { ApiError, jsonError } from "@/server/api-helpers";
import { getConnection } from "@/server/connection";
import { housePubkey, programId, treasuryPubkey } from "@/server/env";
import { supabaseAdmin } from "@/server/db/supabase";
import { decryptSession } from "@/server/session";
import { saltBuffer } from "@/server/game";
import { sendHouseTx } from "@/server/solana";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-shot admin endpoint to release leaked
 * `total_outstanding_max_payout` obligations on the on-chain Vault.
 *
 * Background: every game increments `total_outstanding_max_payout` by
 * `worst_case_payout` at start_game. It's only decremented at
 * settle_game / refund_expired / close_unsettled_game. If any of those
 * fail to fire (e.g. perfect-game trap pre-G1, server-side settle that
 * RPC-failed without retry), the obligation accumulates on chain and
 * suppresses vault health. As of this commit there's ~5.77 SOL of
 * leaked obligations on production.
 *
 * Only fixable case from server-side: GameSession in Won/Lost + !settled
 * state where the encrypted server session row is still in Supabase
 * (so we can decrypt the layout+salt and build a valid settle_game).
 *
 * Other stuck cases need player signatures and can't be cleaned by the
 * operator alone:
 *   - Playing past slot+300:        player must sign refund_expired
 *   - Won/Lost + !settled, no session: player must sign close_unsettled_game
 *   - Won/Lost + settled (rent only): player must sign close_game
 *
 * Auth: CRON_SECRET-gated. Run with:
 *   curl -X POST https://playkaboom.gg/api/admin/release-stuck-obligations \
 *     -H "Authorization: Bearer $CRON_SECRET"
 */
const GAMESESSION_DATASIZE = 180;

interface ReleaseResult {
  game: string;
  player: string;
  status: string;
  releasedLamports: string;
  signature?: string;
  reason?: string;
}

function requireCronAuth(req: NextRequest): void {
  // 2026-05-21: ADMIN_RELEASE_SECRET is the per-purpose secret for this
  // endpoint; CRON_SECRET kept as a transitional fallback during rotation.
  // Remove the CRON_SECRET branch once GitHub Actions + operator clients
  // are migrated and the legacy value is rotated out.
  const accepted = [process.env.ADMIN_RELEASE_SECRET, process.env.CRON_SECRET].filter(
    (s): s is string => Boolean(s),
  );
  if (accepted.length === 0) {
    throw new ApiError(503, "ADMIN_RELEASE_SECRET not configured");
  }
  const provided = req.headers.get("authorization");
  if (!provided || !provided.startsWith("Bearer ")) {
    throw new ApiError(401, "Missing bearer token");
  }
  const token = provided.slice(7);
  if (!accepted.some((s) => s === token)) throw new ApiError(401, "Bad token");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    requireCronAuth(req);
    const conn = getConnection();
    const ctx = { programId: programId() };
    const housePk = housePubkey();

    // Fetch all GameSession PDAs by exact account size. getProgramAccounts
    // is the heaviest RPC call we make — Alchemy's CU/s limit kicks in
    // routinely on a single invocation. Retry up to 4 times with
    // exponential backoff. If it still 429s after that, surface the error.
    const accounts = await (async () => {
      const delays = [0, 2_500, 5_000, 9_000];
      let lastErr: unknown;
      for (let i = 0; i < delays.length; i++) {
        if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
        try {
          return await conn.getProgramAccounts(ctx.programId, {
            filters: [{ dataSize: GAMESESSION_DATASIZE }],
            commitment: "confirmed",
          });
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          if (!/429|Too Many Requests|throttled|rate ?limit/i.test(msg)) throw e;
          logger.warn({ attempt: i + 1, msg }, "release-stuck: 429 from RPC, retrying");
        }
      }
      throw lastErr ?? new Error("getProgramAccounts failed after retries");
    })();
    logger.info({ count: accounts.length }, "release-stuck: scanned program accounts");

    const candidates: { pda: PublicKey; game: GameSessionAccount }[] = [];
    for (const a of accounts) {
      try {
        const game = decodeGameSession(a.account.data);
        // Only Won/Lost + !settled is server-fixable via settle_game.
        if (
          (game.status === "Won" || game.status === "Lost") &&
          !game.settled
        ) {
          candidates.push({ pda: a.pubkey, game });
        }
      } catch {
        /* not a GameSession; ignore */
      }
    }
    logger.info(
      { candidates: candidates.length },
      "release-stuck: found settle-eligible candidates",
    );

    const fixed: ReleaseResult[] = [];
    const skipped: ReleaseResult[] = [];
    const errors: ReleaseResult[] = [];

    const db = supabaseAdmin();

    for (const { pda, game } of candidates) {
      const result: ReleaseResult = {
        game: pda.toBase58(),
        player: game.player.toBase58(),
        status: game.status,
        releasedLamports: game.maxPayout.toString(),
      };

      // Look up the encrypted session row keyed by GameSession PDA.
      const { data, error } = await db
        .from("game_sessions")
        .select("ciphertext")
        .eq("game", pda.toBase58())
        .maybeSingle();

      if (error) {
        result.reason = `supabase select error: ${error.message}`;
        errors.push(result);
        continue;
      }
      if (!data?.ciphertext) {
        result.reason =
          "no server session — needs player-signed close_unsettled_game (after slot+600)";
        skipped.push(result);
        continue;
      }

      let session;
      try {
        session = decryptSession(data.ciphertext);
      } catch (e) {
        result.reason = `decrypt failed: ${e instanceof Error ? e.message : String(e)}`;
        errors.push(result);
        continue;
      }

      // Sanity checks before signing — the on-chain commitment must
      // match what the session encodes; if not, this session can't
      // settle this game (would error CommitmentMismatch on chain).
      if (session.player !== game.player.toBase58()) {
        result.reason = "session player mismatch";
        errors.push(result);
        continue;
      }
      const onChainCommitment = Buffer.from(game.commitment).toString("hex");
      if (session.commitment !== onChainCommitment) {
        result.reason = "commitment mismatch (session is for a different game)";
        errors.push(result);
        continue;
      }

      try {
        const sig = await sendHouseTx([
          buildSettleGame({
            ctx,
            player: game.player,
            houseAuthority: housePk,
            treasury: treasuryPubkey(),
            mineLayout: session.mineLayout,
            salt: saltBuffer(session),
          }),
        ]);
        result.signature = sig;
        fixed.push(result);
        logger.info(
          { game: result.game, player: result.player, sig },
          "release-stuck: settled",
        );
        // Best-effort: delete the session row now that on-chain is settled.
        await db
          .from("game_sessions")
          .delete()
          .eq("game", pda.toBase58())
          .then(() => undefined);
      } catch (e) {
        result.reason = e instanceof Error ? e.message : String(e);
        errors.push(result);
        logger.warn({ ...result }, "release-stuck: settle failed");
      }
    }

    const totalReleasedLamports = fixed.reduce(
      (sum, r) => sum + BigInt(r.releasedLamports),
      0n,
    );

    return NextResponse.json({
      scanned: accounts.length,
      candidates: candidates.length,
      fixed: fixed.length,
      skipped: skipped.length,
      errors: errors.length,
      totalReleasedLamports: totalReleasedLamports.toString(),
      totalReleasedSol: Number(totalReleasedLamports) / 1e9,
      details: { fixed, skipped, errors },
    });
  } catch (err) {
    return jsonError(err);
  }
}
