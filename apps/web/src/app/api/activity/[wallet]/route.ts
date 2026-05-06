import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { jsonError } from "@/server/api-helpers";
import { supabasePublic } from "@/server/db/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ wallet: string }>;
}

/**
 * Unified activity feed: games + LP actions + referral events for a wallet.
 * Public — uses the public anon Supabase client (RLS allows reads). Sorted
 * newest first.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { wallet } = await ctx.params;
    try {
      new PublicKey(wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
    }
    const sb = supabasePublic();

    const limit = 50;
    const [games, lp, refClaims, refAccrued] = await Promise.all([
      sb
        .from("games")
        .select(
          "signature, outcome, bet, payout, multiplier_bps, mine_count, settled_at, slot",
        )
        .eq("player", wallet)
        .order("slot", { ascending: false })
        .limit(limit),
      sb
        .from("lp_actions")
        .select(
          "signature, action, units_delta, lamports_delta, unit_value_lamports, slot, block_time",
        )
        .eq("user_address", wallet)
        .order("slot", { ascending: false })
        .limit(limit),
      // referral payouts received by this wallet (as referrer)
      sb
        .from("referral_events")
        .select("signature, referrer, player, amount, tier, occurred_at, slot")
        .eq("referrer", wallet)
        .order("slot", { ascending: false })
        .limit(limit),
      // referral payouts the player triggered (volume credited to *their* referrer)
      sb
        .from("referral_events")
        .select("signature, referrer, player, amount, tier, occurred_at, slot")
        .eq("player", wallet)
        .order("slot", { ascending: false })
        .limit(limit),
    ]);

    const events: Array<{
      kind: "game" | "lp" | "ref_received" | "ref_paid";
      signature: string;
      slot: number;
      time: string | null;
      payload: Record<string, unknown>;
    }> = [];

    for (const g of games.data ?? []) {
      events.push({
        kind: "game",
        signature: g.signature,
        slot: g.slot,
        time: g.settled_at,
        payload: g,
      });
    }
    for (const a of lp.data ?? []) {
      events.push({
        kind: "lp",
        signature: a.signature,
        slot: a.slot,
        time: a.block_time,
        payload: a,
      });
    }
    for (const r of refClaims.data ?? []) {
      events.push({
        kind: "ref_received",
        signature: r.signature,
        slot: r.slot,
        time: r.occurred_at,
        payload: r,
      });
    }
    for (const r of refAccrued.data ?? []) {
      // Only include the "paid by me" record if it's NOT already in ref_received
      // (would be the same row when player == referrer, which can't happen due
      // to SelfReferral on chain — so dedupe is just defensive).
      if (!events.some((e) => e.signature === r.signature)) {
        events.push({
          kind: "ref_paid",
          signature: r.signature,
          slot: r.slot,
          time: r.occurred_at,
          payload: r,
        });
      }
    }

    events.sort((a, b) => b.slot - a.slot);
    return NextResponse.json({ wallet, events: events.slice(0, limit) });
  } catch (err) {
    return jsonError(err);
  }
}
