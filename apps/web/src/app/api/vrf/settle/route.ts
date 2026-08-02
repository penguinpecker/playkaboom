import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import {
  buildSettleVrf,
  deriveVrfGamePda,
  deriveVrfClaimPda,
  deriveReferralPda,
  decodeVrfGame,
  decodeVrfClaim,
} from "@playkaboom/sdk";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { getConnection } from "@/server/connection";
import { sendHouseTx } from "@/server/solana";
import { housePubkey, programId, treasuryPubkey, vrfModeEnabled } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { fetchPlayerReferrer } from "@/server/player";
import { indexFreshSignature } from "@/server/inline-ingest";
import { recordVrfGame } from "@/server/indexer";
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

    // Referral rakeback (same source as commit-reveal settle).
    const referrer = await fetchPlayerReferrer(player);
    const referralPda = referrer ? deriveReferralPda(pid, referrer)[0] : undefined;

    const sig = await sendHouseTx([
      buildSettleVrf({
        ctx: { programId: pid },
        player,
        payer: housePubkey(),
        treasury: treasuryPubkey(),
        referralPda,
      }),
    ]);
    logger.info({ player: body.player, sig, status: game.status }, "vrf settle");
    void indexFreshSignature(sig);

    // Mirror the result ourselves. settle_vrf emits no Anchor event, so the
    // event-driven indexer above will find nothing in this transaction and the
    // activity feed would simply never show VRF games. Everything needed is
    // already decoded here. Non-blocking and non-fatal: a mirror failure must
    // never fail a settle that already moved money on chain.
    const won = game.status === "Won";
    // WAIT FOR THE SETTLE TO ACTUALLY LAND before mirroring it.
    //
    // sendHouseTx returns a signature without confirming, so a dropped
    // transaction still produced a `games` row AND an XP credit for a payout
    // that never happened — the mirror asserting money moved when it did not.
    // Kept off the response path, so latency is unchanged.
    void (async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
        if (st?.err) {
          logger.error({ sig }, "vrf settle FAILED on chain — not mirroring");
          return;
        }
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
        if (Date.now() > deadline) {
          logger.warn({ sig }, "vrf settle unconfirmed after 30s — not mirroring");
          return;
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      await recordVrfGame({
      signature: sig,
      gamePda: gamePda.toBase58(),
      player: body.player,
      betLamports: claim.bet,
      payoutLamports: won ? (claim.bet * BigInt(game.multiplierBps)) / 10_000n : 0n,
      multiplierBps: Number(game.multiplierBps),
      safeReveals: game.safeReveals,
      mineCount: claim.mineCount,
      won,
      slot: await conn.getSlot("confirmed").catch(() => 0),
      blockTime: new Date().toISOString(),
      }).catch((e) => logger.error({ err: e, sig }, "vrf mirror write failed"));
    })();

    return NextResponse.json({ signature: sig, status: game.status });
  } catch (err) {
    return jsonError(err);
  }
}
