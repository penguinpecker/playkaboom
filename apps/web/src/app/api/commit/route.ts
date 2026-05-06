import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { StartGameInput } from "@playkaboom/shared";
import { buildStartGame, serializeIx } from "@playkaboom/sdk";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { createGameSession } from "@/server/game";
import { saveSession } from "@/server/session-store";
import { playerHasActiveGame } from "@/server/solana";
import { programId } from "@/server/env";
import { getConnection } from "@/server/connection";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, StartGameInput);

    // Verify the requester actually owns the wallet they're playing as.
    await verifyPlayerAuth(req, body.player);

    const rl = await enforceRateLimit(`commit:${clientIp(req)}:${body.player}`);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    const playerPk = new PublicKey(body.player);

    if (await playerHasActiveGame(playerPk)) {
      throw new ApiError(409, "Active game exists. Close it first.", { needsCleanup: true });
    }

    const { payload, commitment } = createGameSession(body.player, body.mineCount);
    const ix = buildStartGame({
      ctx: { programId: programId() },
      player: playerPk,
      mineCount: body.mineCount,
      betLamports: BigInt(body.betLamports),
      commitment,
    });
    // Mirror the encrypted session to Supabase keyed by GameSession PDA so
    // the player can recover from any device. Function returns the same
    // ciphertext we'd have produced with encryptSession alone.
    const slot = await getConnection().getSlot("confirmed");
    const gameToken = await saveSession(body.player, payload, slot, {
      betLamports: BigInt(body.betLamports),
      mineCount: body.mineCount,
      startSlot: slot,
    });

    logger.info(
      { player: body.player, mineCount: body.mineCount, bet: body.betLamports.toString() },
      "commit",
    );

    return NextResponse.json({
      commitment: commitment.toString("hex"),
      instruction: serializeIx(ix),
      gameToken,
    });
  } catch (err) {
    return jsonError(err);
  }
}
