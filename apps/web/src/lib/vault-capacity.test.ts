/**
 * /vault, /logs and /api/vault/state headline limits use the game page's
 * per-mine maths. Fixture: the live mainnet vault at 2026-11-05 04:52 IST
 * (QA critic run), where the old numbers were 0.0327 SOL max bet (2% of assets)
 * and 0.816 SOL max payout (50%), and chain-derived truth was 0.010413 / 0.163.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultAccount, VaultV2StateAccount } from "@playkaboom/sdk";
import { computeCapacity, vaultLimits } from "./vault-capacity";

const LAMPORTS = 1_635_658_844n;
const RENT = 2_824_480n; // assets 1,632,834,364
const vault = { paused: false, maxBetBps: 200, maxPayoutBps: 5_000, houseEdgeBps: 200 } as unknown as VaultAccount;
const v2 = (outstanding = 0n) =>
  ({
    totalUnits: 1_630_144_996n,
    totalPendingUnits: 0n,
    totalOutstandingMaxPayout: outstanding,
    vrfMaxPayoutBps: 1_000,
  }) as unknown as VaultV2StateAccount;

test("headline limits: VRF 10% payout cap and the best mine count's max bet", () => {
  const l = vaultLimits(LAMPORTS, vault, v2(), RENT, true);
  assert.equal(l.maxPayoutLamports, 163_283_436n);
  assert.equal(l.maxBetLamports, 10_413_484n); // 1 mine (worst case 15.68x)
});

test("per-mine max bet matches the chain-derived figures", () => {
  const bet = (m: number) => computeCapacity(LAMPORTS, vault, v2(), 0, m, RENT, true).maxBetLamports;
  assert.equal(bet(2), 1_388_464n);
  assert.equal(bet(3), 297_528n); // below the 0.001 SOL minimum: unplayable
  assert.equal(bet(15), 10_413_484n);
});

test("health scales both caps like start_game_vrf", () => {
  // Half the assets reserved -> health 5000 -> payout 5%, bet cap 1%.
  const l = vaultLimits(LAMPORTS, vault, v2(816_417_182n), RENT, true);
  assert.equal(l.maxPayoutLamports, 81_641_718n);
  assert.equal(l.maxBetLamports, 5_206_742n);
});

test("paused or missing vault quotes no limit", () => {
  assert.deepEqual(vaultLimits(LAMPORTS, null, v2(), RENT, true), { maxBetLamports: 0n, maxPayoutLamports: 0n });
  const paused = { ...vault, paused: true } as VaultAccount;
  assert.deepEqual(vaultLimits(LAMPORTS, paused, v2(), RENT, true), { maxBetLamports: 0n, maxPayoutLamports: 0n });
});
