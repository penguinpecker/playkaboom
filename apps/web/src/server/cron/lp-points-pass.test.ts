/**
 * LP K Points maths (no DB, no chain):
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import type { LpPositionAccount } from "@playkaboom/sdk";
import { accrue, earningPositions, hourKey } from "./lp-points-pass";
import { kPointsLpPerSolHourMicro } from "../env";

const SOL = 1_000_000_000n;
const RATE = 10_000_000n; // 10 K Points per SOL-hour, in millionths
const pos = (units: bigint, pendingUnits = 0n): LpPositionAccount => ({
  user: Keypair.generate().publicKey,
  units,
  pendingUnits,
  pendingUnlockSlot: pendingUnits ? 999n : 0n,
  createdSlot: 1n,
  bump: 255,
});

/** Runs `hours` hours at a fixed value; returns each hour's award. */
function run(valueLamports: bigint, hours: number, rate = RATE) {
  let acc = 0n;
  const awards: bigint[] = [];
  for (let h = 0; h < hours; h++) {
    const r = accrue(acc, valueLamports, rate);
    acc = r.accruedE15;
    awards.push(r.award);
  }
  return { acc, awards };
}

test("accrual: exact fractional carry; 0.01 SOL earns its 1st point in hour 10", () => {
  const small = run(SOL / 100n, 20);
  assert.deepEqual(small.awards.map(Number), [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(small.acc, 2n * 10n ** 15n, "no rounding loss");
  assert.deepEqual(run(SOL, 3).awards, [10n, 10n, 10n]);
  // 0.15 SOL = 1.5 points/h: the half carries, 2 points every 2 hours.
  assert.deepEqual(run((15n * SOL) / 100n, 4).awards, [1n, 2n, 1n, 2n]);
  // A rate change applies from that hour on, never to hours already accrued.
  const a = accrue(0n, SOL, RATE);
  assert.deepEqual(accrue(a.accruedE15, SOL, 2n * RATE).award, 20n);
  // Sum of awards == floor(total): nothing lost or doubled over a long run.
  const odd = run(123_456_789n, 1000);
  assert.equal(odd.awards.reduce((s, x) => s + x, 0n), odd.acc / 10n ** 15n);
});

test("a withdrawal request stops the points; cancelled, the position earns again", () => {
  const p = pos(5n * SOL);
  const hourly = (q: LpPositionAccount) => earningPositions([q], 10n * SOL, 10n * SOL);
  assert.deepEqual(hourly(p), [{ owner: p.user.toBase58(), valueLamports: 5n * SOL }]);
  // request_withdraw(1 SOL of units): 4 SOL stay active, yet nothing earns.
  const requested = { ...p, units: 4n * SOL, pendingUnits: SOL };
  assert.deepEqual(hourly(requested), []);
  // cancel_withdraw: units back, pending 0 -> earns again at the next measurement.
  const cancelled = { ...requested, units: 5n * SOL, pendingUnits: 0n, pendingUnlockSlot: 0n };
  assert.deepEqual(hourly(cancelled), hourly(p));
  // Fully requested, completed (empty) or empty positions earn nothing.
  assert.deepEqual(hourly(pos(0n, 5n * SOL)), []);
  assert.deepEqual(hourly(pos(0n)), []);
});

test("only LpPositions earn: house and seed units dilute the unit value but are never credited", () => {
  // Vault: 30 SOL of assets over 20 units (unit value 1.5): seed 1, house 15, users 4.
  const seed = SOL, house = 15n * SOL;
  const a = pos(3n * SOL), b = pos(SOL);
  const total = seed + house + a.units + b.units;
  const out = earningPositions([a, b], total, 30n * SOL);
  assert.deepEqual(out.map((x) => x.valueLamports), [(9n * SOL) / 2n, (3n * SOL) / 2n]);
  // Credited value = the users' share only (6 of 30 SOL), not the vault's.
  assert.equal(out.reduce((s, x) => s + x.valueLamports, 0n), 6n * SOL);
});

test("K_POINTS_LP_PER_SOL_HOUR: default 10, decimals ok, anything not > 0 throws; hour keys are UTC", () => {
  const prev = process.env.K_POINTS_LP_PER_SOL_HOUR;
  try {
    delete process.env.K_POINTS_LP_PER_SOL_HOUR;
    assert.equal(kPointsLpPerSolHourMicro(), RATE);
    process.env.K_POINTS_LP_PER_SOL_HOUR = " 2.5 ";
    assert.equal(kPointsLpPerSolHourMicro(), 2_500_000n);
    for (const bad of ["0", "-1", "abc", "Infinity", "1e30", "0.0000001"]) {
      process.env.K_POINTS_LP_PER_SOL_HOUR = bad;
      assert.throws(() => kPointsLpPerSolHourMicro(), /K_POINTS_LP_PER_SOL_HOUR/, bad);
    }
  } finally {
    if (prev === undefined) delete process.env.K_POINTS_LP_PER_SOL_HOUR;
    else process.env.K_POINTS_LP_PER_SOL_HOUR = prev;
  }
  assert.equal(hourKey(new Date("2026-11-05T16:59:59.999+05:30")), "2026-11-05T11");
});
