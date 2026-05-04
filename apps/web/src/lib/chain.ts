/**
 * Public chain config the UI reads. Mirrors `programs/kaboom/src/lib.rs`
 * constants. Server-side env lives in `src/server/env.ts` instead.
 */
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { GRID_SIZE, MINE_OPTIONS } from "@playkaboom/shared";
import { deriveVaultPda, deriveGamePda } from "@playkaboom/sdk";
import { PROGRAM_ID, CLUSTER, RPC_URL } from "./cluster";

export { PROGRAM_ID, CLUSTER, RPC_URL };
export { LAMPORTS_PER_SOL };

export const GAME_CONFIG = {
  GRID_SIZE,
  GRID_COLS: 4,
  HOUSE_EDGE: 0.02,
  MIN_MINES: 1,
  MAX_MINES: 12,
  MINE_OPTIONS,
  MAX_BET_PERCENT: 0.02,
  MAX_PAYOUT_PERCENT: 0.5,
  MIN_BET_SOL: 0.001,
  BPS_DENOMINATOR: 10_000,
  GAME_EXPIRY_SLOTS: 300,
} as const;

export const [VAULT_PDA] = deriveVaultPda(PROGRAM_ID);
export { deriveGamePda as getGamePda };

export const CONTRACTS: Record<string, string> = {
  KaboomProgram: PROGRAM_ID.toBase58(),
  Vault: VAULT_PDA.toBase58(),
};
