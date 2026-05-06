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
import { decryptSession } from "@/server/session";
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
      return NextResponse.json({ active: false });
    }

    if (body.gameToken) {
      try {
        const session = decryptSession(body.gameToken);
        if (session.player === body.player) {
          await sendHouseTx([
            buildSettleGame({
              ctx,
              player: playerPk,
              houseAuthority: housePubkey(),
              mineLayout: session.mineLayout,
              salt: saltBuffer(session),
            }),
          ]);
        }
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : e }, "cleanup settle attempt failed");
      }
    }

    return NextResponse.json({
      active: true,
      closeInstruction: serializeIx(buildCloseGame({ ctx, player: playerPk })),
      refundInstruction: serializeIx(buildRefundExpired({ ctx, player: playerPk })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
