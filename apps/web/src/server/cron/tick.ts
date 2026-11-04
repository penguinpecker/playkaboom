import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import { db } from "../db/pg";
import { logger } from "../logger";

/**
 * One scheduler for every house cron pass. The relay GETs /api/cron/tick every
 * 60 s (CRON_TICK_URL); each pass runs on its own cadence inside one Postgres
 * advisory lock, so ticks never overlap: a tick that finds the lock held
 * (previous tick still running, or another replica, or a manual call) returns
 * at once and changes nothing.
 */

/** pg advisory lock key for the tick ("kaboom" in ASCII). */
export const TICK_LOCK_KEY = "118066007469933";

type Held = { client: pg.PoolClient; lost: boolean };
const held = new AsyncLocalStorage<Held>();

/**
 * Run `fn` while holding session-level advisory lock `key` on one dedicated
 * connection. Returns `{ ran: false }` without calling `fn` if any other
 * session holds it. The lock is released even when `fn` throws; if the unlock
 * itself fails the connection is destroyed, which also releases it.
 *
 * If the lock's connection dies mid-run, Postgres frees the lock and the next
 * tick may start. `fn` is not killed, so every house send under it calls
 * assertTickLockHeld() first and stops instead of racing that tick.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await db().connect();
  const state: Held = { client, lost: false };
  // A checked-out pg client has no 'error' listener (the pool removes its own),
  // so without this a dropped lock connection would crash the process.
  const onLost = () => {
    state.lost = true;
  };
  client.on("error", onLost);
  client.on("end", onLost);
  let broken = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1::bigint) as ok", [key]);
    if (!rows[0]?.ok) return { ran: false };
    try {
      return { ran: true, value: await held.run(state, fn) };
    } finally {
      if (state.lost) broken = true;
      else
        await client.query("select pg_advisory_unlock($1::bigint)", [key]).catch(() => {
          broken = true;
        });
    }
  } finally {
    client.off("error", onLost);
    client.off("end", onLost);
    client.release(broken || state.lost);
  }
}

/**
 * Throws if the caller runs under withAdvisoryLock and that lock is gone (its
 * session ended). A no-op outside a lock (player-triggered routes). Checks the
 * session with a round-trip, so a silently dropped connection is caught too
 * (pool query_timeout bounds the wait).
 */
export async function assertTickLockHeld(): Promise<void> {
  const s = held.getStore();
  if (!s) return;
  if (!s.lost) await s.client.query("select 1").catch(() => (s.lost = true));
  if (s.lost) throw new Error("tick lock lost (its DB session ended); stopping house sends");
}

export interface CronPass {
  name: string;
  /** Minimum gap between successful runs; 0 = every tick. */
  everyMs: number;
  run: () => Promise<unknown>;
}

export type PassOutcome =
  | { status: "ok"; ms: number; result: unknown }
  | { status: "error"; ms: number; error: string }
  | { status: "not_due" };

// ponytail: last-run times live in process memory, so with more than one web
// replica a pass can run once per replica per cadence (all passes are
// idempotent, so that only costs RPC). Move them to a table if replicas > 1.
const lastOk = new Map<string, number>();

/**
 * Run each due pass in order under the tick lock. A failing pass is logged and
 * reported but never stops the passes after it; it is retried on the next tick.
 */
export async function runPasses(
  passes: CronPass[],
  now = Date.now(),
): Promise<{ ran: false } | { ran: true; passes: Record<string, PassOutcome> }> {
  const r = await withAdvisoryLock(TICK_LOCK_KEY, async () => {
    const out: Record<string, PassOutcome> = {};
    for (const p of passes) {
      try {
        await assertTickLockHeld();
      } catch (e) {
        out[p.name] = { status: "error", ms: 0, error: (e as Error).message };
        continue;
      }
      const last = lastOk.get(p.name);
      if (last !== undefined && now - last < p.everyMs) {
        out[p.name] = { status: "not_due" };
        continue;
      }
      const t0 = Date.now();
      try {
        const result = await p.run();
        lastOk.set(p.name, now);
        out[p.name] = { status: "ok", ms: Date.now() - t0, result };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        logger.error({ pass: p.name, err: error }, "cron pass failed");
        out[p.name] = { status: "error", ms: Date.now() - t0, error };
      }
    }
    return out;
  });
  return r.ran ? { ran: true, passes: r.value } : { ran: false };
}

/** Test hook: forget cadence state. */
export function resetCadence(): void {
  lastOk.clear();
}
