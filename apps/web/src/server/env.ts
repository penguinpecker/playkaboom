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

export function useTurnkey(): boolean {
  return (process.env.USE_TURNKEY ?? "").toLowerCase() === "true";
}

let cachedHousePubkey: PublicKey | null = null;
export function housePubkey(): PublicKey {
  if (cachedHousePubkey) return cachedHousePubkey;
  if (useTurnkey()) {
    const raw = process.env.TURNKEY_HOUSE_PUBKEY;
    if (!raw) throw new Error("TURNKEY_HOUSE_PUBKEY is not set");
    cachedHousePubkey = new PublicKey(raw);
  } else {
    cachedHousePubkey = houseAuthority().publicKey;
  }
  return cachedHousePubkey;
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

export interface TurnkeyConfig {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  housePubkey: string;
}

let cachedTurnkeyConfig: TurnkeyConfig | null = null;
export function turnkeyConfig(): TurnkeyConfig {
  if (cachedTurnkeyConfig) return cachedTurnkeyConfig;
  const organizationId = process.env.TURNKEY_ORG_ID;
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  const housePubkey = process.env.TURNKEY_HOUSE_PUBKEY;
  if (!organizationId) throw new Error("TURNKEY_ORG_ID is not set");
  if (!apiPublicKey) throw new Error("TURNKEY_API_PUBLIC_KEY is not set");
  if (!apiPrivateKey) throw new Error("TURNKEY_API_PRIVATE_KEY is not set");
  if (!housePubkey) throw new Error("TURNKEY_HOUSE_PUBKEY is not set");
  cachedTurnkeyConfig = { organizationId, apiPublicKey, apiPrivateKey, housePubkey };
  return cachedTurnkeyConfig;
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

// ── Magicblock Ephemeral Rollup feature flags ────────────────────────────────
// Default OFF. Existing L1 + Turnkey path keeps running unchanged when
// MAGICBLOCK_ENABLED !== 'true'. The ER endpoints default to the Asia public
// node which is closest to our user base.
//
// Per-wallet canary: when MAGICBLOCK_CANARY_WALLETS is set to a non-empty
// comma-separated list of base58 pubkeys, only those wallets get routed
// through the ER path even though the global flag is on. Empty (or unset) =
// route everyone. Lets us flip MAGICBLOCK_ENABLED=true on production but
// keep the blast radius to a single tester until we're confident.
//
// Operational note: don't remove a wallet from the canary list while it has
// an in-flight game — that would strand the game between ER commit and
// classic reveal. Wait for in-flight games to settle before tightening.
function canarySet(): Set<string> {
  const raw = (process.env.MAGICBLOCK_CANARY_WALLETS ?? "").trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export function useMagicblock(player?: string): boolean {
  if ((process.env.MAGICBLOCK_ENABLED ?? "").toLowerCase() !== "true") return false;
  const allow = canarySet();
  if (allow.size === 0) return true;
  if (!player) return false;
  return allow.has(player);
}

export function magicblockErUrl(): string {
  return process.env.MAGICBLOCK_ER_URL ?? "https://as.magicblock.app/";
}

export function magicblockErWsUrl(): string {
  return process.env.MAGICBLOCK_ER_WS_URL ?? "wss://as.magicblock.app/";
}
