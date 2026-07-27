import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { buildRefundStalledVrf, deriveVrfClaimPda, decodeVrfClaim } from "@playkaboom/sdk";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { getConnection } from "@/server/connection";
import { sendHouseTx } from "@/server/solana";
import { housePubkey, programId, vrfModeEnabled } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { indexFreshSignature } from "@/server/inline-ingest";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Input = z.object({ player: z.string() });

// The house relays refund_stalled_vrf (and pays the fee) as an authorised
// caller — the instruction now requires a signer that is either the player or
// the house authority, so it can no longer be used to cancel someone else's
// game. Safety does NOT come from anything checked here: on-chain the refund
// only succeeds once the reveal PDA is back under program ownership, i.e. its
// L1 state is final. While a game is delegated its L1 copy is stale by design,
// which is precisely how a lost game could previously be refunded.
export async function POST(req: NextRequest) {
  try {
    if (!vrfModeEnabled()) throw new ApiError(403, "VRF mode is disabled");
    const body = await parseBody(req, Input);
    const [, rl] = await Promise.all([
      verifyPlayerAuth(req, body.player),
      enforceRateLimit(`vrf-refund:${clientIp(req)}:${body.player}`),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    const player = new PublicKey(body.player);
    const [claimPda] = deriveVrfClaimPda(programId(), player);
    const claimInfo = await getConnection().getAccountInfo(claimPda, "confirmed");
    if (!claimInfo) throw new ApiError(404, "No VRF game to refund");
    const claim = decodeVrfClaim(claimInfo.data as Buffer);
    if (claim.settled) throw new ApiError(409, "Game already settled");

    const sig = await sendHouseTx([
      buildRefundStalledVrf({ ctx: { programId: programId() }, player, caller: housePubkey() }),
    ]);
    logger.info({ player: body.player, sig }, "vrf refund");
    void indexFreshSignature(sig);
    return NextResponse.json({ signature: sig });
  } catch (err) {
    return jsonError(err);
  }
}
