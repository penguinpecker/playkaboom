import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/server/api-helpers";
import { resolveAndCountVisit } from "@/server/referral-codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ code: string }>;
}

/**
 * Public code → wallet resolver. Used by /r/<code> on the client to
 * convert the visited short link into the wallet that gets credited as
 * the referrer. Increments the click counter as a side effect.
 *
 * Returns 404 (not 200 with null) so the client can branch cleanly.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { code } = await ctx.params;
    if (!/^[a-z2-9]{6}$/.test(code)) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }
    const row = await resolveAndCountVisit(code);
    if (!row) {
      return NextResponse.json({ error: "Unknown code" }, { status: 404 });
    }
    return NextResponse.json({ wallet: row.wallet });
  } catch (err) {
    return jsonError(err);
  }
}
