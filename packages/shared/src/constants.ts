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

/** Mine count selector options surfaced in the UI. */
export const MINE_OPTIONS = [1, 3, 5, 8, 10, 12] as const;

/** Default vault config the house deploys with. Mirrors program caps. */
export const DEFAULT_HOUSE_EDGE_BPS = 200; // 2.00%
export const DEFAULT_MAX_BET_BPS = 200; // 2% of vault
export const DEFAULT_MAX_PAYOUT_BPS = 5_000; // 50% of vault

export const VAULT_SEED = "kaboom_vault";
export const GAME_SEED = "kaboom_game";

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
