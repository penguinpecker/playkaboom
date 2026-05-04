import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { computeCommitment, verifyGame } from "@playkaboom/sdk";

describe("computeCommitment / verifyGame", () => {
  it("matches between compute and verify", () => {
    const layout = 0b0000_0000_0000_1011; // 3 mines
    const mineCount = 3;
    const salt = randomBytes(32);
    const commitment = computeCommitment(layout, mineCount, salt);
    expect(verifyGame(layout, mineCount, salt, commitment)).toBe(true);
  });

  it("rejects altered layout", () => {
    const layout = 0xabcd & 0xffff;
    const mineCount = ((layout & 0xffff) >>> 0).toString(2).split("1").length - 1;
    const salt = randomBytes(32);
    const commitment = computeCommitment(layout, mineCount, salt);
    expect(verifyGame(layout ^ 1, mineCount, salt, commitment)).toBe(false);
  });

  it("rejects altered salt", () => {
    const layout = 0x000f;
    const mineCount = 4;
    const salt = randomBytes(32);
    const commitment = computeCommitment(layout, mineCount, salt);
    const tampered = Buffer.from(salt);
    tampered[0] = (tampered[0]! ^ 1) as number;
    expect(verifyGame(layout, mineCount, tampered, commitment)).toBe(false);
  });

  it("throws on bad shapes", () => {
    expect(() => computeCommitment(-1, 3, Buffer.alloc(32))).toThrow();
    expect(() => computeCommitment(1, 3, Buffer.alloc(31))).toThrow();
  });
});
