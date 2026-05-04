import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { logger } from "./logger.js";

let cachedLimiter: Ratelimit | null = null;
let warned = false;

/**
 * Sliding-window limiter, 30 req / 10s per key. If Upstash isn't configured,
 * returns an always-allow shim and warns once. Rate limiting is a defense-in-depth
 * layer — the program itself enforces single-game-per-player and bet caps.
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

export async function enforceRateLimit(key: string): Promise<{ ok: boolean; remaining: number }> {
  const limiter = getLimiter();
  if (!limiter) return { ok: true, remaining: -1 };
  const r = await limiter.limit(key);
  return { ok: r.success, remaining: r.remaining };
}
