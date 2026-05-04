import { BPS, GRID_SIZE } from "./constants";

/**
 * Hypergeometric mines multiplier in basis points.
 * Uses BigInt to mirror the program's u128 math exactly — the UI shows the
 * same number the chain will pay.
 */
export function calcMultiplierBps(
  safeReveals: number,
  mineCount: number,
  houseEdgeBps: number,
): bigint {
  if (safeReveals < 0 || mineCount < 0 || mineCount + safeReveals > GRID_SIZE) {
    throw new RangeError("invalid (safeReveals, mineCount)");
  }
  if (safeReveals === 0) return BigInt(BPS);

  const total = BigInt(GRID_SIZE);
  const mines = BigInt(mineCount);
  let num = 1n;
  let den = 1n;
  for (let i = 0n; i < BigInt(safeReveals); i++) {
    const tilesRemaining = total - i;
    const safeRemaining = total - mines - i;
    if (safeRemaining <= 0n) break;
    num *= tilesRemaining;
    den *= safeRemaining;
  }
  const rawBps = (num * BigInt(BPS)) / den;
  const edgeFactor = BigInt(BPS) - BigInt(houseEdgeBps);
  return (rawBps * edgeFactor) / BigInt(BPS);
}

/** As a float for display. */
export function calcMultiplier(
  safeReveals: number,
  mineCount: number,
  houseEdgeBps: number,
): number {
  return Number(calcMultiplierBps(safeReveals, mineCount, houseEdgeBps)) / BPS;
}

export function formatMultiplier(mult: number, fractionDigits = 2): string {
  return `${mult.toFixed(fractionDigits)}×`;
}
