import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCloseGame,
  buildRefundExpired,
  buildSettleGame,
  deriveGamePda,
  serializeIx,
} from "@playkaboom/sdk";
import { CleanupInput } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { saltBuffer } from "@/server/game";
import { loadSession, deleteSession } from "@/server/session-store";
import { sendHouseTx } from "@/server/solana";
import { getConnection } from "@/server/connection";
import { housePubkey, programId } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, CleanupInput);

    await verifyPlayerAuth(req, body.player);

    const rl = await enforceRateLimit(`cleanup:${clientIp(req)}:${body.player}`);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    const playerPk = new PublicKey(body.player);
    const ctx = { programId: programId() };
    const [gamePda] = deriveGamePda(ctx.programId, playerPk);
    const info = await getConnection().getAccountInfo(gamePda, "confirmed");
    if (!info) {
      // Game closed on-chain; clear any stale server-side session.
      await deleteSession(body.player);
      return NextResponse.json({ active: false });
    }

    // Try to recover the session from client OR server-side mirror.
    let recoveredToken: string | null = null;
    try {
      const session = await loadSession(body.player, body.gameToken);
      if (session && session.player === body.player) {
        // We have a session — try to settle the game first (commit-reveal proof).
        // This is the happy path when the player still wants to recover; if it
        // fails (e.g. game state mismatch), we fall through to offer refund ix.
        try {
          await sendHouseTx([
            buildSettleGame({
              ctx,
              player: playerPk,
              houseAuthority: housePubkey(),
              mineLayout: session.mineLayout,
              salt: saltBuffer(session),
            }),
          ]);
        } catch (settleErr) {
          logger.warn(
            { err: settleErr instanceof Error ? settleErr.message : settleErr },
            "cleanup settle attempt failed",
          );
        }
        // Re-issue the token so the client can resume revealing if appropriate.
        recoveredToken = body.gameToken ?? null;
      }
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : e }, "cleanup recovery failed");
    }

    return NextResponse.json({
      active: true,
      closeInstruction: serializeIx(buildCloseGame({ ctx, player: playerPk })),
      refundInstruction: serializeIx(buildRefundExpired({ ctx, player: playerPk })),
      recoveredGameToken: recoveredToken,
    });
  } catch (err) {
    return jsonError(err);
  }
}
