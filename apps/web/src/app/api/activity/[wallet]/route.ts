import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { jsonError } from "@/server/api-helpers";
import { query } from "@/server/db/pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Columns selected below; every list carries signature + slot and one time column.
type Row = {
  signature: string;
  slot: number;
  settled_at?: string | null;
  block_time?: string | null;
  occurred_at?: string | null;
  [col: string]: unknown;
};

interface RouteContext {
  params: Promise<{ wallet: string }>;
}

/**
 * Unified activity feed: games + LP actions + referral events for a wallet.
 * Public read through the server pool (the browser has no DB access). Sorted
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
    const limit = 50;
    // Each list degrades to empty on a query error, as it did with supabase-js.
    const rows = (sql: string) =>
      query<Row>(sql, [wallet, limit]).then(
        (data) => ({ data }),
        () => ({ data: [] as Row[] }),
      );
    const [games, lp, refClaims, refAccrued] = await Promise.all([
      rows(
        "select signature, outcome, bet, payout, multiplier_bps, mine_count, settled_at, slot from public.games where player = $1 order by slot desc limit $2",
      ),
      rows(
        "select signature, action, units_delta, lamports_delta, unit_value_lamports, slot, block_time from public.lp_actions where user_address = $1 order by slot desc limit $2",
      ),
      // referral payouts received by this wallet (as referrer)
      rows(
        "select signature, referrer, player, amount, tier, occurred_at, slot from public.referral_events where referrer = $1 order by slot desc limit $2",
      ),
      // referral payouts the player triggered (volume credited to *their* referrer)
      rows(
        "select signature, referrer, player, amount, tier, occurred_at, slot from public.referral_events where player = $1 order by slot desc limit $2",
      ),
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
        time: g.settled_at ?? null,
        payload: g,
      });
    }
    for (const a of lp.data ?? []) {
      events.push({
        kind: "lp",
        signature: a.signature,
        slot: a.slot,
        time: a.block_time ?? null,
        payload: a,
      });
    }
    for (const r of refClaims.data ?? []) {
      events.push({
        kind: "ref_received",
        signature: r.signature,
        slot: r.slot,
        time: r.occurred_at ?? null,
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
          time: r.occurred_at ?? null,
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
