import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sessionEncKey } from "./env";

const VERSION = 1;
const PREFIX = `pk${VERSION}:`;

export interface SessionPayload {
  /** Player base58 pubkey. */
  player: string;
  /** Mine count (1–12). */
  mineCount: number;
  /** Mine bitmask (u16). */
  mineLayout: number;
  /** 32-byte salt, hex. */
  salt: string;
  /** 32-byte commitment, hex. */
  commitment: string;
  /** Indices already revealed. */
  reveals: number[];
  /** Monotonic counter to defeat replay. */
  nonce: number;
  /** Unix ms when the session was created. */
  createdAt: number;
}

export function encryptSession(payload: SessionPayload): string {
  const key = sessionEncKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const json = JSON.stringify(payload);
  const enc = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decryptSession(token: string): SessionPayload {
  if (!token.startsWith(PREFIX)) {
    throw new Error(`Unsupported session token version`);
  }
  const buf = Buffer.from(token.slice(PREFIX.length), "base64url");
  if (buf.length < 12 + 16 + 1) throw new Error("Token truncated");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", sessionEncKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  const parsed = JSON.parse(dec.toString("utf8")) as SessionPayload;
  // Light shape check — AES-GCM auth already covers integrity.
  if (
    typeof parsed.player !== "string" ||
    typeof parsed.mineLayout !== "number" ||
    typeof parsed.nonce !== "number"
  ) {
    throw new Error("Token payload malformed");
  }
  return parsed;
}
