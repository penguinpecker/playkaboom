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
import { Keypair, PublicKey } from "@solana/web3.js";
import { eventDiscriminator } from "@playkaboom/sdk";
import pg from "pg";

const PROGRAM = "Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju";
process.env.PROGRAM_ID = PROGRAM;
process.env.SESSION_ENC_KEY = randomBytes(32).toString("hex");
process.env.SOLANA_RPC = "http://127.0.0.1:9"; // recordVrfGame's stats read fails fast (non-fatal)
process.env.LOG_LEVEL ??= "silent";

// Imported after the env above is set (the logger reads LOG_LEVEL at import).
let m: {
  pg: typeof import("./pg");
  indexer: typeof import("../indexer");
  points: typeof import("../points");
  codes: typeof import("../referral-codes");
  tracking: typeof import("../referral-tracking");
  sessions: typeof import("../session-store");
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

test("recordVrfGame upserts by signature (second write wins, no duplicate)", async () => {
  const base = {
    signature: sig(),
    gamePda: pk().toBase58(),
    player: pk().toBase58(),
    betLamports: 10n,
    payoutLamports: 20n,
    multiplierBps: 20_000,
    safeReveals: 2,
    mineCount: 3,
    won: true,
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
