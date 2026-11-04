#!/usr/bin/env node
// Exercises every function in db/migrations once with representative args and
// checks the pg_notify relay contract. WRITES ROWS: run only against a freshly
// migrated throwaway DB (refuses if public.games already has rows).
// Usage: DATABASE_URL=postgres:///kaboom_rw_test?host=/tmp node db/selftest.mjs
import assert from "node:assert/strict";
import pg from "pg";

const url = process.env.DATABASE_URL;
const db = new pg.Client({ connectionString: url });
const listener = new pg.Client({ connectionString: url });
await db.connect();
await listener.connect();
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];

assert.equal(Number((await one("select count(*) n from public.games")).n), 0, "games not empty: refusing");

const P = "Player1111111111111111111111111111111111111";
const R = "Referrer111111111111111111111111111111111111";
const sig = (c) => c.repeat(88);
const T = "2026-11-04T00:00:00Z";

// ── idx_apply_stats: slot-monotonic snapshot; GREATEST on bests; touch_updated_at
await db.query("select public.idx_apply_stats($1,10,4,1000,900,300,2,3,$2,100)", [P, T]);
const s1 = await one("select * from public.player_stats where player=$1", [P]);
await db.query("select public.idx_apply_stats($1,99,9,1,1,1,0,0,$2,50)", [P, T]); // older slot: no-op
assert.equal(Number((await one("select games_played from public.player_stats where player=$1", [P])).games_played), 10);
await db.query("select public.idx_apply_stats($1,11,4,1100,900,100,0,1,$2,101)", [P, T]);
const s2 = await one("select * from public.player_stats where player=$1", [P]);
assert.equal(Number(s2.games_played), 11);
assert.equal(Number(s2.biggest_win), 300, "biggest_win keeps GREATEST");
assert.equal(s2.best_streak, 3, "best_streak keeps GREATEST");
assert.ok(s2.updated_at > s1.updated_at, "touch_updated_at fired");

// ── idx_apply_referrer_set: write-once
await db.query("select public.idx_apply_referrer_set($1,$2)", [P, R]);
await db.query("select public.idx_apply_referrer_set($1,'Other')", [P]);
assert.equal((await one("select referrer from public.player_stats where player=$1", [P])).referrer, R);

// ── referral rollup: recompute from referral_events (idempotent), claim, tier
await db.query("insert into public.referral_events values ($1,$2,$3,500,0,now(),200),($4,$2,$3,600,1,now(),201)", [sig("a"), R, P, sig("b")]);
await db.query("select public.idx_apply_referral_accrued($1,500,0,200)", [R]);
await db.query("select public.idx_apply_referral_accrued($1,600,1,201)", [R]);
await db.query("select public.idx_apply_referral_accrued($1,600,1,201)", [R]); // replay
let r = await one("select * from public.referrals where referrer=$1", [R]);
assert.equal(Number(r.total_earned), 1100);
assert.equal(Number(r.accrued_lamports), 1100);
assert.equal(Number(r.referred_volume), 200000, "500*10000/50 + 600*10000/60");
await db.query("select public.idx_apply_referral_claimed($1,400,202)", [R]);
await db.query("select public.idx_apply_referral_claimed($1,400,202)", [R]); // same slot replay: no-op
assert.equal(Number((await one("select accrued_lamports a from public.referrals where referrer=$1", [R])).a), 700);
await db.query("select public.idx_apply_referral_accrued($1,600,1,203)", [R]);
assert.equal(Number((await one("select accrued_lamports a from public.referrals where referrer=$1", [R])).a), 700, "claim preserved across recompute");
await db.query("select public.idx_apply_referral_tier($1,2,204)", [R]);
await db.query("select public.idx_apply_referral_tier($1,0,150)", [R]); // older: no-op
assert.equal((await one("select tier from public.referrals where referrer=$1", [R])).tier, 2);

