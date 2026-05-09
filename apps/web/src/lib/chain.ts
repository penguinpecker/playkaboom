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
  MIN_BET_SOL: 0.001,
  BPS_DENOMINATOR: 10_000,
  GAME_EXPIRY_SLOTS: 300,
} as const;

export const [VAULT_PDA] = deriveVaultPda(PROGRAM_ID);
export const [V2_STATE_PDA] = deriveV2StatePda(PROGRAM_ID);
export { deriveGamePda as getGamePda };

/** Operator-authority addresses surfaced in `/vault`. Cluster-switched so
 *  the live mainnet site shows mainnet addresses, devnet still shows the
 *  devnet Squads + Turnkey anchors used during pre-launch testing. */
const SQUADS_VAULT_MAINNET = "464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5";
const TURNKEY_HOUSE_AUTHORITY_MAINNET = "7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp";
const SQUADS_VAULT_DEVNET = "At5oBj3KtiTBRkkquZTL1ceY2KDtz1KckLTuaQFbJjVh";
const TURNKEY_HOUSE_AUTHORITY_DEVNET = "3TCMevgUMRU86Q96dj2mLELjsTAsZyvUp7Pecr8dQKWL";

const SQUADS_VAULT = CLUSTER === "mainnet-beta" ? SQUADS_VAULT_MAINNET : SQUADS_VAULT_DEVNET;
const TURNKEY_HOUSE_AUTHORITY =
  CLUSTER === "mainnet-beta" ? TURNKEY_HOUSE_AUTHORITY_MAINNET : TURNKEY_HOUSE_AUTHORITY_DEVNET;

export const CONTRACTS: Record<string, string> = {
  KaboomProgram: PROGRAM_ID.toBase58(),
  "Squads multisig (2-of-2)": SQUADS_VAULT,
  "Turnkey HSM (house signer)": TURNKEY_HOUSE_AUTHORITY,
};
