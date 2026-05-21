import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { ApiError, clientIp, jsonError } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { enforceRateLimit } from "@/server/ratelimit";
import { getOrCreateCodeForWallet } from "@/server/referral-codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ wallet: string }>;
}

/**
 * Returns the short code for a wallet, minting a fresh one if this is
 * the wallet's first request. Authed: only the wallet's owner can claim
 * a code for their own wallet — this is the core of the tamper-resistance
 * guarantee. Without this check, anyone could re-claim a code for a
 * popular streamer's wallet and divert their referrals.
 *
 * Rate-limited per (wallet, ip) so a sybil farm (free Privy email logins)
 * can't iterate code-mint requests to pollute analytics counters or burn
 * Supabase quota. The shared `enforceRateLimit` helper currently fails
 * open until Upstash is provisioned in prod; once that lands this
 * becomes a real guard with no code change here.
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { wallet } = await ctx.params;
    try {
      new PublicKey(wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
    }
    const [, rl] = await Promise.all([
      verifyPlayerAuth(req, wallet),
      enforceRateLimit(`ref:code:${clientIp(req)}:${wallet}`),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");
    const row = await getOrCreateCodeForWallet(wallet);
    return NextResponse.json({
      code: row.code,
      wallet: row.wallet,
      url: `/r/${row.code}`,
      clickCount: row.click_count,
      // Funnel: clicks → signups (wallet connected) → confirmed (set_referrer
      // landed on-chain). Both are 0 until backfilled by future visits.
      signupCount: row.signup_count ?? 0,
      confirmedCount: row.confirmed_count ?? 0,
      lastVisitedAt: row.last_visited_at,
    });
  } catch (err) {
    return jsonError(err);
  }
}
