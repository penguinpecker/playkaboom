/**
 * Game-wide constants. Mirrors values in `programs/kaboom/src/lib.rs`.
 * Changing these on the client without redeploying the program will fail at the
 * tx layer (e.g. `BetTooLow`), which is the desired behavior.
 */

export const GRID_SIZE = 16;
export const GRID_COLS = 4;
export const MIN_MINES = 1;
export const MAX_MINES = 12;
export const BPS = 10_000;

export const GAME_EXPIRY_SLOTS = 300;
export const APPROX_SLOT_MS = 400;
export const GAME_EXPIRY_MS = GAME_EXPIRY_SLOTS * APPROX_SLOT_MS;

export const MIN_BET_LAMPORTS = 1_000_000n; // 0.001 SOL

/** Mine count selector options surfaced in the UI.
 * 8 removed: C(16,8)=12870 is the central peak, would require ~25 SOL vault
 * to underwrite a 0.001 min-bet. With 1/3/5/10/12 the bottleneck shifts to
 * 10 mines (8008× max), which only needs ~16 SOL — friendlier seed for
 * mainnet bring-up. The on-chain program still allows 1..=12 (MIN_MINES /
 * MAX_MINES unchanged); this only affects the UI selector.
 */
export const MINE_OPTIONS = [1, 3, 5, 10, 12] as const;

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
