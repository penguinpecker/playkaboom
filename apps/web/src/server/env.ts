import "server-only";
/**
 * Server-only env. Validated lazily so unrelated routes don't crash the
 * deployment when one var is missing. Each accessor throws with a clear
 * message at first call instead.
 */
import { PublicKey } from "@solana/web3.js";
import { KABOOM_PROGRAM_ID } from "@playkaboom/shared";
import { getHouseSigner } from "./house-signer";

/** The house signer's public key (= vault.house_authority on chain). */
export function housePubkey(): PublicKey {
  return getHouseSigner().publicKey;
}

let cachedTreasuryPubkey: PublicKey | null = null;
/**
 * Treasury account that receives the 50/50 profit-split lamports per
 * settle_game. Must equal the `vault.treasury` field on-chain (program
 * constraint enforces it). Set via TREASURY_PUBKEY env var.
 */
export function treasuryPubkey(): PublicKey {
  if (cachedTreasuryPubkey) return cachedTreasuryPubkey;
  const raw = process.env.TREASURY_PUBKEY;
  if (!raw) throw new Error("TREASURY_PUBKEY is not set");
  cachedTreasuryPubkey = new PublicKey(raw);
  return cachedTreasuryPubkey;
}

let cachedSessionKey: Buffer | null = null;
export function sessionEncKey(): Buffer {
  if (cachedSessionKey) return cachedSessionKey;
  const raw = process.env.SESSION_ENC_KEY;
  if (!raw) {
    throw new Error(
      "SESSION_ENC_KEY is not set. Generate one with: openssl rand -hex 32",
    );
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error("SESSION_ENC_KEY must decode to exactly 32 bytes");
  }
  cachedSessionKey = buf;
  return cachedSessionKey;
}

let cachedProgramId: PublicKey | null = null;
export function programId(): PublicKey {
  if (cachedProgramId) return cachedProgramId;
  // Defaults to the relaunch program; any other value is a stale config (the
  // old 9Xip2L... program is closed), so refuse it instead of sending to it.
  const raw = process.env.PROGRAM_ID || KABOOM_PROGRAM_ID;
  if (raw !== KABOOM_PROGRAM_ID) throw new Error(`PROGRAM_ID must be ${KABOOM_PROGRAM_ID} (or unset)`);
  cachedProgramId = new PublicKey(raw);
  return cachedProgramId;
}

/** Mainnet RPC. No default: a silent devnet fallback would point the house at the wrong chain. */
export function solanaRpc(): string {
  const url = process.env.SOLANA_RPC;
  if (!url) throw new Error("SOLANA_RPC is not set");
  return url;
}

/**
 * MagicBlock ER endpoint for house-signed rollup txs (F3 force pass). Must name
 * the same node as v2_state.vrf_validator (MAS1Dt9q... = https://as.magicblock.app/),
 * so there is deliberately no default. ER_RPC wins; NEXT_PUBLIC_ER_RPC (the
 * browser's value) is the fallback so one setting serves both.
 */
export function erRpc(): string {
  const url = process.env.ER_RPC || process.env.NEXT_PUBLIC_ER_RPC;
  if (!url) throw new Error("ER_RPC (or NEXT_PUBLIC_ER_RPC) is not set");
  return url;
}

/**
 * SERVER-side kill switch for the VRF game mode.
 *
 * VRF is the only mode, but this still gates the money routes (/api/vrf/*)
 * and the cron's VRF passes, and flips without a redeploy. Defaults to OFF:
 * the mode must be switched on explicitly, never by omission.
 */
export function vrfModeEnabled(): boolean {
  return process.env.VRF_MODE_ENABLED === "true";
}

export function logLevel(): string {
  return process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
}
