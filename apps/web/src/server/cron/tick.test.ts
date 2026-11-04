/**
 * Cron tick scheduler against a real throwaway Postgres (advisory locks need
 * no tables):
 *
 *   createdb kaboom_rw_test
 *   DATABASE_URL=postgres:///kaboom_rw_test npm run test:db --workspace=@playkaboom/web
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { db } from "../db/pg";
import { assertTickLockHeld, resetCadence, runPasses, TICK_LOCK_KEY, withAdvisoryLock, type CronPass } from "./tick";

process.env.LOG_LEVEL ??= "silent";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => resetCadence());
after(async () => {
  await db().end();
});

test("overlapping ticks: the second finds the lock held and runs nothing", async () => {
  let runs = 0;
  const slow: CronPass = { name: "slow", everyMs: 0, run: async () => { runs++; await sleep(300); } };
  const [a, b] = await Promise.all([runPasses([slow]), sleep(50).then(() => runPasses([slow]))]);
  assert.equal(a.ran, true);
  assert.deepEqual(b, { ran: false });
  assert.equal(runs, 1);
  // Released afterwards: the next tick runs.
  assert.equal((await runPasses([slow])).ran, true);
  assert.equal(runs, 2);
});

test("another session holding the lock (other replica / manual run) blocks the tick", async () => {
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  try {
    await other.query("select pg_advisory_lock($1::bigint)", [TICK_LOCK_KEY]);
    let ran = false;
    assert.deepEqual(await withAdvisoryLock(TICK_LOCK_KEY, async () => { ran = true; }), { ran: false });
    assert.equal(ran, false);
    await other.query("select pg_advisory_unlock($1::bigint)", [TICK_LOCK_KEY]);
    assert.equal((await withAdvisoryLock(TICK_LOCK_KEY, async () => 7)).ran, true);
  } finally {
    await other.end();
  }
});

test("a throwing pass is reported, later passes still run, and the lock is released", async () => {
  const order: string[] = [];
  const r = await runPasses([
    { name: "boom", everyMs: 0, run: async () => { order.push("boom"); throw new Error("rpc down"); } },
    { name: "next", everyMs: 0, run: async () => { order.push("next"); return 1; } },
  ]);
  assert.ok(r.ran);
  assert.deepEqual(order, ["boom", "next"]);
  assert.equal(r.passes.boom?.status, "error");
  assert.equal((r.passes.boom as { error: string }).error, "rpc down");
  assert.equal(r.passes.next?.status, "ok");
  // No leaked lock: a different session can take it now.
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  const { rows } = await other.query("select pg_try_advisory_lock($1::bigint) as ok", [TICK_LOCK_KEY]);
  await other.end();
  assert.equal(rows[0].ok, true);
});

test("cadence: a pass runs again only after everyMs since its last success; a failure retries next tick", async () => {
  let ok = 0;
  let flaky = 0;
  const passes: CronPass[] = [
    { name: "every15m", everyMs: 15 * 60_000, run: async () => { ok++; } },
    { name: "flaky", everyMs: 15 * 60_000, run: async () => { flaky++; if (flaky === 1) throw new Error("x"); } },
  ];
  const t0 = 1_800_000_000_000;
  const r1 = await runPasses(passes, t0);
  const r2 = await runPasses(passes, t0 + 60_000);
  const r3 = await runPasses(passes, t0 + 15 * 60_000);
  assert.ok(r1.ran && r2.ran && r3.ran);
  assert.equal(r2.passes.every15m?.status, "not_due");
  assert.equal(r2.passes.flaky?.status, "ok", "failed pass retried on the next tick");
  assert.equal(r3.passes.every15m?.status, "ok");
  assert.equal(r3.passes.flaky?.status, "not_due", "cadence restarts from the retry's success");
  assert.equal(ok, 2);
  assert.equal(flaky, 2);
});

test("lock session killed mid-tick: house sends stop, later passes are skipped, no crash", async () => {
  await assertTickLockHeld(); // outside a lock: no-op
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  let afterKill = 0;
  try {
    const r = await runPasses([
      {
        name: "kill",
        everyMs: 0,
        run: async () => {
          await assertTickLockHeld(); // held: passes
          await other.query(
            "select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and objid = ($1::bigint & 4294967295)::oid",
            [TICK_LOCK_KEY],
          );
          await sleep(100);
          await assert.rejects(assertTickLockHeld(), /tick lock lost/);
        },
      },
      { name: "later", everyMs: 0, run: async () => { afterKill++; } },
    ]);
    assert.ok(r.ran);
    assert.equal(r.passes.kill?.status, "ok");
    assert.equal(r.passes.later?.status, "error");
    assert.equal(afterKill, 0);
    // The lock is free, and the pool still works for the next tick.
    assert.equal((await runPasses([{ name: "next", everyMs: 0, run: async () => 1 }])).ran, true);
  } finally {
    await other.end();
  }
});
