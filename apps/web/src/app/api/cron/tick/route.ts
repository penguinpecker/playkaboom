import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { jsonError } from "@/server/api-helpers";
import { runPasses } from "@/server/cron/tick";
import { PASSES } from "@/server/cron/passes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_TICK_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !auth.startsWith("Bearer ")) return false;
  const a = Buffer.from(auth.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The single house cron entry point. The relay (kaboom-realtime) GETs this
 * every 60 s with `Authorization: Bearer $CRON_TICK_AUTH` (= CRON_TICK_SECRET).
 * Runs every due pass under one advisory lock (server/cron/tick.ts); a tick
 * that overlaps a running one returns { ran: false } at once.
 */
export async function GET(req: NextRequest) {
  try {
    if (!authorised(req)) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    return NextResponse.json(await runPasses(PASSES));
  } catch (err) {
    return jsonError(err);
  }
}
