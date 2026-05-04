import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildCashOut, buildSettleGame, serializeIx } from "@playkaboom/sdk";
import { SettleInput } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { saltBuffer } from "@/server/game";
import { decryptSession } from "@/server/session";
import { sendHouseTx } from "@/server/solana";
import { houseAuthority, programId } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, SettleInput);

    const rl = await enforceRateLimit(`settle:${clientIp(req)}:${body.player}`);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    const session = decryptSession(body.gameToken);
    if (session.player !== body.player) {
      throw new ApiError(403, "Player mismatch");
    }

    const playerPk = new PublicKey(body.player);
    const ctx = { programId: programId() };

    if (body.phase === "settle") {
      const sig = await sendHouseTx([
        buildSettleGame({
          ctx,
          player: playerPk,
          houseAuthority: houseAuthority().publicKey,
          mineLayout: session.mineLayout,
          salt: saltBuffer(session),
        }),
      ]);
      logger.info({ player: body.player, sig }, "settle");
      return NextResponse.json({ signature: sig, mineLayout: session.mineLayout, verified: true });
    }

    // Phase 1: hand the player their cash_out instruction to sign.
    const ix = buildCashOut({ ctx, player: playerPk });
    return NextResponse.json({ phase: "cashout", instruction: serializeIx(ix) });
  } catch (err) {
    return jsonError(err);
  }
}
