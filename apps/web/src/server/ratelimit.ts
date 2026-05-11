import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { logger } from "./logger";

let cachedLimiter: Ratelimit | null = null;
let warned = false;

/**
 * Sliding-window limiter, 30 req / 10s per key. If Upstash isn't configured:
 * - In production (NODE_ENV=production OR VERCEL_ENV=production): returns null,
 *   and `enforceRateLimit` will FAIL CLOSED (return ok:false). Rationale: a
 *   misconfigured Upstash in prod is more dangerous than a request being
 *   blocked — abuse vectors that rely on volume become free.
 * - In dev/preview: returns null with a one-time warn, and `enforceRateLimit`
 *   fails open. Keeps the local DX painless when Upstash isn't bootstrapped.
 *
 * The program itself still enforces single-game-per-player and bet caps; this
 * is one of multiple defense layers, but it's a meaningful one for /api/commit
 * burst protection.
 */
export function getLimiter(): Ratelimit | null {
  if (cachedLimiter) return cachedLimiter;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!warned) {
      logger.warn("Upstash Redis not configured — rate limiting disabled");
      warned = true;
    }
    return null;
  }
  cachedLimiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(30, "10 s"),
    analytics: false,
    prefix: "pk:rl",
  });
  return cachedLimiter;
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

export async function enforceRateLimit(key: string): Promise<{ ok: boolean; remaining: number }> {
  const limiter = getLimiter();
  if (!limiter) {
    // Fail closed in prod, fail open elsewhere.
    if (isProd()) {
      logger.error("[ratelimit] FAIL-CLOSED: Upstash unavailable in production");
      return { ok: false, remaining: 0 };
    }
    return { ok: true, remaining: -1 };
  }
  const r = await limiter.limit(key);
  return { ok: r.success, remaining: r.remaining };
}
