import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCloseGame,
  buildCloseUnsettledGame,
  buildRefundExpired,
  buildSettleGame,
  decodeGameSession,
  deriveGamePda,
  serializeIx,
} from "@playkaboom/sdk";
import { CleanupInput, CLOSE_UNSETTLED_EXPIRY_SLOTS, GAME_EXPIRY_SLOTS } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { saltBuffer } from "@/server/game";
import { loadSession, deleteSession } from "@/server/session-store";
import { sendHouseTx } from "@/server/solana";
import { getConnection } from "@/server/connection";
import { housePubkey, programId, treasuryPubkey } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Slot timers from the on-chain program (programs/kaboom/src/lib.rs).
// Pulled from @playkaboom/shared so any program change auto-propagates.
const REFUND_EXPIRED_SLOTS = GAME_EXPIRY_SLOTS;
const CLOSE_UNSETTLED_SLOTS = CLOSE_UNSETTLED_EXPIRY_SLOTS;

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, CleanupInput);

    await verifyPlayerAuth(req, body.player);

    const rl = await enforceRateLimit(`cleanup:${clientIp(req)}:${body.player}`);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    const playerPk = new PublicKey(body.player);
    const ctx = { programId: programId() };
    const [gamePda] = deriveGamePda(ctx.programId, playerPk);
    const conn = getConnection();
    const info = await conn.getAccountInfo(gamePda, "confirmed");
    if (!info) {
      // Game closed on-chain; clear any stale server-side session.
      await deleteSession(body.player);
      return NextResponse.json({ active: false });
    }

    // Decode the on-chain state so we can pick the right recovery ix.
    let game;
    try {
      game = decodeGameSession(info.data);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, gamePda: gamePda.toBase58() },
        "cleanup: decodeGameSession failed",
      );
      // Can't decode → fall back to legacy behavior (offer both ixs and let
      // the client try them).
      return NextResponse.json({
        active: true,
        action: "unknown",
        closeInstruction: serializeIx(buildCloseGame({ ctx, player: playerPk })),
        refundInstruction: serializeIx(buildRefundExpired({ ctx, player: playerPk })),
      });
    }

    // If we still have the encrypted session and the game is in a state where
    // settle_game would close it cleanly (Won/Lost && !settled), try server-
    // side settle first — that flips settled=true so the subsequent close_game
    // succeeds without the 600-slot wait.
    if ((game.status === "Won" || game.status === "Lost") && !game.settled) {
      try {
        const session = await loadSession(body.player, body.gameToken);
        if (session && session.player === body.player) {
          await sendHouseTx([
            buildSettleGame({
              ctx,
              player: playerPk,
              houseAuthority: housePubkey(),
              treasury: treasuryPubkey(),
              mineLayout: session.mineLayout,
              salt: saltBuffer(session),
            }),
          ]);
          // Refresh state — settle should have flipped settled=true.
          const refreshed = await conn.getAccountInfo(gamePda, "confirmed");
          if (refreshed) {
            try {
              game = decodeGameSession(refreshed.data);
            } catch {
              /* keep stale game; close_game branch may still try */
            }
          }
        }
      } catch (settleErr) {
        logger.warn(
          { err: settleErr instanceof Error ? settleErr.message : settleErr },
          "cleanup: server-side settle failed, falling through to close_unsettled path",
        );
      }
    }

    const currentSlot = await conn.getSlot("confirmed");
    const startSlot = Number(game.startSlot);

    // Pick the right recovery action based on the on-chain status.
    //   Expired                         → close_game (no slot guard, no funds at stake)
    //   Won/Lost && settled             → close_game (rent recovery; payout already moved)
    //   Won/Lost && !settled            → close_unsettled_game (after start + 600 slots)
    //   Playing                         → refund_expired (after start + 300 slots; refunds bet)
    if (game.status === "Expired" || ((game.status === "Won" || game.status === "Lost") && game.settled)) {
      return NextResponse.json({
        active: true,
        action: "close_game",
        instruction: serializeIx(buildCloseGame({ ctx, player: playerPk })),
        readyAt: currentSlot,
        secondsUntilReady: 0,
      });
    }

    if (game.status === "Won" || game.status === "Lost") {
      const readyAt = startSlot + CLOSE_UNSETTLED_SLOTS;
      const slotsUntilReady = Math.max(0, readyAt - currentSlot);
      const secondsUntilReady = Math.ceil(slotsUntilReady * 0.4);
      if (slotsUntilReady === 0) {
        return NextResponse.json({
          active: true,
          action: "close_unsettled_game",
          instruction: serializeIx(buildCloseUnsettledGame({ ctx, player: playerPk })),
          readyAt,
          secondsUntilReady: 0,
        });
      }
      return NextResponse.json({
        active: true,
        action: "wait_close_unsettled",
        readyAt,
        secondsUntilReady,
        currentSlot,
      });
    }

    // status === "Playing"
    const readyAt = startSlot + REFUND_EXPIRED_SLOTS;
    const slotsUntilReady = Math.max(0, readyAt - currentSlot);
    const secondsUntilReady = Math.ceil(slotsUntilReady * 0.4);
    if (slotsUntilReady === 0) {
      return NextResponse.json({
        active: true,
        action: "refund_expired",
        instruction: serializeIx(buildRefundExpired({ ctx, player: playerPk })),
        readyAt,
        secondsUntilReady: 0,
      });
    }
    return NextResponse.json({
      active: true,
      action: "wait_refund",
      readyAt,
      secondsUntilReady,
      currentSlot,
    });
  } catch (err) {
    return jsonError(err);
  }
}
