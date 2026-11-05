/**
 * Lamports a VRF start needs in the wallet ON TOP OF THE BET.
 *
 * Starting a game is ONE atomic transaction, so all of it must be affordable at
 * the same instant. MEASURED from the player's balance delta on real mainnet
 * starts (2026-11-05 QA run, 6 games), not estimated:
 *
 *   VrfClaim rent            1,000,760
 *   VrfGame rent             3,804,920
 *   session key funding      2,000,000
 *   delegation record        1,559,040
 *   delegation metadata      1,642,560
 *   tx fee                       5,000
 *   ───────────────────────────────────
 *   every start             10,012,280
 *
 * plus two one-off accounts the same transaction creates:
 *
 *   PlayerStats rent         1,681,480   the player's first game
 *   ReferralAccount rent     1,173,480   set_referrer, when the referrer has none yet
 *
 * A referred newcomer therefore needs 12,867,240. The old single constant
 * (11,795,760, from older rent rates) let that player through and the start
 * failed on chain.
 *
 * ponytail: fixed lamports; rent moved once already (6,960 -> 5,080 per byte).
 * If it rises, re-measure (scripts/qa) or read getMinimumBalanceForRentExemption.
 */
export const VRF_START_BASE_LAMPORTS = 10_012_280;
export const PLAYER_STATS_RENT_LAMPORTS = 1_681_480;
export const REFERRAL_ACCOUNT_RENT_LAMPORTS = 1_173_480;

export function vrfStartOverheadLamports(o: {
  /** PlayerStats PDA exists (false while unknown: errs high). */
  statsExists: boolean;
  /** The start will bundle set_referrer AND the referrer's ReferralAccount does not exist yet. */
  createsReferralAccount: boolean;
}): number {
  return (
    VRF_START_BASE_LAMPORTS +
    (o.statsExists ? 0 : PLAYER_STATS_RENT_LAMPORTS) +
    (o.createsReferralAccount ? REFERRAL_ACCOUNT_RENT_LAMPORTS : 0)
  );
}
