/**
 * Game-wide constants. Mirrors values in `programs/kaboom/src/lib.rs`.
 * Changing these on the client without redeploying the program will fail at the
 * tx layer (e.g. `BetTooLow`), which is the desired behavior.
 */

export const GRID_SIZE = 16;
export const GRID_COLS = 4;
export const MIN_MINES = 1;
export const MAX_MINES = 15;
export const BPS = 10_000;

export const GAME_EXPIRY_SLOTS = 300;
export const APPROX_SLOT_MS = 400;
export const GAME_EXPIRY_MS = GAME_EXPIRY_SLOTS * APPROX_SLOT_MS;

/**
 * Slot gate for `close_unsettled_game` — must match
 * `CLOSE_UNSETTLED_EXPIRY_SLOTS` in `programs/kaboom/src/lib.rs`. Was 600
 * (~4 min) and dropped to 38 (~15s) in 2026-05-16 so the server settle has
 * a short grace window while the player can recover their stuck game fast.
 *
 * If these drift the web UI tells the player to wait minutes when the
 * chain already accepts close_unsettled — exactly the 2026-05-21 mobile
 * bug. Single source of truth here.
 */
export const CLOSE_UNSETTLED_EXPIRY_SLOTS = 38;

export const MIN_BET_LAMPORTS = 1_000_000n; // 0.001 SOL

/** Mine count selector options surfaced in the UI.
 * Set [1, 3, 5, 12] picks values from both halves of the symmetric
 * Pascal-triangle multiplier curve while skipping the central peaks. New
 * bottleneck = 5 mines (4280× max) requiring ~8.6 SOL vault for a 0.001 min
 * bet — much friendlier seed than including 8 (~25 SOL) or 10 (~16 SOL).
 *
 * 15 IS WITHDRAWN AND MUST NOT BE RESTORED UNTIL THE PROGRAM IS UPGRADED.
 * A 15-mine board has exactly one safe tile, so `totalSafe` is 1 and the
 * perfect-game guard in /api/reveal (which refuses to dispatch the LAST safe
 * reveal, because the on-chain full-clear branch flips status to Won and then
 * pays nothing) fires on the FIRST reveal. The reveal never reaches the
 * chain, `safe_reveals` stays 0, and `cash_out` reverts NoTilesRevealed — so
 * a 15-mine round has no winning path at all. Its only outcomes are a mine
 * (total loss, 15/16 of the time) or an expiry refund at 1×, i.e. an expected
 * return near 6% of stake against an advertised ~98%.
 *
 * Restore it in the same change that makes the on-chain full-clear branch pay,
 * not before. `MAX_MINES` is deliberately left at 15: the program still
 * accepts that count and the multiplier fixtures still assert it, so nothing
 * about existing games or the math tests changes.
 */
export const MINE_OPTIONS = [1, 3, 5, 12] as const;

/** Default vault config the house deploys with. Mirrors program caps. */
export const DEFAULT_HOUSE_EDGE_BPS = 200; // 2.00%
export const DEFAULT_MAX_BET_BPS = 200; // 2% of vault
export const DEFAULT_MAX_PAYOUT_BPS = 5_000; // 50% of vault

export const VAULT_SEED = "kaboom_vault";
export const VAULT_V2_SEED = "kaboom_v2_state";
export const LP_SEED = "kaboom_lp";
export const GAME_SEED = "kaboom_game";
export const STATS_SEED = "kaboom_stats";
export const REFERRAL_SEED = "kaboom_referral";

/** Referral payout in bps of bet (= 25/30/35% of 2% house edge). */
export const REFERRAL_BRONZE_BPS = 50;
export const REFERRAL_SILVER_BPS = 60;
export const REFERRAL_GOLD_BPS = 70;
export const SILVER_VOLUME_LAMPORTS = 10_000_000_000n;
export const GOLD_VOLUME_LAMPORTS = 100_000_000_000n;

export const REFERRAL_TIER_LABELS = ["Bronze", "Silver", "Gold"] as const;
export type ReferralTier = 0 | 1 | 2;

export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

export const EXPLORERS: Record<SolanaCluster, (sig: string) => string> = {
  "mainnet-beta": (sig) => `https://solscan.io/tx/${sig}`,
  devnet: (sig) => `https://solscan.io/tx/${sig}?cluster=devnet`,
  testnet: (sig) => `https://solscan.io/tx/${sig}?cluster=testnet`,
  localnet: (sig) => `https://solscan.io/tx/${sig}?cluster=custom`,
};

export const ACCOUNT_EXPLORERS: Record<SolanaCluster, (addr: string) => string> = {
  "mainnet-beta": (a) => `https://solscan.io/account/${a}`,
  devnet: (a) => `https://solscan.io/account/${a}?cluster=devnet`,
  testnet: (a) => `https://solscan.io/account/${a}?cluster=testnet`,
  localnet: (a) => `https://solscan.io/account/${a}?cluster=custom`,
};
