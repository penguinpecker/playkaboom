import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { ApiError, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { recordSignup, REF_SESSION_COOKIE } from "@/server/referral-tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  wallet: z.string().refine((v) => {
    try {
      new PublicKey(v);
      return true;
    } catch {
      return false;
    }
  }, "Invalid wallet"),
});

/**
 * Called by the client the first time a wallet is connected on a browser
 * that has a kb.ref.sid cookie. Attributes that cookie's visit row to
 * this wallet and bumps signup_count on the referral_codes row.
 *
 * Idempotent — a second call with the same (session, wallet) pair returns
 * 200 ok without bumping the counter. Safe to call on every wallet
 * connect; the server-side visit table handles dedupe.
 *
 * Authed — only the wallet's owner can claim a signup for that wallet,
 * so a bot can't fake conversion data for other people's codes.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, Body);
    await verifyPlayerAuth(req, body.wallet);

    const sessionId = req.cookies.get(REF_SESSION_COOKIE)?.value;
    if (!sessionId) {
      // No referral cookie → wallet didn't come in via /r/<code>. Not an
      // error, just nothing to attribute.
      return NextResponse.json({ attributed: false, reason: "no_session" });
    }
    const ok = await recordSignup(sessionId, body.wallet);
    return NextResponse.json({ attributed: ok });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return jsonError(err);
  }
}
