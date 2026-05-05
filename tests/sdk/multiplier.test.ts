import { describe, expect, it } from "vitest";
import { calcMultiplier, calcMultiplierBps, BPS, GRID_SIZE } from "@playkaboom/shared";

describe("calcMultiplierBps", () => {
  it("returns 1.0× when no tiles revealed", () => {
    expect(calcMultiplierBps(0, 3, 200)).toBe(BigInt(BPS));
  });

  it("matches the program for a few sentinel inputs (1 mine, 1 safe)", () => {
    // Integer math (mirrors the program exactly):
    //   raw_bps  = (16 * 10_000) / 15            = 10666  (floor)
    //   final    = (10666 * 9800) / 10_000       = 10452  (floor)
    const bps = calcMultiplierBps(1, 1, 200);
    expect(Number(bps)).toBe(10452);
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
