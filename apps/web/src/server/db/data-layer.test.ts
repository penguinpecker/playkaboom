/**
 * Data-layer test against a real, throwaway Postgres (never production):
 *
 *   createdb kaboom_rw_test && DATABASE_URL=postgres:///kaboom_rw_test node db/migrate.mjs
 *   DATABASE_URL=postgres:///kaboom_rw_test npm run test:db --workspace=@playkaboom/web
 *
 * It writes rows, so it refuses to run when public.games already has any.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import {
  accountDiscriminator,
  deriveReferralPda,
  eventDiscriminator,
  type VrfClaimAccount,
  type VrfGameAccount,
} from "@playkaboom/sdk";
import pg from "pg";

const PROGRAM = "Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju";
process.env.PROGRAM_ID = PROGRAM;
process.env.SESSION_ENC_KEY = randomBytes(32).toString("hex");
process.env.SOLANA_RPC = "http://127.0.0.1:9"; // nothing listens: chain reads are mocked per test
process.env.LOG_LEVEL ??= "silent";

// Imported after the env above is set (the logger reads LOG_LEVEL at import).
let m: {
  pg: typeof import("./pg");
  indexer: typeof import("../indexer");
  points: typeof import("../points");
  codes: typeof import("../referral-codes");
  tracking: typeof import("../referral-tracking");
  sessions: typeof import("../session-store");
  vrf: typeof import("../vrf-settle");
  history: typeof import("../vault-history");
  lpPoints: typeof import("../cron/lp-points-pass");
};
const query: typeof import("./pg").query = (sql, params) => m.pg.query(sql, params);

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/;
const pk = () => Keypair.generate().publicKey;
const sig = () => randomBytes(64).toString("hex").slice(0, 88);

function u64(n: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function logs(name: string, body: Buffer): string[] {
  const data = Buffer.concat([eventDiscriminator(name), body]).toString("base64");
  return [`Program ${PROGRAM} invoke [1]`, `Program data: ${data}`, `Program ${PROGRAM} success`];
}
const gameWon = (player: PublicKey, game: PublicKey, bet: bigint, payout: bigint, slot: bigint) =>
  logs(
    "GameWon",
    Buffer.concat([
      player.toBuffer(),
      game.toBuffer(),
      u64(bet),
      u64(payout),
      u64(20_000n),
      Buffer.from([3]),
      u64(slot),
    ]),
  );
const gameSettled = (player: PublicKey, game: PublicKey, layout: number, slot: bigint) => {
  const b = Buffer.alloc(32 + 32 + 1 + 2 + 32 + 32 + 1);
  player.toBuffer().copy(b, 0);
  game.toBuffer().copy(b, 32);
  b.writeUInt8(3, 64);
  b.writeUInt16LE(layout, 65);
  b.fill(0xaa, 67, 99);
  b.fill(0xbb, 99, 131);
  b.writeUInt8(1, 131);
  return logs("GameSettled", Buffer.concat([b, u64(slot)]));
};

let listener: pg.Client;
const notes: string[] = [];

before(async () => {
  m = {
    pg: await import("./pg"),
    indexer: await import("../indexer"),
    points: await import("../points"),
    codes: await import("../referral-codes"),
    tracking: await import("../referral-tracking"),
    sessions: await import("../session-store"),
    vrf: await import("../vrf-settle"),
    history: await import("../vault-history"),
    lpPoints: await import("../cron/lp-points-pass"),
  };
  const [{ n } = { n: 0 }] = await query<{ n: number }>("select count(*) as n from public.games");
  if (n > 0) throw new Error("public.games has rows: refusing to run on a non-empty database");
  listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await listener.connect();
  listener.on("notification", (m) => notes.push(m.payload ?? ""));
  await listener.query("LISTEN kaboom_events");
});

after(async () => {
  await listener?.end();
  await m?.pg.db().end();
});

test("value shapes match PostgREST: int8/numeric -> number, timestamptz -> ISO +00:00", async () => {
  const [r] = await query<{ b: unknown; n: unknown; t: unknown; z: unknown }>(
    "select 42::bigint as b, 1500000000000000000::numeric as n, '2026-11-04 10:00:00.123456+00'::timestamptz as t, null::bigint as z",
  );
  assert.equal(r!.b, 42);
  assert.equal(r!.n, 1.5e18);
  assert.equal(r!.t, "2026-11-04T10:00:00.123456+00:00");
  assert.equal(r!.z, null);
});

test("indexer: GameWon -> games + points, GameSettled fills it, replays are skipped, NOTIFY fires", async () => {
  const player = pk();
  const game = pk();
  const won = {
    signature: sig(),
    slot: 100,
    blockTime: Math.floor(Date.now() / 1000),
    logMessages: gameWon(player, game, 1_000_000_000n, 2_000_000_000n, 100n),
  };
  let r = await m.indexer.ingestTransactions([won]);
  assert.deepEqual([r.processed, r.skipped, r.errors], [1, 0, 0], JSON.stringify(r.errorDetails));

  const settle = {
    signature: sig(),
    slot: 101,
    blockTime: won.blockTime,
    logMessages: gameSettled(player, game, 0x0007, 101n),
  };
  r = await m.indexer.ingestTransactions([settle]);
  assert.deepEqual([r.processed, r.errors], [1, 0], JSON.stringify(r.errorDetails));

  const [row] = await query("select * from public.games where signature = $1", [won.signature]);
  assert.equal(row!.outcome, "won");
  assert.equal(row!.bet, 1_000_000_000);
  assert.equal(row!.payout, 2_000_000_000);
  assert.equal(row!.mine_count, 3);
  assert.equal(row!.settle_signature, settle.signature);
  assert.match(String(row!.settled_at), ISO);

  // Points row written once (1 SOL @ 200 bps = 1000 base points).
  const pts = await query("select total_points from public.points_ledger where source_key = $1", [
    won.signature,
  ]);
  assert.deepEqual(pts, [{ total_points: 1000 }]);

  // Replay of the same signature: claim exists -> skipped, nothing re-applied.
  r = await m.indexer.ingestTransactions([won]);
  assert.deepEqual([r.processed, r.skipped, r.errors], [0, 1, 0]);

  // Relay contract: the trigger sent INSERT then UPDATE, with no pre-image.
  await new Promise((res) => setTimeout(res, 100));
  const mine = notes.map((n) => JSON.parse(n)).filter((n) => n.row.signature === won.signature);
  assert.deepEqual(
    mine.map((n) => n.op),
    ["INSERT", "UPDATE"],
  );
  assert.equal(mine[1].row.settle_signature, settle.signature);
  assert.equal(mine[1].row.bet, 1_000_000_000);
  assert.match(mine[1].row.settled_at, ISO);
  assert.equal("mine_layout" in mine[1].row || "salt" in mine[1].row, false);
});

test("indexer: transient error releases the claim so a later tick retries", async () => {
  // A GameSettled with no matching cashout row inside the retry window throws.
  const s = sig();
  const r = await m.indexer.ingestTransactions([
    {
      signature: s,
      slot: 5,
      blockTime: Math.floor(Date.now() / 1000),
      logMessages: gameSettled(pk(), pk(), 1, 5n),
    },
  ]);
  assert.deepEqual([r.processed, r.errors], [0, 1]);
  assert.deepEqual(
    await query("select 1 from public.processed_events where signature = $1", [s]),
    [],
  );
});

test("recordVrfGame upserts by signature (second write wins, no duplicate); K Points awarded once at the claim's edge", async () => {
  const base = {
    signature: sig(),
    gamePda: pk().toBase58(),
    player: pk().toBase58(),
    betLamports: 10_000_000n, // 0.01 SOL
    payoutLamports: 20n,
    multiplierBps: 20_000,
    safeReveals: 2,
    mineCount: 3,
    won: true,
    edgeBps: 100, // not the legacy 200 constant: 0.01 SOL @ 1% = 5 (at 2% it would be 10)
    slot: 7,
    blockTime: new Date().toISOString(),
  };
  await m.indexer.recordVrfGame(base);
  await m.indexer.recordVrfGame({ ...base, payoutLamports: 25n });
  const rows = await query(
    "select payout, multiplier_bps, mine_count from public.games where signature = $1",
    [base.signature],
  );
  assert.deepEqual(rows, [{ payout: 25, multiplier_bps: 20_000, mine_count: 3 }]);
  const pts = await query(
    "select source, total_points, edge_bps, bet_lamports from public.points_ledger where source_key = $1",
    [base.signature],
  );
  assert.deepEqual(pts, [{ source: "game_won", total_points: 5, edge_bps: 100, bet_lamports: 10_000_000 }]);
});

test("awardPoints is idempotent on (source_key, source)", async () => {
  const args = {
    player: pk().toBase58(),
    sourceKey: sig(),
    source: "game_lost" as const,
    betLamports: 2_000_000_000n,
    edgeBps: 200,
  };
  assert.equal((await m.points.awardPoints(args)).inserted, true);
  assert.equal((await m.points.awardPoints(args)).inserted, false);
});

test("referral codes and visit funnel", async () => {
  const wallet = pk().toBase58();
  const a = await m.codes.getOrCreateCodeForWallet(wallet);
  const b = await m.codes.getOrCreateCodeForWallet(wallet);
  assert.equal(a.code, b.code);
  assert.equal(await m.codes.resolveAndCountVisit("nope00"), null);
  await m.codes.resolveAndCountVisit(a.code);
  await m.codes.resolveAndCountVisit(a.code);
  await new Promise((res) => setTimeout(res, 200)); // click_count bump is fire-and-forget
  const [c] = await query(
    "select click_count, last_visited_at from public.referral_codes where code = $1",
    [a.code],
  );
  assert.equal(c!.click_count, 2);
  assert.match(String(c!.last_visited_at), ISO);

  const visitor = pk().toBase58();
  const { sessionId } = await m.tracking.recordVisitClick(a.code);
  assert.equal(await m.tracking.recordSignup(sessionId, visitor), true);
  assert.equal(await m.tracking.recordSignup(sessionId, visitor), false);
  assert.equal(await m.tracking.recordSetReferrerConfirmation(visitor, sig()), true);
  assert.equal(await m.tracking.recordSetReferrerConfirmation(visitor, sig()), false);
  const [d] = await query(
    "select signup_count, confirmed_count from public.referral_codes where code = $1",
    [a.code],
  );
  assert.deepEqual(d, { signup_count: 1, confirmed_count: 1 });
});

test("session store: save, load from DB, delete", async () => {
  const player = pk().toBase58();
  const payload = {
    player,
    mineCount: 3,
    mineLayout: 7,
    salt: "aa".repeat(32),
    commitment: "bb".repeat(32),
    reveals: [],
    nonce: 0,
    createdAt: Date.now(),
  };
  await m.sessions.saveSession(player, payload, 10, {
    betLamports: 5n,
    mineCount: 3,
    startSlot: 10,
  });
  await m.sessions.saveSession(player, payload, 11); // upsert on game PDA, no duplicate
  const loaded = await m.sessions.loadSession(player);
  assert.equal(loaded?.commitment, payload.commitment);
  const [row] = await query(
    "select created_slot, bet_lamports from public.game_sessions where player = $1",
    [player],
  );
  assert.deepEqual(row, { created_slot: 11, bet_lamports: 5 });
  await m.sessions.deleteSession(player);
  assert.equal(await m.sessions.loadSession(player), null);
});

// ── VRF settle mirror (QA 11-04: settle_vrf emits no events) ────────────────

const BT = Date.parse("2026-11-04T23:07:38Z") / 1000;
function statsData(player: PublicKey, referrer: PublicKey, biggestMultiplierBps: bigint) {
  const b = Buffer.alloc(8 + 32 + 2 + 6 * 8 + 4 + 4 + 8 + 1 + 32);
  accountDiscriminator("PlayerStats").copy(b, 0);
  player.toBuffer().copy(b, 8);
  let o = 42;
  // games, won, wagered, payouts, biggest win, biggest multiplier
  for (const v of [4n, 2n, 4_000_000n, 2_239_800n, 119_900n, biggestMultiplierBps]) {
    b.writeBigUInt64LE(v, o);
    o += 8;
  }
  b.writeUInt32LE(1, o); // current streak
  b.writeUInt32LE(1, o + 4); // best streak
  b.writeBigInt64LE(BigInt(BT), o + 8);
  b.writeUInt8(1, o + 16); // referrer: Some
  referrer.toBuffer().copy(b, o + 17);
  return b;
}
function referralData(referrer: PublicKey, tier: number) {
  const b = Buffer.alloc(8 + 32 + 3 + 8 + 8 + 4 + 8);
  accountDiscriminator("ReferralAccount").copy(b, 0);
  referrer.toBuffer().copy(b, 8);
  b.writeUInt8(tier, 42);
  return b;
}

test("mirrorVrfSettle: tx's own slot + time, referral row from the tx, stats with biggest multiplier", async (t) => {
  const player = pk();
  const referrer = pk();
  const [referralPda] = deriveReferralPda(new PublicKey(PROGRAM), referrer);
  const settleSig = sig();
  // QA referred-005 (4aeFpHk…): won 1,119,900 at 11199 bps, 5,000 to the referrer, tx slot 465480384.
  const tx = {
    slot: 465_480_384,
    blockTime: BT,
    transaction: { message: { staticAccountKeys: [pk(), player, referralPda] } },
    meta: {
      err: null,
      preBalances: [9_000_000, 0, 1_173_480],
      postBalances: [8_995_000, 1_119_900, 1_178_480],
      loadedAddresses: { writable: [], readonly: [] },
    },
  } as unknown as VersionedTransactionResponse;
  const stats = { data: statsData(player, referrer, 11_199n) };
  t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
    context: { slot: 465_480_390 },
    value: [{ slot: 465_480_384, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
  }));
  t.mock.method(Connection.prototype, "getTransaction", async () => tx);
  t.mock.method(Connection.prototype, "getAccountInfo", async () => stats); // fetchPlayerReferrer
  t.mock.method(Connection.prototype, "getMultipleAccountsInfo", async () => [stats, { data: referralData(referrer, 0) }]);
  t.mock.method(Connection.prototype, "getSlot", async () => 465_480_386); // write-time slot: must not be used

  await m.vrf.mirrorVrfSettle(
    settleSig,
    player,
    { bet: 1_000_000n, mineCount: 1, houseEdgeBps: 200 } as VrfClaimAccount,
    { status: "Won", multiplierBps: 11_199n, safeReveals: 2 } as VrfGameAccount,
  );

  const [g] = await query("select slot, settled_at, payout, multiplier_bps from public.games where signature = $1", [settleSig]);
  assert.deepEqual(g, { slot: 465_480_384, settled_at: "2026-11-04T23:07:38+00:00", payout: 1_119_900, multiplier_bps: 11_199 });
  const ref = await query(
    "select referrer, player, amount, tier, slot, occurred_at from public.referral_events where signature = $1",
    [settleSig],
  );
  assert.deepEqual(ref, [
    { referrer: referrer.toBase58(), player: player.toBase58(), amount: 5_000, tier: 0, slot: 465_480_384, occurred_at: "2026-11-04T23:07:38+00:00" },
  ]);
  const [agg] = await query("select accrued_lamports, total_earned, referred_volume from public.referrals where referrer = $1", [referrer.toBase58()]);
  assert.deepEqual(agg, { accrued_lamports: 5_000, total_earned: 5_000, referred_volume: 1_000_000 });
  const [ps] = await query("select games_played, biggest_multiplier_bps from public.player_stats where player = $1", [player.toBase58()]);
  assert.deepEqual(ps, { games_played: 4, biggest_multiplier_bps: 11_199 });
  // K Points for the settle: 0.001 SOL @ the claim's 200 bps = 1, keyed on the settle signature.
  assert.deepEqual(
    await query("select player, source, total_points from public.points_ledger where source_key = $1", [settleSig]),
    [{ player: player.toBase58(), source: "game_won", total_points: 1 }],
  );

  // /api/activity shows it on both sides (the game row shares the settle signature).
  const { GET } = await import("../../app/api/activity/[wallet]/route");
  const kinds = async (w: PublicKey) =>
    ((await (await GET({} as never, { params: Promise.resolve({ wallet: w.toBase58() }) })).json()) as { events: { kind: string }[] }).events.map((e) => e.kind);
  assert.deepEqual(await kinds(player), ["game", "ref_paid"]);
  assert.deepEqual(await kinds(referrer), ["ref_received"]);

  // Legacy StatsUpdated path (no multiplier field) keeps the stored value.
  await m.pg.rpc("idx_apply_stats", {
    p_player: player.toBase58(), p_games_played: 5, p_games_won: 2, p_total_wagered: 5_000_000, p_total_payouts: 2_239_800,
    p_biggest_win: 119_900, p_current_streak: 0, p_best_streak: 1, p_last_played: new Date().toISOString(), p_event_slot: 465_490_000,
  });
  const [ps2] = await query("select games_played, biggest_multiplier_bps from public.player_stats where player = $1", [player.toBase58()]);
  assert.deepEqual(ps2, { games_played: 5, biggest_multiplier_bps: 11_199 });
});

test("indexer: ReferralClaimed is indexed per signature (referral_claims)", async () => {
  const referrer = pk();
  const s = sig();
  const r = await m.indexer.ingestTransactions([
    {
      signature: s,
      slot: 465_481_000,
      blockTime: BT + 60,
      logMessages: logs("ReferralClaimed", Buffer.concat([referrer.toBuffer(), u64(20_000n), u64(465_481_000n)])),
    },
  ]);
  assert.deepEqual([r.processed, r.errors], [1, 0], JSON.stringify(r.errorDetails));
  const rows = await query("select referrer, amount, slot, claimed_at from public.referral_claims where signature = $1", [s]);
  assert.deepEqual(rows, [{ referrer: referrer.toBase58(), amount: 20_000, slot: 465_481_000, claimed_at: "2026-11-04T23:08:38+00:00" }]);
});

test("leaderboard: every row in every view carries kPoints (0 when none); fields and order unchanged", async () => {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../../app/api/leaderboard/route");
  const earner = pk().toBase58();
  const none = pk().toBase58();
  for (const [p, wagered] of [[earner, 9e15], [none, 8e15]] as const) {
    await m.pg.rpc("idx_apply_stats", {
      p_player: p, p_games_played: 3, p_games_won: 1, p_total_wagered: wagered, p_total_payouts: 0,
      p_biggest_win: wagered, p_current_streak: 1, p_best_streak: 99, p_last_played: new Date().toISOString(), p_event_slot: 1,
    });
  }
  for (const [source, bet] of [["game_won", 10_000_000n], ["game_lost", 5_000_000n]] as const) {
    await m.points.awardPoints({ player: earner, sourceKey: sig(), source, betLamports: bet, edgeBps: 200 });
  }
  const views = { alltime: "leaderboard_alltime", volume: "leaderboard_volume", streak: "leaderboard_streaks" };
  for (const [view, table] of Object.entries(views)) {
    const res = await GET(new NextRequest(`http://test/api/leaderboard?view=${view}`));
    const { rows } = (await res.json()) as { rows: Array<Record<string, unknown> & { player: string; kPoints: number }> };
    const raw = JSON.parse(JSON.stringify(await query(`select * from public.${table} limit 50`)));
    assert.deepEqual(rows.map(({ kPoints: _k, ...r }) => r), raw, view);
    assert.ok(rows.every((r) => typeof r.kPoints === "number"), view);
    assert.equal(rows.find((r) => r.player === earner)?.kPoints, 15, view); // 10 + 5
    assert.equal(rows.find((r) => r.player === none)?.kPoints, 0, view);
  }
});

const LP_SOL = 1_000_000_000n;
const lpPosition = (user: PublicKey, units: bigint, pendingUnits = 0n) =>
  ({ user, units, pendingUnits, pendingUnlockSlot: pendingUnits ? 999n : 0n, createdSlot: 1n, bump: 255 });
const utcHour = (d: number, h: number, min = 0) => new Date(Date.UTC(2026, 10, d, h, min, 30));
/** runLpPointsHourly that must have run (not skipped). */
async function lpRun(...args: Parameters<typeof import("../cron/lp-points-pass").runLpPointsHourly>) {
  const r = await m.lpPoints.runLpPointsHourly(...args);
  if (!("credited" in r)) throw new Error(`lp points pass skipped: ${r.skipped}`);
  return r;
}

