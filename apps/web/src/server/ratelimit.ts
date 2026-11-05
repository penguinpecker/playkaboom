import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { logger } from "./logger";

const cachedLimiters = new Map<number, Ratelimit>();
let warned = false;

/**
 * Sliding-window limiter, 30 req / 10s per key. If Upstash isn't configured,
 * `enforceRateLimit` fails OPEN with a loud once-per-process warning. Rate
 * limiting here is defense-in-depth — the program itself enforces single-
 * game-per-player and bet caps, so a missing limiter doesn't open a payout
 * exploit. Two-step fail-closed plan tracked separately:
 *   1. Configure UPSTASH_REDIS_REST_URL/TOKEN in Vercel prod env
 *   2. Once configured, flip enforceRateLimit to fail-closed on Upstash
 *      call errors (not on env-missing).
 *
 * 2026-05-11 history: the original blanket fail-closed-on-missing-env logic
 * broke /api/commit in prod because Upstash isn't yet provisioned there.
 * Don't re-introduce without step 1 above.
 */
export function getLimiter(maxHits = MAX_HITS): Ratelimit | null {
  const cached = cachedLimiters.get(maxHits);
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!warned) {
      logger.warn(
        { env: process.env.VERCEL_ENV ?? process.env.NODE_ENV },
        "[ratelimit] Upstash not configured — fail-open. Provision UPSTASH_REDIS_REST_URL+TOKEN to enable.",
      );
      warned = true;
    }
    return null;
  }
  const limiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(maxHits, "10 s"),
    analytics: false,
    // Separate budgets must not share counters.
    prefix: maxHits === MAX_HITS ? "pk:rl" : `pk:rl${maxHits}`,
  });
  cachedLimiters.set(maxHits, limiter);
  return limiter;
}

/**
 * Per-instance fallback used ONLY when Upstash is unprovisioned.
 *
 * Serverless means many instances, so this is not a real distributed limiter —
 * an attacker spread across instances gets a multiple of the budget. It exists
 * because the alternative in production today is literally no limit at all:
 * `enforceRateLimit` returned {ok:true} unconditionally, so every call site —
 * including /api/reveal, which makes the HOUSE KEY sign a transaction per
 * request — was unthrottled. A loose ceiling per instance still turns an
 * unbounded flood into a bounded one.
 *
 * Bounded map: entries are evicted on read, and the map is cleared wholesale
 * if it ever grows past MAX_KEYS, so this cannot become a memory leak.
 */
const WINDOW_MS = 10_000;
const MAX_HITS = 30;
const MAX_KEYS = 10_000;
const localHits = new Map<string, number[]>();

function localLimit(key: string, cost: number, maxHits: number): { ok: boolean; remaining: number } {
  const now = Date.now();
  if (localHits.size > MAX_KEYS) localHits.clear();
  const hits = (localHits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length + cost > maxHits) {
    localHits.set(key, hits);
    return { ok: false, remaining: 0 };
  }
  for (let i = 0; i < cost; i++) hits.push(now);
  localHits.set(key, hits);
  return { ok: true, remaining: maxHits - hits.length };
}

/**
 * `cost` = how many hits this request spends (e.g. calls in a JSON-RPC batch).
 * `maxHits` = the key's budget per 10 s window (default 30; the browser's RPC
 * proxy needs more, see api/rpc/[cluster]). Keys are already route-prefixed.
 */
export async function enforceRateLimit(
  key: string,
  cost = 1,
  maxHits = MAX_HITS,
): Promise<{ ok: boolean; remaining: number }> {
  const limiter = getLimiter(maxHits);
  // Not configured: fall back to the in-process limiter rather than waving
  // every request through. Provisioning Upstash replaces this automatically.
  if (!limiter) return localLimit(key, cost, maxHits);
  try {
    const r = await limiter.limit(key, { rate: cost });
    return { ok: r.success, remaining: r.remaining };
  } catch (err) {
    // Upstash IS configured but the call failed (network, quota, auth).
    // Fail-closed here is meaningful — the operator chose to enable rate
    // limiting, so silently disabling it would defeat the configuration.
    logger.error(
      { err: err instanceof Error ? err.message : err, key: key.split(":")[0] },
      "[ratelimit] FAIL-CLOSED: Upstash configured but call failed",
    );
    return { ok: false, remaining: 0 };
  }
}
