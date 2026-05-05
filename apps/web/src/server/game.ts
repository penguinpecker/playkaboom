import "server-only";
import { randomBytes } from "node:crypto";
import { GRID_SIZE, MAX_MINES, MIN_MINES } from "@playkaboom/shared";
import { computeCommitment } from "@playkaboom/sdk";
import type { SessionPayload } from "./session";

/**
 * Unbiased Fisher-Yates shuffle producing a u16 bitmask with `mineCount` bits set.
 * Uses rejection-sampled `randomBytes` to avoid modulo bias.
 */
export function generateMineLayout(mineCount: number): number {
  if (mineCount < MIN_MINES || mineCount > MAX_MINES) {
    throw new RangeError("invalid mineCount");
  }
  const tiles = Array.from({ length: GRID_SIZE }, (_, i) => i);
  for (let i = tiles.length - 1; i > 0; i--) {
    const range = i + 1;
    const max = 256 - (256 % range);
    let r: number;
    do {
      r = randomBytes(1)[0]!;
    } while (r >= max);
    const j = r % range;
    [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
  }
  let layout = 0;
  for (let k = 0; k < mineCount; k++) {
    layout |= 1 << tiles[tiles.length - 1 - k]!;
  }
  return layout;
}

export interface NewSession {
  payload: SessionPayload;
  commitment: Buffer;
}

export function createGameSession(player: string, mineCount: number): NewSession {
  const layout = generateMineLayout(mineCount);
  const salt = randomBytes(32);
  const commitment = computeCommitment(layout, mineCount, salt);
  const payload: SessionPayload = {
    player,
    mineCount,
    mineLayout: layout,
    salt: salt.toString("hex"),
    commitment: commitment.toString("hex"),
    reveals: [],
    nonce: 0,
    createdAt: Date.now(),
  };
  return { payload, commitment };
}

export function checkTile(
  session: SessionPayload,
  tileIndex: number,
): { isMine: boolean; updated: SessionPayload } {
  if (tileIndex < 0 || tileIndex >= GRID_SIZE) throw new RangeError("tile index out of range");
  if (session.reveals.includes(tileIndex)) {
    throw new Error("Tile already revealed");
  }
  const isMine = (session.mineLayout & (1 << tileIndex)) !== 0;
  return {
    isMine,
    updated: {
      ...session,
      reveals: [...session.reveals, tileIndex],
      nonce: session.nonce + 1,
    },
  };
}

export function saltBuffer(session: SessionPayload): Buffer {
  return Buffer.from(session.salt, "hex");
}