test("lp points: once per UTC hour (re-run, restart and replay add nothing); a pending hour earns nothing, cancel resumes", async () => {
  const lp = m.lpPoints;
  lp.resetLpPointsHour();
  const user = pk();
  const owner = user.toBase58();
  // 0.15 SOL at unit value 1 = 1.5 K Points an hour at the default rate.
  let snap = { positions: [lpPosition(user, (15n * LP_SOL) / 100n)], totalUnits: 10n * LP_SOL, assets: 10n * LP_SOL };
  const read = async () => snap;
  const ledger = () =>
    query("select source_key, total_points from public.points_ledger where player = $1 and source = 'lp_hourly' order by source_key", [owner]);

  const h10 = await lpRun(utcHour(5, 10), read);
  assert.deepEqual([h10.credited, h10.points], [1, "1"]);
  assert.deepEqual(await lp.runLpPointsHourly(utcHour(5, 10, 59), read), { skipped: "hour done", hour: "2026-11-05T10" });
  lp.resetLpPointsHour(); // restart / another replica, same hour: the DB guard holds
  const again = await lpRun(utcHour(5, 10, 59), read);
  assert.deepEqual([again.earning, again.credited, again.points], [1, 0, "0"]);
  assert.equal(await lp.creditLpHour(owner, 100n * LP_SOL, 10_000_000n, "2026-11-05T10"), null);

  assert.equal((await lpRun(utcHour(5, 11), read)).points, "2"); // 3.0 total
  snap = { ...snap, positions: [lpPosition(user, (5n * LP_SOL) / 100n, (10n * LP_SOL) / 100n)] }; // request_withdraw
  const h12 = await lpRun(utcHour(5, 12), read);
  assert.deepEqual([h12.positions, h12.earning, h12.credited], [1, 0, 0]);
  snap = { ...snap, positions: [lpPosition(user, (15n * LP_SOL) / 100n)] }; // cancel_withdraw
  lp.resetLpPointsHour(); // restart later in hour 12, after the cancel: still nothing for hour 12
  const h12b = await lpRun(utcHour(5, 12, 59), read);
  assert.deepEqual([h12b.earning, h12b.credited, h12b.points], [1, 0, "0"]);
  assert.equal((await lpRun(utcHour(5, 13), read)).points, "1"); // 4.5 total
  assert.equal(await lp.creditLpHour(owner, LP_SOL, 10_000_000n, "2026-11-05T11"), null, "an older hour cannot be replayed");

  assert.deepEqual(await ledger(), [
    { source_key: `lp:${owner}:2026-11-05T10`, total_points: 1 },
    { source_key: `lp:${owner}:2026-11-05T11`, total_points: 2 },
    { source_key: `lp:${owner}:2026-11-05T13`, total_points: 1 },
  ]);
  assert.deepEqual(
    await query("select accrued_e15::text as acc, last_hour from public.lp_points_accrual where owner = $1", [owner]),
    [{ acc: "4500000000000000", last_hour: "2026-11-05T13:00:00+00:00" }],
  );
});

