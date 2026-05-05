import "server-only";
/**
 * Server-only env. Validated lazily so unrelated routes don't crash the
 * deployment when one var is missing. Each accessor throws with a clear
 * message at first call instead.
 */
import { Keypair, PublicKey } from "@solana/web3.js";

let cachedHouseKey: Keypair | null = null;
export function houseAuthority(): Keypair {
  if (cachedHouseKey) return cachedHouseKey;
  const raw = process.env.HOUSE_AUTHORITY_KEY;
  if (!raw) throw new Error("HOUSE_AUTHORITY_KEY is not set");
  let secret: number[];
  try {
    secret = JSON.parse(raw);
  } catch {
    throw new Error("HOUSE_AUTHORITY_KEY must be a JSON byte array");
  }
  if (!Array.isArray(secret) || secret.length !== 64) {
    throw new Error("HOUSE_AUTHORITY_KEY must be 64 bytes");
  }
  cachedHouseKey = Keypair.fromSecretKey(Uint8Array.from(secret));
  return cachedHouseKey;
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
  const raw = process.env.PROGRAM_ID;
  if (!raw) throw new Error("PROGRAM_ID is not set");
  cachedProgramId = new PublicKey(raw);
  return cachedProgramId;
}

export function solanaRpc(): string {
  return process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
}

export function logLevel(): string {
  return process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
}
