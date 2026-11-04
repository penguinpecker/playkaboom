import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import type { ZodSchema } from "zod";
import { logger } from "./logger";
import { extractKaboomError } from "@playkaboom/sdk";
import { isDbError } from "./db/pg";

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ApiError(400, issues);
  }
  return parsed.data;
}

export class ApiError extends Error {
  status: number;
  meta?: Record<string, unknown>;
  constructor(status: number, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.meta = meta;
  }
}

/**
 * The caller's IP, for rate-limit keys. Behind the Vercel frontend proxy
 * (src/middleware.ts) X-Forwarded-For holds Vercel's egress IP, so the
 * player's IP comes from x-kaboom-client-ip — trusted only when the request
 * also carries the shared KABOOM_PROXY_SECRET, so a direct caller can't pick
 * its own bucket.
 */
export function clientIp(req: Request): string {
  const secret = process.env.KABOOM_PROXY_SECRET;
  const sent = req.headers.get("x-kaboom-proxy-secret");
  const proxied = req.headers.get("x-kaboom-client-ip")?.trim();
  if (secret && sent && proxied && isIP(proxied)) {
    const a = Buffer.from(sent);
    const b = Buffer.from(secret);
    if (a.length === b.length && timingSafeEqual(a, b)) return proxied;
  }
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function jsonError(err: unknown, fallback = "Server error") {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message, ...(err.meta ?? {}) }, { status: err.status });
  }
  const programError = extractKaboomError(err);
  if (programError) {
    return NextResponse.json({ error: programError, kind: "program" }, { status: 400 });
  }
  // DB errors can name the private host/IP and DB user: log them, return the fallback.
  const message = err instanceof Error && !isDbError(err) ? err.message : fallback;
  logger.error({ err }, "unhandled api error");
  return NextResponse.json({ error: message }, { status: 500 });
}
