/**
 * Public chain config the UI reads. Mirrors `programs/kaboom/src/lib.rs`
 * constants. Server-side env lives in `src/server/env.ts` instead.
 */
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { GRID_SIZE, MINE_OPTIONS } from "@playkaboom/shared";
import { deriveV2StatePda, deriveVaultPda, deriveGamePda } from "@playkaboom/sdk";
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
  // Owner decision 2026-11-05: 0.01 SOL. The program still accepts 0.001
  // (MIN_BET_LAMPORTS), but MagicBlock keeps ~0.003 SOL per round, so the
  // UI floor keeps that fee at ~30% of the smallest bet instead of 300%.
  MIN_BET_SOL: 0.01,
  BPS_DENOMINATOR: 10_000,
  GAME_EXPIRY_SLOTS: 300,
} as const;

export const [VAULT_PDA] = deriveVaultPda(PROGRAM_ID);
export const [V2_STATE_PDA] = deriveV2StatePda(PROGRAM_ID);
export { deriveGamePda as getGamePda };

/** Operator-authority addresses surfaced in `/vault`. The house signer is
 *  not listed here: the page reads it from chain (vault.house_authority via
 *  /api/vault/state). Squads vault: FLAG for the lead, confirm it is still
 *  the intended owner/treasury after the relaunch. */
const SQUADS_VAULT_MAINNET = "464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5";
const SQUADS_VAULT_DEVNET = "At5oBj3KtiTBRkkquZTL1ceY2KDtz1KckLTuaQFbJjVh";

const SQUADS_VAULT = CLUSTER === "mainnet-beta" ? SQUADS_VAULT_MAINNET : SQUADS_VAULT_DEVNET;

export const CONTRACTS: Record<string, string> = {
  KaboomProgram: PROGRAM_ID.toBase58(),
  "Squads multisig (2-of-2)": SQUADS_VAULT,
};
