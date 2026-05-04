import { sha256 } from "@noble/hashes/sha256";

/**
 * Anchor's instruction discriminator: SHA-256("global:" + name)[0..8].
 * Browser- and Node-safe via `@noble/hashes`.
 */
export function ixDiscriminator(name: string): Buffer {
  const digest = sha256(new TextEncoder().encode(`global:${name}`));
  return Buffer.from(digest.subarray(0, 8));
}

/** Anchor's account discriminator: SHA-256("account:" + name)[0..8]. */
export function accountDiscriminator(name: string): Buffer {
  const digest = sha256(new TextEncoder().encode(`account:${name}`));
  return Buffer.from(digest.subarray(0, 8));
}