test("leaderboard kPoints includes LP K Points", async () => {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../../app/api/leaderboard/route");
  const user = pk();
  const owner = user.toBase58();
  await m.pg.rpc("idx_apply_stats", {
    p_player: owner, p_games_played: 1, p_games_won: 1, p_total_wagered: 1e16, p_total_payouts: 0,
    p_biggest_win: 1e16, p_current_streak: 1, p_best_streak: 1000, p_last_played: new Date().toISOString(), p_event_slot: 1,
  });
  await m.points.awardPoints({ player: owner, sourceKey: sig(), source: "game_won", betLamports: 10_000_000n, edgeBps: 200 }); // 10
  m.lpPoints.resetLpPointsHour();
  const r = await lpRun(utcHour(6, 0), async () => ({
    positions: [lpPosition(user, 2n * LP_SOL)],
    totalUnits: 4n * LP_SOL,
    assets: 6n * LP_SOL, // unit value 1.5: 3 SOL -> 30 K Points
  }));
  assert.equal(r.points, "30");
  for (const view of ["alltime", "volume", "streak"]) {
    const res = await GET(new NextRequest(`http://test/api/leaderboard?view=${view}`));
    const { rows } = (await res.json()) as { rows: Array<{ player: string; kPoints: number }> };
    assert.equal(rows.find((x) => x.player === owner)?.kPoints, 40, view);
  }
});

