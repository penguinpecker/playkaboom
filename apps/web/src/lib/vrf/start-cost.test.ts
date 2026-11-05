/**
 * VRF start overhead vs the player's measured balance deltas on the 2026-11-05
 * mainnet QA starts (bet 1,000,000 excluded).
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { vrfStartOverheadLamports } from "./start-cost";

test("start overhead matches what real starts cost", () => {
  // referred-002..005: stats exists, no set_referrer.
  assert.equal(vrfStartOverheadLamports({ statsExists: true, createsReferralAccount: false }), 11_012_280 - 1_000_000);
  // plain-001: first game, no referral.
  assert.equal(vrfStartOverheadLamports({ statsExists: false, createsReferralAccount: false }), 12_693_760 - 1_000_000);
  // referred-001: first game + set_referrer creating the referrer's account.
  assert.equal(vrfStartOverheadLamports({ statsExists: false, createsReferralAccount: true }), 13_867_240 - 1_000_000);
});

test("a referred newcomer is never let through on the old 11,795,760 figure", () => {
  assert.ok(vrfStartOverheadLamports({ statsExists: false, createsReferralAccount: true }) > 11_795_760);
});
