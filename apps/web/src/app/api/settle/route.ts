import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildCashOut, buildSettleGame, deriveGamePda, serializeIx } from "@playkaboom/sdk";
import { SettleInput } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { saltBuffer } from "@/server/game";
import { loadSession, deleteSession } from "@/server/session-store";
import { OnChainError, requireActiveGame, sendHouseTx } from "@/server/solana";
import { housePubkey, programId, treasuryPubkey, useMagicblock } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";
import { fetchPlayerReferrer } from "@/server/player";
import { indexFreshSignature } from "@/server/inline-ingest";
import { buildSettleGameEr, deriveGameV2Pda } from "@/server/er-instructions";
import { deleteSessionKey } from "@/server/session-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let bodyPlayer: string | null = null;
  try {
    const body = await parseBody(req, SettleInput);
    bodyPlayer = body.player;

    // Auth + ratelimit + session-load in parallel (see reveal/route.ts).
    const [, rl, session] = await Promise.all([
      verifyPlayerAuth(req, body.player),
      enforceRateLimit(`settle:${clientIp(req)}:${body.player}`),
      loadSession(body.player, body.gameToken),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");
    if (!session) throw new ApiError(404, "No active session — start a new game");
    if (session.player !== body.player) {
      throw new ApiError(403, "Player mismatch");
    }

    const playerPk = new PublicKey(body.player);
    const ctx = { programId: programId() };

    // On-chain truth gate — same rationale as /api/reveal. Without this,
    // a stale gameToken + closed GameSession PDA produced an opaque 500
    // from cash_out / settle_game simulation.
    const onChainGame = await requireActiveGame(playerPk);
    if (!onChainGame) {
      await deleteSession(body.player);
      throw new ApiError(409, "Game session no longer active — start a new round.", {
        needsCleanup: true,
      });
    }

    if (body.phase === "settle") {
      const referrer = await fetchPlayerReferrer(playerPk);

      if (useMagicblock(body.player)) {
        // ER settle: commit_and_undelegate runs inside settle_game_er, so
        // the same Turnkey-signed tx undelegates the GameSession PDA back
        // to L1 and pays out. We submit to the ER endpoint; the validator
        // commits state back to L1 automatically.
        //
        // NOTE: GetCommitmentSignature (from the Magicblock SDK) would let
        // us return the L1 commit-back signature for indexer ingestion.
        // Until the SDK's exact export name is confirmed (0.13.0 docs vary
        // between `GetCommitmentSignature` and `getCommitmentSignature`),
        // we return the ER signature and let the cron tickler pick up the
        // committed L1 tx — same path the indexer uses for any other
        // confirmed settle today.
        const settleErIx = buildSettleGameEr({
          ctx,
          player: playerPk,
          houseAuthority: housePubkey(),
          treasury: treasuryPubkey(),
          mineLayout: session.mineLayout,
          salt: saltBuffer(session),
          referrer: referrer ?? undefined,
        });
        const sig = await sendHouseTx([settleErIx], { target: "er" });
        logger.info({ player: body.player, sig, mode: "er" }, "settle");

        const [gamePda] = deriveGameV2Pda(programId(), playerPk);
        // Settle succeeded on ER — drop the per-game session key and the
        // server-side session row. Idempotent.
        await Promise.all([deleteSessionKey(gamePda), deleteSession(body.player)]);
        return NextResponse.json({
          signature: sig,
          mineLayout: session.mineLayout,
          verified: true,
          mode: "er",
        });
      }

      const sig = await sendHouseTx([
        buildSettleGame({
          ctx,
          player: playerPk,
          houseAuthority: housePubkey(),
          treasury: treasuryPubkey(),
          mineLayout: session.mineLayout,
          salt: saltBuffer(session),
          referrer: referrer ?? undefined,
        }),
      ]);
      logger.info({ player: body.player, sig }, "settle");
      // Background-index the fresh sig (see reveal/route.ts). Awaiting was
      // adding 1.3s p50 / 5.2s p99 to settle response time. Cron + dedup
      // covers the same ground without blocking the player.
      void indexFreshSignature(sig);
      // Game is closed on chain; clear server-side session.
      await deleteSession(body.player);
      return NextResponse.json({ signature: sig, mineLayout: session.mineLayout, verified: true });
    }

    // Phase 1: hand the player their cash_out instruction to sign.
    const ix = buildCashOut({ ctx, player: playerPk });
    return NextResponse.json({ phase: "cashout", instruction: serializeIx(ix) });
  } catch (err) {
    if (err instanceof OnChainError && err.kind === "account_not_initialized") {
      if (bodyPlayer) await deleteSession(bodyPlayer).catch(() => {});
      return jsonError(
        new ApiError(409, "Game session no longer active — start a new round.", {
          needsCleanup: true,
        }),
      );
    }
    return jsonError(err);
  }
}
