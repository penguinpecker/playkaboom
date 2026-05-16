import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { sessionEncKey } from "./env";
import { supabaseAdmin } from "./db/supabase";
import { logger } from "./logger";

/**
 * Per-game ephemeral session-key management.
 *
 * Magicblock's ER lets us sign tile reveals without touching Turnkey on the
 * hot path: when a game starts we generate a fresh ed25519 keypair, record
 * its pubkey in the on-chain GameSession (via start_game_er) so the program
 * accepts it as the signer for reveal_tile_er, and persist the encrypted
 * secret server-side keyed by GameSession PDA. The session key is throwaway
 * — one game's worth of authority, deleted at settle.
 *
 * Encryption: AES-256-GCM with SESSION_ENC_KEY, same primitive as
 * session.ts. Stored as `bytea` in Supabase — payload layout matches
 * encryptSessionKey/decryptSessionKey below (12B iv | 16B tag | 64B ct).
 */

const VERSION = 1;

/** Generate a fresh ed25519 keypair for a single game. */
export function generateGameSessionKey(): { publicKey: PublicKey; secretKey: Uint8Array } {
  const kp = Keypair.generate();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * Encrypt a 64-byte ed25519 secret using SESSION_ENC_KEY (AES-256-GCM).
 * Layout: [1B version][12B iv][16B auth tag][ciphertext].
 */
function encryptSecret(secret: Uint8Array): Buffer {
  if (secret.length !== 64) throw new Error("session secret must be 64 bytes");
  const key = sessionEncKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

function decryptSecret(blob: Buffer): Uint8Array {
  if (blob.length < 1 + 12 + 16 + 1) throw new Error("session-key blob truncated");
  const version = blob[0];
  if (version !== VERSION) throw new Error(`unknown session-key version ${version}`);
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const ct = blob.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", sessionEncKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  if (pt.length !== 64) throw new Error("decrypted session secret has unexpected length");
  return new Uint8Array(pt);
}

/**
 * Persist the encrypted secret keyed by GameSession PDA. The pubkey side of
 * the keypair is on-chain in the GameSession PDA already; we only need to
 * stash the secret. Idempotent upsert so callers can retry safely.
 */
export async function storeSessionKey(gamePda: PublicKey, secretKey: Uint8Array): Promise<void> {
  const ciphertext = encryptSecret(secretKey);
  const { error } = await supabaseAdmin()
    .from("game_session_keys")
    .upsert(
      {
        game_pda: gamePda.toBase58(),
        encrypted_secret: ciphertext,
      },
      { onConflict: "game_pda" },
    );
  if (error) {
    logger.error({ err: error.message, gamePda: gamePda.toBase58() }, "storeSessionKey failed");
    throw new Error(`storeSessionKey: ${error.message}`);
  }
}

/** Fetch + decrypt. Throws if missing or corrupt. */
export async function loadSessionKey(gamePda: PublicKey): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin()
    .from("game_session_keys")
    .select("encrypted_secret")
    .eq("game_pda", gamePda.toBase58())
    .maybeSingle();
  if (error) throw new Error(`loadSessionKey: ${error.message}`);
  if (!data) throw new Error(`loadSessionKey: no row for ${gamePda.toBase58()}`);
  // Supabase returns bytea as either Buffer (node-postgres path) or base64
  // string depending on transport. Normalize.
  const raw = data.encrypted_secret as Buffer | Uint8Array | string;
  const blob =
    typeof raw === "string"
      ? Buffer.from(raw.startsWith("\\x") ? raw.slice(2) : raw, raw.startsWith("\\x") ? "hex" : "base64")
      : Buffer.from(raw);
  return decryptSecret(blob);
}

/**
 * Returns true if delegate_game has landed for this game (server-side
 * cache; the on-chain owner of the GameSessionV2 PDA is the source of
 * truth but we avoid that extra RPC on every reveal).
 *
 * Returns false if either the row is missing OR delegated_at is NULL.
 * Missing-row is treated as not-delegated rather than an error because
 * the caller will fail on the subsequent storeSessionKey/loadSessionKey
 * call anyway, with a clearer error.
 */
export async function isDelegated(gamePda: PublicKey): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("game_session_keys")
    .select("delegated_at")
    .eq("game_pda", gamePda.toBase58())
    .maybeSingle();
  if (error) {
    logger.warn(
      { err: error.message, gamePda: gamePda.toBase58() },
      "isDelegated read failed — treating as not-delegated",
    );
    return false;
  }
  return data?.delegated_at != null;
}

/**
 * Atomically claim the delegation slot. Returns true iff this caller
 * was the one to flip delegated_at from NULL to now(). Concurrent
 * /api/reveal calls for the same game can race; the loser sees false
 * and should skip the on-chain delegate_game tx (the winner's tx
 * handles it).
 */
export async function claimDelegationSlot(gamePda: PublicKey): Promise<boolean> {
  // UPDATE ... WHERE delegated_at IS NULL is the atomic claim: Postgres
  // serializes the row write, only one concurrent claim wins.
  const { data, error } = await supabaseAdmin()
    .from("game_session_keys")
    .update({ delegated_at: new Date().toISOString() })
    .eq("game_pda", gamePda.toBase58())
    .is("delegated_at", null)
    .select("game_pda");
  if (error) {
    logger.error(
      { err: error.message, gamePda: gamePda.toBase58() },
      "claimDelegationSlot failed",
    );
    throw new Error(`claimDelegationSlot: ${error.message}`);
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Release the delegation claim if the on-chain delegate_game tx failed
 * after we wrote delegated_at. Keeps the next /api/reveal attempt able
 * to retry instead of silently reading delegated=true for a game that
 * never made it to ER.
 */
export async function releaseDelegationSlot(gamePda: PublicKey): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("game_session_keys")
    .update({ delegated_at: null })
    .eq("game_pda", gamePda.toBase58());
  if (error) {
    logger.warn(
      { err: error.message, gamePda: gamePda.toBase58() },
      "releaseDelegationSlot failed (non-fatal) — manual recovery may be needed",
    );
  }
}

/** Best-effort delete; runs on settle or on explicit cleanup. Idempotent. */
export async function deleteSessionKey(gamePda: PublicKey): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("game_session_keys")
    .delete()
    .eq("game_pda", gamePda.toBase58());
  if (error) {
    logger.warn(
      { err: error.message, gamePda: gamePda.toBase58() },
      "deleteSessionKey failed (non-fatal)",
    );
  }
}

/** Convenience: load + rehydrate into a Keypair ready to sign with. */
export async function loadSessionKeypair(gamePda: PublicKey): Promise<Keypair> {
  const secret = await loadSessionKey(gamePda);
  return Keypair.fromSecretKey(secret);
}
