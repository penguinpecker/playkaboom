/**
 * Site-check lane data-copy (2026-11-05): figures the home, /leaderboard,
 * /vault, /profile and /verify pages now compute instead of hard-coding.
 * Fixtures are the live values from that run.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAgo, formatCooldown, formatSolAmount } from "./format";
import {
  isValidWallet,
  leaderboardTotals,
  maxOfferedMultiplier,
  readJsonOrThrow,
} from "./site-stats";

test("F13/DATA-8: small real amounts are not rounded to zero", () => {
  assert.equal(formatSolAmount(119_900 / 1e9), "0.0001199"); // top win, was "0.000"
  assert.equal(formatSolAmount(20_000 / 1e9, 4), "0.00002"); // referral earned, was "0.0000"
  assert.equal(formatSolAmount(4_000_000 / 1e9, 2), "0.004"); // referred volume, was "0.00"
  assert.equal(formatSolAmount(-0.0015612), "-0.001561");
  // Normal amounts keep the page's own precision.
  assert.equal(formatSolAmount(0.014), "0.014");
  assert.equal(formatSolAmount(0.010426, 4), "0.0104");
  assert.equal(formatSolAmount(0), "0.000");
});

test("F10/DATA-7: cooldown comes from withdrawCooldownDays", () => {
  assert.equal(formatCooldown(1.5997), "1.6-day");
  assert.equal(formatCooldown(undefined), null);
});

test("F4: Live Operations ages use minutes/hours, not raw seconds", () => {
  const now = Date.parse("2026-11-05T09:17:08Z");
  assert.equal(formatAgo("2026-11-05T09:16:58Z", now), "10s ago");
  assert.equal(formatAgo("2026-11-05T06:17:08Z", now), "3h ago");
});

test("F4/DATA-5: totals from /api/leaderboard rows count players and settled games", () => {
  const t = leaderboardTotals([
    { games_played: 4, total_wagered: 4_000_000, total_payouts: 2_239_800 },
    { games_played: 1, total_wagered: 1_000_000, total_payouts: 0 },
  ]);
  assert.equal(t.players, 2); // header showed vault.totalGames (6) as operators
  assert.equal(t.gamesPlayed, 5); // vault.totalGames was 6 incl. the refunded round
  assert.equal(t.pnlSol, -0.0027602);
  assert.deepEqual(leaderboardTotals([]), { players: 0, gamesPlayed: 0, pnlSol: 0 });
});

test("F11: hero MAX is the best full clear among mine counts the vault covers", () => {
  // Live vault: only 1 mine covers the 0.01 SOL minimum bet.
  const live = { 1: 0.010413, 3: 0.000297, 5: 0.0000378, 12: 0.0000925 };
  assert.equal(maxOfferedMultiplier(live, 0.01, 200), 15.68);
  // A bigger vault unlocks 5 mines: C(16,5) x 0.98.
  assert.equal(maxOfferedMultiplier({ 1: 1, 3: 1, 5: 1, 12: 1 }, 0.01, 200), 4280.64);
  assert.equal(maxOfferedMultiplier({}, 0.01, 200), null);
});

test("F16: invalid profile addresses are detected", () => {
  assert.equal(isValidWallet("BvGTDR44jozwNDkKBKjc82KveVg4zbN6hTWUqnwkouDZ"), true);
  assert.equal(isValidWallet("notawallet"), false);
  assert.equal(isValidWallet("1111"), false);
});

test("F9: a 400 from /api/verify surfaces the API's reason", async () => {
  const bad = new Response(
    JSON.stringify({ error: "No GameWon, GameLost, or GameSettled event in this tx" }),
    { status: 400 },
  );
  await assert.rejects(readJsonOrThrow(bad), /No GameWon, GameLost, or GameSettled event/);
  await assert.rejects(readJsonOrThrow(new Response("<html>", { status: 502 })), /HTTP 502/);
  assert.deepEqual(await readJsonOrThrow(new Response('{"found":false}')), { found: false });
});
