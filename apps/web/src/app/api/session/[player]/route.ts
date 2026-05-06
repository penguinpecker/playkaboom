import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { decodeGameSession, deriveGamePda } from "@playkaboom/sdk";
import { jsonError } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { getConnection } from "@/server/connection";
import { loadSession } from "@/server/session-store";
import { encryptSession } from "@/server/session";
import { programId } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ player: string }>;
}

/**
 * Resume an in-flight game from any device. Returns:
 *   - active: false               → no on-chain GameSession; player is free to start a new game
 *   - active: true, gameToken     → server has the encrypted session; client can continue revealing
 *   - active: true, gameToken null → on-chain session exists but server-side mirror missing
 *                                     (older game from before session-mirror landed, or row pruned).
 *                                     UX should offer refund_expired after the cooldown.
 *
 * Authed: only the wallet's owner can resume.
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { player } = await ctx.params;
    let pk: PublicKey;
    try {
      pk = new PublicKey(player);
    } catch {
      return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
    }
    await verifyPlayerAuth(req, player);

    const conn = getConnection();
    const [gamePda] = deriveGamePda(programId(), pk);
    const info = await conn.getAccountInfo(gamePda, "confirmed");
    if (!info) {
      return NextResponse.json({ active: false });
    }
    const game = decodeGameSession(info.data);
    const session = await loadSession(player);
    return NextResponse.json({
      active: true,
      gameToken: session ? encryptSession(session) : null,
      onChain: {
        bet: game.bet.toString(),
        mineCount: game.mineCount,
        revealedMask: game.revealedMask,
        revealedSafeMask: game.revealedSafeMask,
        safeReveals: game.safeReveals,
        multiplierBps: game.multiplierBps.toString(),
        startSlot: game.startSlot.toString(),
        status: game.status,
        commitment: game.commitment.toString("hex"),
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
