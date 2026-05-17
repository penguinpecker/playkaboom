import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCloseGame,
  buildCloseUnsettledGame,
  buildRefundExpired,
  buildResetStrandedV2Session,
  buildSettleGame,
  decodeGameSession,
  deriveGamePda,
  deriveGameV2Pda,
  serializeIx,
} from "@playkaboom/sdk";
import { CleanupInput } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { saltBuffer } from "@/server/game";
import { loadSession, deleteSession } from "@/server/session-store";
import { sendHouseTx } from "@/server/solana";
import { getConnection } from "@/server/connection";
import { housePubkey, programId, treasuryPubkey } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";

// Mainnet Magicblock Delegation Program (DLP) ID. Used to disambiguate a
// stranded-but-undelegated V2 PDA (owner == kaboom program) from a
// fully-delegated one (owner == DLP). reset_stranded_v2_session only
// handles the former; the latter routes through settle_game_er.
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Slot timers from the on-chain program (programs/kaboom/src/lib.rs).
const REFUND_EXPIRED_SLOTS = 300; // refund_expired needs slot >= start + 300
const CLOSE_UNSETTLED_SLOTS = 600; // close_unsettled_game needs slot >= start + 600

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, CleanupInput);

    await verifyPlayerAuth(req, body.player);

    const rl = await enforceRateLimit(`cleanup:${clientIp(req)}:${body.player}`);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    const playerPk = new PublicKey(body.player);
    const ctx = { programId: programId() };
    const [gamePda] = deriveGamePda(ctx.programId, playerPk);
    const [gameV2Pda] = deriveGameV2Pda(ctx.programId, playerPk);
    const conn = getConnection();

    // Fetch both PDAs in one RPC round-trip. V1 takes priority if both
    // somehow exist (would only happen during a brief migration window);
    // the V2 path only fires when V1 is absent.
    const [info, v2Info] = await conn.getMultipleAccountsInfo(
      [gamePda, gameV2Pda],
      "confirmed",
    );

    // V2 (Magicblock ER) stranded-recovery path. If the V2 PDA exists but
    // V1 doesn't, the player's last game went through start_game_er. The
    // only recovery offered here is reset_stranded_v2_session — refunds
    // bet + closes the PDA — and only when the on-chain PDA is still owned
    // by the kaboom program (i.e. delegate_game never landed or the game
    // was undelegated by commit_and_undelegate but somehow stayed open).
    // A still-delegated PDA (owner == DELEGATION_PROGRAM_ID) is the
    // settle_game_er path and isn't recoverable through /api/cleanup.
    if (!info && v2Info) {
      const isDelegated = v2Info.owner.equals(DELEGATION_PROGRAM_ID);
      if (isDelegated) {
        logger.warn(
          { player: body.player, gameV2Pda: gameV2Pda.toBase58() },
          "cleanup: V2 PDA is delegated to Magicblock — out of scope for cleanup route",
        );
        return NextResponse.json({
          active: true,
          action: "v2_delegated",
          message:
            "Game is still running on Magicblock. It will auto-settle and undelegate; try again in a minute.",
        });
      }
      // Decode minimal fields to compute readyAt: start_slot lives at a
      // fixed offset in the GameSessionV2 layout (see lib.rs ~L2572) — we
      // need it to gate reset_stranded_v2_session against the 300-slot
      // expiry window the program enforces.
      // Layout: 8 disc + 32 player + 1 bump + 1 status + 8 bet + 1 mine_count
      //         + 32 commitment + 2 revealed + 2 revealed_safe + 1 safe_reveals
      //         + 8 multiplier + 8 start_slot ...
      const startSlot = Number(v2Info.data.readBigUInt64LE(8 + 32 + 1 + 1 + 8 + 1 + 32 + 2 + 2 + 1 + 8));
      const currentSlot = await conn.getSlot("confirmed");
      const readyAt = startSlot + REFUND_EXPIRED_SLOTS;
      const slotsUntilReady = Math.max(0, readyAt - currentSlot);
      const secondsUntilReady = Math.ceil(slotsUntilReady * 0.4);
      if (slotsUntilReady > 0) {
        return NextResponse.json({
          active: true,
          action: "wait_v2_reset",
          readyAt,
          secondsUntilReady,
          currentSlot,
        });
      }
      return NextResponse.json({
        active: true,
        action: "reset_stranded_v2_session",
        instruction: serializeIx(buildResetStrandedV2Session({ ctx, player: playerPk })),
        readyAt,
        secondsUntilReady: 0,
      });
    }

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
