import "server-only";
import type { PublicKey } from "@solana/web3.js";
import {
  buildSettleVrf,
  deriveReferralPda,
  deriveVrfGamePda,
  extractKaboomError,
  type VrfClaimAccount,
  type VrfGameAccount,
} from "@playkaboom/sdk";
import { getConnection } from "./connection";
import { housePubkey, programId, treasuryPubkey } from "./env";
import { bustPlayerReferrer, fetchPlayerReferrer } from "./player";
import { sendHouseTx, waitConfirmed } from "./solana";
import { recordVrfGame } from "./indexer";
import { logger } from "./logger";

/**
 * House-paid settle_vrf for one player. F5: when the player has a referrer the
 * referral PDA is mandatory (the program fails 6022 without it), so the
 * referrer read must not fail open. A 6022 means the cached referrer is stale
 * (set_referrer landed after the read): bust the cache and retry once.
 */
export async function sendSettleVrf(player: PublicKey): Promise<string> {
  const pid = programId();
  for (let attempt = 0; ; attempt++) {
    const referrer = await fetchPlayerReferrer(player);
    try {
      return await sendHouseTx([
        buildSettleVrf({
          ctx: { programId: pid },
          player,
          payer: housePubkey(),
          treasury: treasuryPubkey(),
          referralPda: referrer ? deriveReferralPda(pid, referrer)[0] : undefined,
        }),
      ]);
    } catch (e) {
      if (attempt === 0 && extractKaboomError(e) === "ReferralMismatch") {
        bustPlayerReferrer(player);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Mirror a settled VRF game into `games` once the settle is CONFIRMED (a dropped
 * tx must not produce a row or points). settle_vrf emits no event, so the
 * indexer cannot see it. Never throws.
 */
export async function mirrorVrfSettle(
  sig: string,
  player: PublicKey,
  claim: VrfClaimAccount,
  game: VrfGameAccount,
): Promise<void> {
  try {
    if (!(await waitConfirmed(sig))) {
      logger.warn({ sig }, "vrf settle not confirmed — not mirroring");
      return;
    }
    const won = game.status === "Won";
    await recordVrfGame({
      signature: sig,
      gamePda: deriveVrfGamePda(programId(), player)[0].toBase58(),
      player: player.toBase58(),
      betLamports: claim.bet,
      payoutLamports: won ? (claim.bet * BigInt(game.multiplierBps)) / 10_000n : 0n,
      multiplierBps: Number(game.multiplierBps),
      safeReveals: game.safeReveals,
      mineCount: claim.mineCount,
      won,
      slot: await getConnection().getSlot("confirmed").catch(() => 0),
      blockTime: new Date().toISOString(),
    });
  } catch (e) {
    logger.error({ err: e, sig }, "vrf mirror write failed");
  }
}
