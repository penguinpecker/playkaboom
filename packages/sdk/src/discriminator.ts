import { createHash } from "node:crypto";

/**
 * Anchor's instruction discriminator: SHA-256("global:" + name)[0..8].
 * Centralized here so call sites reference the SDK rather than each
 * recomputing the hash with hand-rolled magic strings.
 */
export function ixDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor's account discriminator: SHA-256("account:" + name)[0..8]. */
export function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}