test("admin backfill-points: current program only, missing rows only, idempotent", async () => {
  const { GET } = await import("../../app/api/admin/backfill-points/route");
  process.env.ADMIN_BACKFILL_SECRET = "test-backfill-secret";
  const call = async (qs = "", token = "test-backfill-secret") =>
    GET(new Request(`http://test/api/admin/backfill-points${qs}`, { headers: { authorization: `Bearer ${token}` } }) as never);
  const game = (signature: string, outcome: string, bet: number, slot: number) =>
    query(
      "insert into public.games (signature, game, player, bet, mine_count, outcome, commitment, slot) values ($1, $2, $3, $4, 3, $5, $6, $7)",
      [signature, pk().toBase58(), player, bet, outcome, "0".repeat(64), slot],
    );
  const player = pk().toBase58();
  const [won, lost, credited, old, expired] = [sig(), sig(), sig(), sig(), sig()];
  await game(won, "won", 10_000_000, 465_500_000);
  await game(lost, "lost", 5_000_000, 465_500_001);
  await game(credited, "won", 10_000_000, 465_500_002);
  await game(old, "won", 10_000_000, 400_000_000); // previous program
  await game(expired, "expired", 10_000_000, 465_500_003);
  await m.points.awardPoints({ player, sourceKey: credited, source: "game_won", betLamports: 10_000_000n, edgeBps: 200 });
  const ledger = (s: string) => query("select source, total_points from public.points_ledger where source_key = $1", [s]);

  assert.equal((await call("", "wrong")).status, 401);

  const dry = await (await call("?dry=1")).json();
  assert.deepEqual([dry.counts, dry.totals.totalPoints], [{ missing: 2, inserted: 0, notInserted: 0 }, "15"]);
  assert.deepEqual(await ledger(won), []);

  const run = await (await call()).json();
  assert.deepEqual(run.counts, { missing: 2, inserted: 2, notInserted: 0 });
  assert.deepEqual(await ledger(won), [{ source: "game_won", total_points: 10 }]);
  assert.deepEqual(await ledger(lost), [{ source: "game_lost", total_points: 5 }]);
  assert.deepEqual(await ledger(credited), [{ source: "game_won", total_points: 10 }]);
  assert.deepEqual(await ledger(old), []);
  assert.deepEqual(await ledger(expired), []);

  const again = await (await call()).json();
  assert.deepEqual(again.counts, { missing: 0, inserted: 0, notInserted: 0 });
});

