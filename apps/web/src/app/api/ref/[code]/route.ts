import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/server/api-helpers";
import { resolveAndCountVisit } from "@/server/referral-codes";
import {
  recordVisitClick,
  REF_CODE_COOKIE,
  REF_COOKIE_TTL_DAYS,
  REF_SESSION_COOKIE,
} from "@/server/referral-tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ code: string }>;
}

/**
 * Public code → wallet resolver. Three jobs in one request:
 *   1. Resolve <code> → wallet (or 404).
 *   2. Bump click_count (engagement metric on referral_codes).
 *   3. Record an attribution row in referral_visits + set the kb.ref.sid
 *      cookie so subsequent client calls can correlate this click to the
 *      eventual wallet signup and on-chain set_referrer.
 *
 * Cookie path is "/" so the session ID is visible on every page the
 * visitor lands on; the SameSite=Lax + 30-day TTL is appropriate for a
 * marketing attribution cookie (no auth tokens or secrets ride on it).
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { code } = await ctx.params;
    if (!/^[a-z2-9]{6}$/.test(code)) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }
    const row = await resolveAndCountVisit(code);
    if (!row) {
      return NextResponse.json({ error: "Unknown code" }, { status: 404 });
    }
    // Reuse an existing session cookie if the visitor came back via the
    // same code, so we don't fragment one user's funnel into multiple
    // visit rows. New session if none yet, or if the previous code differs.
    const existingSid = req.cookies.get(REF_SESSION_COOKIE)?.value;
    const existingCode = req.cookies.get(REF_CODE_COOKIE)?.value;
    let sessionId: string;
    if (existingSid && existingCode === code) {
      sessionId = existingSid;
      // No DB write — duplicate clicks within the cookie window don't
      // create new visit rows. They will, however, have already bumped
      // click_count via resolveAndCountVisit above.
    } else {
      ({ sessionId } = await recordVisitClick(code));
    }

    const res = NextResponse.json({ wallet: row.wallet });
    const maxAge = REF_COOKIE_TTL_DAYS * 24 * 60 * 60;
    res.cookies.set(REF_SESSION_COOKIE, sessionId, {
      maxAge,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      // NOT HttpOnly — client also reads this to detect "I came from a
      // ref link" without a server roundtrip on every page.
    });
    res.cookies.set(REF_CODE_COOKIE, code, {
      maxAge,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  } catch (err) {
    return jsonError(err);
  }
}
