import "server-only";
import { Keypair, Transaction, type PublicKey, type VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * The house signer: a raw Solana keypair from HOUSE_SECRET_KEY. Its public key
 * is `vault.house_authority`, set at initialize_vault.
 *
 * The secret never leaves this module: it is not logged, not returned and not
 * put in an error message (parse errors name the problem, never the input).
 * Only `publicKey` and `signTransaction` are exposed.
 */
export interface HouseSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}

const ENV = "HOUSE_SECRET_KEY";

/**
 * Decode a 64-byte Solana secret key given as base58 (Phantom/`solana-keygen`
 * export) or as a JSON byte array (the keypair file format). Throws a message
 * that never contains the input.
 */
export function parseHouseSecretKey(raw: string): Keypair {
  const s = raw.trim();
  let bytes: Uint8Array;
  if (s.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(s);
    } catch {
      // JSON.parse's own message quotes part of the input: never rethrow it.
      throw new Error(`${ENV} is not a valid JSON byte array`);
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error(`${ENV} JSON must be an array of bytes`);
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = bs58.decode(s);
    } catch {
      throw new Error(`${ENV} is neither base58 nor a JSON byte array`);
    }
  }
  if (bytes.length !== 64) throw new Error(`${ENV} must decode to 64 bytes, got ${bytes.length}`);
  try {
    // Validates that the second half is the public key of the first.
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error(`${ENV} is not a valid ed25519 keypair (public half does not match)`);
  }
}

let cached: HouseSigner | null = null;

/** Lazily built from HOUSE_SECRET_KEY; `assertHouseSignerConfig` runs it at boot. */
export function getHouseSigner(): HouseSigner {
  if (cached) return cached;
  const raw = process.env[ENV];
  if (!raw) throw new Error(`${ENV} is not set`);
  const kp = parseHouseSecretKey(raw);
  cached = {
    publicKey: kp.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof Transaction) tx.partialSign(kp);
      else tx.sign([kp]);
      return tx;
    },
  };
  return cached;
}

/** Boot check (instrumentation.ts): fail the server start on a missing or malformed key. */
export function assertHouseSignerConfig(): PublicKey {
  return getHouseSigner().publicKey;
}