// ── LP: deposit / request / cancel / complete, slot guards + GREATEST(0) clamps
await db.query("select public.idx_apply_lp_deposit($1,1000,5000,$2,300)", [P, T]);
await db.query("select public.idx_apply_lp_deposit($1,1000,5000,$2,300)", [P, T]); // replay: no-op
await db.query("select public.idx_apply_lp_request($1,400,999,$2,301)", [P, T]);
await db.query("select public.idx_apply_lp_cancel($1,100,$2,302)", [P, T]);
await db.query("select public.idx_apply_lp_complete($1,900,2500,$2,303)", [P, T]); // burns > pending: clamps
let lp = await one("select * from public.lp_positions where user_address=$1", [P]);
assert.equal(Number(lp.units), 700);
assert.equal(Number(lp.pending_units), 0, "clamped at 0");
assert.equal(Number(lp.cumulative_deposited), 5000);
assert.equal(Number(lp.cumulative_withdrawn), 2500);
assert.equal(Number(lp.pending_unlock_slot), 0);

// ── games + idx_apply_game_settled + pg_notify relay contract
const notes = [];
listener.on("notification", (m) => notes.push(m));
await listener.query("listen kaboom_events");
const G = "GamePda111111111111111111111111111111111111";
await db.query(
  `insert into public.games (signature,player,bet,mine_count,outcome,payout,multiplier_bps,safe_reveals,commitment,slot,game)
   values ($1,$2,1000,0,'won',2000,20000,3,repeat('0',64),400,$3),
          ($4,$2,1000,0,'lost',0,0,1,repeat('0',64),390,$3)`,
  [sig("c"), P, G, sig("d")],
);
const settled = await one("select public.idx_apply_game_settled($1,7,3,$2,$3,$4,401) n", [G, "ab".repeat(32), "cd".repeat(32), sig("e")]);
assert.equal(settled.n, 1, "settles exactly the newest unsettled row");
const again = await one("select public.idx_apply_game_settled($1,7,3,$2,$3,$4,401) n", [G, "ab".repeat(32), "cd".repeat(32), sig("e")]);
assert.equal(again.n, 0, "older stranded row is cut off by last settled slot");
const g = await one("select * from public.games where signature=$1", [sig("c")]);
assert.equal(g.mine_layout, 7);
assert.equal(g.settle_signature, sig("e"));

await new Promise((res) => setTimeout(res, 300));
assert.equal(notes.length, 3, "2 INSERT + 1 UPDATE");
const msgs = notes.map((n) => (assert.equal(n.channel, "kaboom_events"), JSON.parse(n.payload)));
assert.deepEqual(msgs.map((m) => m.op), ["INSERT", "INSERT", "UPDATE"]);
const allow = ["bet", "game", "mine_count", "multiplier_bps", "outcome", "payout", "player", "safe_reveals", "settle_signature", "settled_at", "signature", "slot"];
for (const m of msgs) {
  assert.equal(m.table, "games");
  assert.deepEqual(Object.keys(m.row).sort(), allow, "row is the closed allowlist (no salt/mine_layout)");
}
assert.equal(msgs[2].row.settle_signature, sig("e"));
assert.equal(typeof msgs[2].row.bet, "number");

// ── views
await db.query(
  "insert into public.points_ledger (player,source_key,source,base_points,total_points) values ($1,$2,'game_won',10,12)",
  [P, sig("c")],
);
assert.equal(Number((await one("select points from public.points_balance where player=$1", [P])).points), 12);
assert.equal(Number((await one("select biggest_loss from public.leaderboard_alltime where player=$1", [P])).biggest_loss), 1000);
await db.query("select * from public.leaderboard_volume");
await db.query("select * from public.leaderboard_streaks");

// ── referral_codes / visits constraints, cron seed
await db.query("insert into public.referral_codes (code,wallet) values ('abc234',$1)", [P]);
await db.query("insert into public.referral_visits (code,session_id) values ('abc234',$1)", ["s".repeat(32)]);
await assert.rejects(db.query("insert into public.referral_codes (code,wallet) values ('ilou00','x')"));
assert.equal((await one("select program from public.cron_indexer_state")).program, "kaboom");

await listener.end();
await db.end();
console.log("selftest OK: all 12 functions + 4 views + notify contract");
