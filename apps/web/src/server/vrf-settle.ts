import "server-only";
import type { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import {
  buildSettleVrf,
  decodePlayerStats,
  decodeReferralAccount,
  derivePlayerStatsPda,
  deriveReferralPda,
  deriveVrfGamePda,
  extractKaboomError,
  type PlayerStatsAccount,
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
    const conn = getConnection();
    const pid = programId();
    // The tx itself carries its slot, block time and the referral cut it moved.
    let tx: VersionedTransactionResponse | null = null;
    for (let i = 0; i < 5 && !tx; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1_000)); // RPC can lag the confirmation
      tx = await conn
        .getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        .catch(() => null);
    }
    if (!tx) logger.warn({ sig }, "vrf settle tx not readable: mirroring with write-time slot, no referral row");

    // Same referrer the settle was built with (F5: its PDA is in the tx when set).
    let stats: PlayerStatsAccount | null = null;
    let referral: { referrer: string; amount: bigint; tier: number } | null = null;
    try {
      const referrer = await fetchPlayerReferrer(player);
      const referralPda = referrer ? deriveReferralPda(pid, referrer)[0] : null;
      const [statsPda] = derivePlayerStatsPda(pid, player);
      const [statsInfo, referralInfo] = await conn.getMultipleAccountsInfo(
        referralPda ? [statsPda, referralPda] : [statsPda],
        "confirmed",
      );
      if (statsInfo) stats = decodePlayerStats(statsInfo.data as Buffer);
      const cut = tx && referralPda ? lamportDelta(tx, referralPda) : null;
      // Tier after the settle, as the legacy ReferralAccrued event reported it.
      if (referrer && cut !== null && referralInfo) {
        referral = { referrer: referrer.toBase58(), amount: cut, tier: decodeReferralAccount(referralInfo.data as Buffer).tier };
      }
    } catch (e) {
      logger.error({ err: e, sig }, "vrf mirror account reads failed: no stats or referral row");
    }

    const won = game.status === "Won";
    await recordVrfGame({
      signature: sig,
      gamePda: deriveVrfGamePda(pid, player)[0].toBase58(),
      player: player.toBase58(),
      betLamports: claim.bet,
      payoutLamports: won ? (claim.bet * BigInt(game.multiplierBps)) / 10_000n : 0n,
      multiplierBps: Number(game.multiplierBps),
      safeReveals: game.safeReveals,
      mineCount: claim.mineCount,
      won,
      edgeBps: claim.houseEdgeBps,
      slot: tx?.slot ?? (await conn.getSlot("confirmed").catch(() => 0)),
      blockTime: new Date((tx?.blockTime ?? Date.now() / 1000) * 1000).toISOString(),
      stats,
      referral,
    });
  } catch (e) {
    logger.error({ err: e, sig }, "vrf mirror write failed");
  }
}

/** Lamports `account` gained in `tx` (null: not one of its accounts). */
export function lamportDelta(tx: VersionedTransactionResponse, account: PublicKey): bigint | null {
  const keys = [
    ...tx.transaction.message.staticAccountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const i = keys.findIndex((k) => k.equals(account));
  const pre = tx.meta?.preBalances[i];
  const post = tx.meta?.postBalances[i];
  return i < 0 || pre === undefined || post === undefined ? null : BigInt(post) - BigInt(pre);
}
