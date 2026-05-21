import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { indexFreshSignature } from "@/server/inline-ingest";
import { jsonError } from "@/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_096;

export async function POST(req: NextRequest) {
  try {
    if (!authorise(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const cl = parseInt(req.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    const body = (await req.json().catch(() => null)) as { signature?: unknown } | null;
    const sig = body?.signature;
    if (typeof sig !== "string" || sig.length < 64 || sig.length > 130) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
    // Fire-and-forget so the Railway WS subscriber can immediately move on
    // to the next event. indexFreshSignature is idempotent via
    // processed_events dedup, and the 60s cron poll catches anything that
    // fails the inline RPC fetch.
    void indexFreshSignature(sig);
    return NextResponse.json({ ok: true, accepted: sig });
  } catch (err) {
    return jsonError(err);
  }
}

function authorise(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : auth;
  // 2026-05-21: INGEST_SECRET is the per-purpose secret for the Railway push
  // ingest path; CRON_SECRET + HELIUS_WEBHOOK_AUTH kept as transitional
  // fallbacks during rotation. Remove the legacy entries once Railway env
  // (CRON_TICK_AUTH) is updated to the new INGEST_SECRET value.
  const accepted = [
    process.env.INGEST_SECRET,
    process.env.CRON_SECRET,
    process.env.HELIUS_WEBHOOK_AUTH,
  ].filter((s): s is string => Boolean(s));
  return accepted.some((s) => safeEqual(s, token));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