test("vault unit-value snapshot is program-scoped; APY uses the reading's real age", async () => {
  const E18 = 10n ** 18n;
  // V2State: total_outstanding (u64) at 9, total_units (u128) at 17, total_pending (u128) at 89.
  const v2 = Buffer.alloc(8 + 200);
  accountDiscriminator("VaultV2State").copy(v2, 0);
  v2.writeBigUInt64LE(1_000_000_000n, 17);
  const conn = {
    getMultipleAccountsInfoAndContext: async () => ({
      context: { slot: 900_000_001 },
      value: [{ lamports: 1_002_824_480, data: Buffer.alloc(100) }, { lamports: 0, data: v2 }],
    }),
    getMinimumBalanceForRentExemption: async () => 2_824_480,
  } as unknown as Connection;
  assert.deepEqual(await m.history.snapshotVaultUnitValue(conn), { slot: 900_000_001, unitValueE18: E18.toString() });
  const [row] = await query("select program, vault_assets, health_bps from public.vault_unit_value_history where slot = 900_000_001");
  assert.deepEqual(row, { program: PROGRAM, vault_assets: 1_000_000_000, health_bps: 10_000 });

  // Back-date it 40 days; a newer reading from another program must be ignored.
  await query("update public.vault_unit_value_history set block_time = now() - interval '40 days' where slot = 900_000_001");
  await query(
    "insert into public.vault_unit_value_history (slot, program, vault_assets, total_units, unit_value_e18, health_bps, block_time) values (900_000_002, 'other', 1, 1, $1, 10000, now() - interval '31 days')",
    [(E18 / 2n).toString()],
  );
  const apy = await m.history.trailingApy((E18 * 101n) / 100n);
  assert.ok(apy !== null && Math.abs(apy - (1.01 ** (365 / 40) - 1)) < 1e-6, String(apy));
  // Nothing 30+ days old for this program: no number, rather than a wrong one.
  await query("delete from public.vault_unit_value_history where slot = 900_000_001");
  assert.equal(await m.history.trailingApy(E18), null);
});
