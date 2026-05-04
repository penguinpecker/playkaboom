import { describe, expect, it } from "vitest";
import { calcMultiplier, calcMultiplierBps, BPS, GRID_SIZE } from "@playkaboom/shared";

describe("calcMultiplierBps", () => {
  it("returns 1.0× when no tiles revealed", () => {
    expect(calcMultiplierBps(0, 3, 200)).toBe(BigInt(BPS));
  });

  it("matches the program for a few sentinel inputs (1 mine, 1 safe)", () => {
    // (16 / 15) * 0.98 = 1.0453 → 10453 bps (truncated by integer math)
    const bps = calcMultiplierBps(1, 1, 200);
    expect(Number(bps)).toBeGreaterThanOrEqual(10453);
    expect(Number(bps)).toBeLessThanOrEqual(10454);
  });

  it("monotonically increases with safe reveals", () => {
    let prev = 0n;
    for (let i = 1; i <= GRID_SIZE - 5; i++) {
      const m = calcMultiplierBps(i, 5, 200);
      expect(m > prev).toBe(true);
      prev = m;
    }
  });

  it("respects the house edge", () => {
    const noEdge = calcMultiplierBps(3, 3, 0);
    const withEdge = calcMultiplierBps(3, 3, 200);
    expect(noEdge > withEdge).toBe(true);
  });

  it("calcMultiplier returns a reasonable float", () => {
    const m = calcMultiplier(8, 3, 200);
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThan(1000);
  });
});
