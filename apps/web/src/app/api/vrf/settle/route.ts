import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import {
  deriveVrfGamePda,
  deriveVrfClaimPda,
  decodeVrfGame,
  decodeVrfClaim,
} from "@playkaboom/sdk";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { getConnection } from "@/server/connection";
import { programId, vrfModeEnabled } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { indexFreshSignature } from "@/server/inline-ingest";
import { mirrorVrfSettle, sendSettleVrf } from "@/server/vrf-settle";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Input = z.object({ player: z.string() });

// settle_vrf is permissionless (payer signs, funds go to the recorded player).
// The house drives it so the player needs no closing popup and wins auto-pay
// after the ER commits the game back to L1.
export async function POST(req: NextRequest) {
  try {
    if (!vrfModeEnabled()) throw new ApiError(403, "VRF mode is disabled");
    const body = await parseBody(req, Input);
    const [, rl] = await Promise.all([
      verifyPlayerAuth(req, body.player),
      enforceRateLimit(`vrf-settle:${clientIp(req)}:${body.player}`),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    const player = new PublicKey(body.player);
    const conn = getConnection();
    const pid = programId();

    const [claimPda] = deriveVrfClaimPda(pid, player);
    const [gamePda] = deriveVrfGamePda(pid, player);
    const [claimInfo, gameInfo] = await Promise.all([
      conn.getAccountInfo(claimPda, "confirmed"),
      conn.getAccountInfo(gamePda, "confirmed"),
    ]);
    if (!claimInfo || !gameInfo) throw new ApiError(404, "No VRF game to settle");
    const claim = decodeVrfClaim(claimInfo.data as Buffer);
    if (claim.settled) throw new ApiError(409, "Game already settled");
    const game = decodeVrfGame(gameInfo.data as Buffer);
    if (game.status === "Playing") {
      // Not yet committed/undelegated with a terminal status — caller should
      // finish settle_and_undelegate_vrf and retry.
      throw new ApiError(409, "Game not finished yet", { retry: true });
    }
    if (game.status === "Void") {
      // F3: closed for inactivity with no progress. Nothing to settle; the bet
      // is refunded (by /api/vrf/refund or the house cron).
      throw new ApiError(409, "Round closed for inactivity — refund instead", { refund: true });
    }

    // F5: the referral PDA is mandatory for a referred player (sendSettleVrf).
    const sig = await sendSettleVrf(player);
    logger.info({ player: body.player, sig, status: game.status }, "vrf settle");
    void indexFreshSignature(sig);
    // Mirror off the response path, only after the settle confirms.
    void mirrorVrfSettle(sig, player, claim, game);

    return NextResponse.json({ signature: sig, status: game.status });
  } catch (err) {
    return jsonError(err);
  }
}
