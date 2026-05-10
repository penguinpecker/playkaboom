import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCloseGame,
  buildRevealTile,
  buildSettleGame,
  serializeIx,
} from "@playkaboom/sdk";
import { GRID_SIZE, RevealTileInput } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { checkTile, saltBuffer } from "@/server/game";
import { encryptSession } from "@/server/session";
import { loadSession, saveSession, deleteSession } from "@/server/session-store";
import { sendHouseTx } from "@/server/solana";
import { housePubkey, programId } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";
import { indexFreshSignature } from "@/server/inline-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, RevealTileInput);

    // Auth + ratelimit + session-load are independent → run in parallel.
    // Saves 100-300ms on the hot reveal path. Note: rate limit consumes
    // a slot even if auth fails; that's the desired anti-abuse behavior.
    const [, rl, session] = await Promise.all([
      verifyPlayerAuth(req, body.player),
      enforceRateLimit(`reveal:${clientIp(req)}:${body.player}`),
      loadSession(body.player, body.gameToken),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");
    if (!session) throw new ApiError(404, "No active session — start a new game");
    if (session.player !== body.player) {
      throw new ApiError(403, "Player mismatch");
    }
    if (session.reveals.includes(body.tileIndex)) {
      throw new ApiError(409, "Tile already revealed");
    }

    const playerPk = new PublicKey(body.player);
    const housePk = housePubkey();
    const ctx = { programId: programId() };

    const { isMine, updated } = checkTile(session, body.tileIndex);

    // Perfect-game trap defense (G1). The on-chain `reveal_tile` handler
    // auto-flips status → Won when safe_reveals == GRID_SIZE - mine_count
    // (programs/kaboom/src/lib.rs:397-400). After that, `cash_out` rejects
    // with GameNotPlaying and `settle_game` doesn't pay out — the player's
    // winnings are stuck. Refuse to dispatch the final safe reveal here;
    // the player must `cash_out` first to claim. Mine reveals are not
    // affected (those auto-settle into Lost).
    if (!isMine) {
      const newSafeReveals = updated.reveals.filter(
        (t) => (updated.mineLayout & (1 << t)) === 0,
      ).length;
      const totalSafe = GRID_SIZE - session.mineCount;
      if (newSafeReveals >= totalSafe) {
        throw new ApiError(
          409,
          "That was the last safe tile — cash out now to claim your winnings.",
          { needsCashOut: true },
        );
      }
    }

    const revealIx = buildRevealTile({
      ctx,
      player: playerPk,
      houseAuthority: housePk,
      tileIndex: body.tileIndex,
      isMine,
    });

    let signature: string;
    let closeInstruction: ReturnType<typeof serializeIx> | undefined;

    if (isMine) {
      // Atomic reveal + settle so the player can never see "lost but unsettled".
      const settleIx = buildSettleGame({
        ctx,
        player: playerPk,
        houseAuthority: housePk,
        mineLayout: updated.mineLayout,
        salt: saltBuffer(updated),
      });
      signature = await sendHouseTx([revealIx, settleIx]);
      closeInstruction = serializeIx(buildCloseGame({ ctx, player: playerPk }));
      // Auto-settle on mine — push to indexer in the background. Don't
      // await: the cron tickler + (when configured) the Helius webhook
      // both pick up the same sig within seconds, and `processed_events`
      // dedups any double-apply. Awaiting was costing the response 1.3s
      // p50 / 5.2s p99 on every mine reveal.
      void indexFreshSignature(signature);
    } else {
      signature = await sendHouseTx([revealIx]);
    }

    const safeReveals = updated.reveals.filter((t) => (updated.mineLayout & (1 << t)) === 0).length;

    logger.info(
      { player: body.player, tile: body.tileIndex, isMine, sig: signature },
      "reveal",
    );

    // G4: on mine the game is Lost+settled on-chain; delete the server-side
    // session so the next /api/session probe returns gameToken=null and the
    // recovery banner shows the FORCE-CLOSE path (not RESUME with a stale
    // token that points at a Lost game and would error on every reveal).
    // Return an empty token so the client clears localStorage too.
    let newToken = "";
    if (!isMine) {
      newToken = await saveSession(body.player, updated, session.createdAt);
    } else {
      await deleteSession(body.player);
    }
    void encryptSession; // keep import for type-only; saveSession encrypts

    return NextResponse.json({
      isMine,
      tileIndex: body.tileIndex,
      signature,
      safeReveals,
      gameToken: newToken,
      closeInstruction,
    });
  } catch (err) {
    return jsonError(err);
  }
}
