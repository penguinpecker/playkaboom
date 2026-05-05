import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { ApiError } from "./api-helpers";

/**
 * Verifies an incoming webhook signature against a shared secret using
 * HMAC-SHA256. Constant-time comparison via `timingSafeEqual`.
 *
 * Helius enhanced webhooks sign the raw body with `X-Authorization-Header`
 * (a fixed string we set in the dashboard) — for that variant we just check
 * equality. For HMAC-style providers we recompute over the body.
 */
export async function verifyWebhookSignature(
  req: NextRequest,
  rawBody: string,
): Promise<void> {
  const secret = process.env.HELIUS_WEBHOOK_AUTH;
  if (!secret) {
    throw new ApiError(503, "Webhook secret not configured");
  }

  // Helius simple-auth path: the dashboard-set value is sent verbatim.
  const provided = req.headers.get("authorization") ?? req.headers.get("x-helius-signature");
  if (!provided) {
    throw new ApiError(401, "Missing webhook signature");
  }

  // Try literal match first (Helius default).
  if (constantTimeEqual(provided, secret)) return;

  // Fallback: treat header as hex-encoded HMAC over the raw body.
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (constantTimeEqual(provided, computed)) return;

  throw new ApiError(401, "Invalid webhook signature");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
