import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which build is production actually serving right now.
 *
 * Exists because an open browser tab keeps the JavaScript chunks it loaded
 * indefinitely. Ship a client fix and every already-open tab carries on
 * running the broken code — the deploy is live, the bundle is correct, and the
 * player still hits the old bug. That happened repeatedly on 2026-07-30/31 and
 * cost hours of misdiagnosis: the reported symptom belonged to code that no
 * longer existed in production.
 *
 * On a real-money app that is worse than cosmetic. Stale client code can drive
 * transactions that the current program state rejects, or mishandle a game
 * whose recovery semantics changed — stranding a real bet.
 */
export async function GET() {
  return NextResponse.json(
    {
      // Vercel stamps this per deployment. Falls back to the Next build id so
      // this still works in local dev / self-hosted.
      buildId:
        process.env.VERCEL_DEPLOYMENT_ID ??
        process.env.NEXT_PUBLIC_BUILD_ID ??
        "dev",
    },
    { headers: { "cache-control": "no-store, must-revalidate" } },
  );
}
