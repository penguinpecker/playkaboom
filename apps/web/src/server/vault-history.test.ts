/**
 * LP realised return: annualised by the reading's real age, not an assumed 30 days.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annualisedReturn } from "./vault-history";

const DAY = 86_400_000;
const E18 = 10n ** 18n;

test("annualisedReturn compounds over the reading's real age", () => {
  const up1pct = (E18 * 101n) / 100n;
  // 30-day-old reading: the old formula's case.
  assert.ok(Math.abs(annualisedReturn(E18, up1pct, 30 * DAY)! - (1.01 ** (365 / 30) - 1)) < 1e-12);
  // 60-day-old reading (snapshot gap): the same growth annualises over 60 days, not 30.
  assert.ok(Math.abs(annualisedReturn(E18, up1pct, 60 * DAY)! - (1.01 ** (365 / 60) - 1)) < 1e-12);
  // A loss stays a loss.
  assert.ok(annualisedReturn(E18, (E18 * 99n) / 100n, 30 * DAY)! < 0);
});

test("annualisedReturn: nothing to compare is null, not 0", () => {
  assert.equal(annualisedReturn(0n, E18, 30 * DAY), null);
  assert.equal(annualisedReturn(E18, 0n, 30 * DAY), null);
  assert.equal(annualisedReturn(E18, E18, 0), null);
});
