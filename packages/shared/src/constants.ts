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

export const MIN_BET_LAMPORTS = 1_000_000n; // 0.001 SOL

/** Mine count selector options surfaced in the UI.
 * Final set [1, 3, 5, 12, 15] picks values from both halves of the symmetric
 * Pascal-triangle multiplier curve while skipping the central peaks. New
 * bottleneck = 5 mines (4280× max) requiring ~8.6 SOL vault for a 0.001 min
 * bet — much friendlier seed than including 8 (~25 SOL) or 10 (~16 SOL).
 * 15 mines mirrors 1 mine's multiplier (15.68×) but as a high-variance
 * single-reveal mode (1 safe tile out of 16).
 */
export const MINE_OPTIONS = [1, 3, 5, 12, 15] as const;

/** Default vault config the house deploys with. Mirrors program caps. */
export const DEFAULT_HOUSE_EDGE_BPS = 200; // 2.00%
export const DEFAULT_MAX_BET_BPS = 200; // 2% of vault
export const DEFAULT_MAX_PAYOUT_BPS = 5_000; // 50% of vault

export const VAULT_SEED = "kaboom_vault";
export const VAULT_V2_SEED = "kaboom_v2_state";
export const LP_SEED = "kaboom_lp";
export const GAME_SEED = "kaboom_game";
/** Magicblock ER GameSessionV2 PDA seed — mirrors GAME_V2_SEED in the
 * Anchor program. Distinct from GAME_SEED so the L1 and ER paths can
 * coexist for a single player. */
export const GAME_V2_SEED = "game_v2";
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
