import { sha256 } from "@noble/hashes/sha256";

/**
 * Recompute the commitment from the public proof. Anyone can run this against
 * a finalized game's `mine_layout`, `mine_count`, and `salt` and check it
 * matches the on-chain `commitment`. Browser- and Node-safe.
 */
export function computeCommitment(mineLayout: number, mineCount: number, salt: Buffer): Buffer {
  if (salt.length !== 32) throw new Error("salt must be 32 bytes");
  if (mineLayout < 0 || mineLayout > 0xffff) throw new RangeError("mineLayout must fit in u16");
  if (mineCount < 0 || mineCount > 16) throw new RangeError("mineCount out of range");
  const layoutBytes = Buffer.alloc(2);
  layoutBytes.writeUInt16LE(mineLayout, 0);
  const preimage = Buffer.concat([layoutBytes, Buffer.from([mineCount]), salt]);
  return Buffer.from(sha256(preimage));
}

export function verifyGame(
  mineLayout: number,
  mineCount: number,
  salt: Buffer,
  commitment: Buffer,
): boolean {
  if (commitment.length !== 32) return false;
  return computeCommitment(mineLayout, mineCount, salt).equals(commitment);
}
