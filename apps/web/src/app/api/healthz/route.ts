import { NextResponse } from "next/server";
import { query } from "@/server/db/pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Railway healthcheck (apps/web/railway.json). 200 once the server serves and
 * DATABASE_URL reaches Postgres; 503 otherwise, so a deploy with a bad
 * DATABASE_URL never takes traffic. No RPC call: a slow Solana RPC must not
 * fail a deploy (/api/health and /api/status cover the chain side).
 */
export async function GET() {
  try {
    await query("select 1");
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
