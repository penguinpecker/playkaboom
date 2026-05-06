import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { ApiError, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { recordSetReferrerConfirmation } from "@/server/referral-tracking";

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
  signature: z.string().min(43).max(128),
});

/**
 * Called by the client after a set_referrer tx confirms on-chain. Tags
 * the latest unconfirmed visit row for this wallet with the tx
 * signature + bumps confirmed_count on referral_codes. Provides the
 * "click → signup → confirmed" three-stage funnel attribution.
 *
 * Authed — only the wallet's owner can claim a confirmation, otherwise
 * anyone could call this with someone else's wallet to inflate someone's
 * confirmed_count.
 *
 * If there's no visit row for this wallet (e.g. they came in via
 * the legacy ?ref=<wallet> form), we silently no-op — the on-chain
 * set_referrer is what actually matters; this is just analytics.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, Body);
    await verifyPlayerAuth(req, body.wallet);
    const ok = await recordSetReferrerConfirmation(body.wallet, body.signature);
    return NextResponse.json({ attributed: ok });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return jsonError(err);
  }
}
