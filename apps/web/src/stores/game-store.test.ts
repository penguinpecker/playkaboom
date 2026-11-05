/**
 * /play bet panel guards (site check F1/DATA-2, F5, F15).
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceBlockReason, coverableMineCount, mineCountBlockReason } from "./game-store";

// Live caps on 2026-11-05 (SOL): only 1 mine clears the 0.01 minimum.
const caps = { 1: 0.010333, 3: 0.000295, 5: 0.000038, 12: 0.000091 };

test("an uncoverable count has a reason, selected or not; an unloaded vault has none", () => {
  assert.equal(mineCountBlockReason(3, caps[3], 0.01), "Vault can't cover 3 mines right now — needs 34x more bankroll");
  assert.equal(mineCountBlockReason(1, caps[1], 0.01), null);
  assert.equal(mineCountBlockReason(3, 0, 0.01), null); // vault still loading
  // Today's 1-mine cap (0.009 vs 0.01 min) is a 1.1x shortfall, not "1x".
  assert.equal(mineCountBlockReason(1, 0.008998, 0.01), "Vault can't cover 1 mines right now — needs 1.1x more bankroll");
});

test("an idle selection moves from an uncoverable count to the first coverable one", () => {
  assert.equal(coverableMineCount(3, caps, 0.01), 1); // the store default today
  assert.equal(coverableMineCount(3, { ...caps, 3: 0.02 }, 0.01), 3); // covered: kept
  assert.equal(coverableMineCount(3, {}, 0.01), 3); // vault still loading: kept
  assert.equal(coverableMineCount(3, { 1: 0.001, 3: 0.001, 5: 0.001, 12: 0.001 }, 0.01), 3); // none covered: kept, greyed
});

test("no wallet connected means no balance-shortfall error", () => {
  assert.equal(balanceBlockReason(false, 0.01, 0, 0.0117, 0.01), null);
  assert.match(balanceBlockReason(true, 0.01, 0, 0.0117, 0.01) ?? "", /exceeds your balance/);
  assert.match(balanceBlockReason(true, 0.01, 0.015, 0.0117, 0.01) ?? "", /top up to about 0\.022 SOL/);
  assert.equal(balanceBlockReason(true, 0.01, 1, 0.0117, 0.01), null);
});
