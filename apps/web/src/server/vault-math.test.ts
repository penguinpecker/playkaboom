/**
 * LP panel "Max single deposit" includes the house-share floor (6033), and the
 * deposit history records the unit value the deposit was priced at.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultV2StateAccount } from "@playkaboom/sdk";
import { depositUnitValueE18, maxDepositLamports } from "./vault-math";

const v2Of = (o: Partial<VaultV2StateAccount>) => o as VaultV2StateAccount;

// The program's lp_deposit, written out independently: deposit_to_units,
// user_units_total, enforce_house_floor (pinocchio/kaboom-p ix/v2_lp.rs).
function floorPasses(v2: VaultV2StateAccount, assets: bigint, amount: bigint): boolean {
  const minted = v2.totalUnits === 0n ? amount : (amount * v2.totalUnits) / assets;
  if (minted === 0n) return false;
  const user = v2.totalUnits + minted - v2.seedUnits - v2.houseUnits - v2.housePendingUnits;
  const bps = BigInt(v2.minHouseShareBps);
  if (bps === 0n || v2.houseUnits + user === 0n) return true;
  return v2.houseUnits * 10_000n >= bps * (v2.houseUnits + user);
}

// Mainnet after the 11-05 QA run: house 10,100,000 units vs 10,000,832 LP units.
const live = {
  totalUnits: 1_020_100_832n,
  seedUnits: 1_000_000_000n,
  houseUnits: 10_100_000n,
  housePendingUnits: 0n,
  minHouseShareBps: 5000,
  maxUserPositionBps: 1000,
  minLpDeposit: 10_000_000n,
};
const liveAssets = 1_047_001_767n;

test("live vault: the house floor refuses even the 0.01 SOL minimum, so the max is 0 (was 0.105)", () => {
  assert.equal(maxDepositLamports(v2Of(live), liveAssets, 10_000), 0n);
  assert.equal(floorPasses(v2Of(live), liveAssets, live.minLpDeposit), false);
  // With no minimum and no per-user cap, the floor alone leaves 101,784 lamports.
  const floorOnly = v2Of({ ...live, minLpDeposit: 0n, maxUserPositionBps: 0 });
  assert.equal(maxDepositLamports(floorOnly, liveAssets, 10_000), 101_784n);
});

test("the max is exact: it passes the program's floor and one lamport more does not", () => {
  for (const bps of [1, 2500, 5000, 6667, 9999]) {
    for (const [total, seed, house, housePending, assets] of [
      [1_020_100_832n, 1_000_000_000n, 10_100_000n, 0n, 1_047_001_767n],
      [5_000_000_000n, 1_000_000_000n, 3_000_000_000n, 250_000_000n, 4_321_987_654n],
      [2_000_000_000n, 0n, 1_999_999_999n, 0n, 1_999_000_001n],
    ] as const) {
      const v2 = v2Of({ totalUnits: total, seedUnits: seed, houseUnits: house, housePendingUnits: housePending, minHouseShareBps: bps, maxUserPositionBps: 0, minLpDeposit: 0n });
      const max = maxDepositLamports(v2, assets, 10_000);
      if (max > 0n) assert.ok(floorPasses(v2, assets, max), `bps ${bps} total ${total}: max ${max} passes`);
      assert.ok(!floorPasses(v2, assets, max + 1n), `bps ${bps} total ${total}: max+1 is refused`);
    }
  }
});

test("the smaller limit wins; 'no limit' only when neither applies", () => {
  const roomy = { ...live, houseUnits: 900_000_000n, totalUnits: 1_910_000_832n }; // floor far away
  const assets = 1_950_000_000n;
  // Per-user cap: 10% of assets at full health.
  assert.equal(maxDepositLamports(v2Of(roomy), assets, 10_000), 195_000_000n);
  // Both off: the sentinel the panel shows as "No limit".
  assert.equal(maxDepositLamports(v2Of({ ...roomy, minHouseShareBps: 0, maxUserPositionBps: 0 }), assets, 10_000), 1n << 60n);
  // Per-user cap off, floor on: the floor, not "no limit".
  const floorOnly = maxDepositLamports(v2Of({ ...live, maxUserPositionBps: 0, minLpDeposit: 0n }), liveAssets, 10_000);
  assert.ok(floorOnly > 0n && floorOnly < 1n << 60n);
});

test("deposit history: the unit value the deposit was priced at, not the after-deposit value", () => {
  const assetsPre = 1_010_015_894n;
  const totalPre = 1_010_100_000n;
  const amount = 10_000_000n;
  const minted = (amount * totalPre) / assetsPre;
  const ev = { amountLamports: amount, unitsMinted: minted, totalUnitsAfter: totalPre + minted, vaultAssetsAfter: assetsPre + amount };
  const E18 = 10n ** 18n;
  assert.equal(depositUnitValueE18(ev), (assetsPre * E18) / totalPre);
  assert.notEqual(depositUnitValueE18(ev), (ev.vaultAssetsAfter * E18) / ev.totalUnitsAfter);
  // First deposit into an empty vault: one unit per lamport.
  assert.equal(depositUnitValueE18({ amountLamports: amount, unitsMinted: amount, totalUnitsAfter: amount, vaultAssetsAfter: amount }), E18);
});
