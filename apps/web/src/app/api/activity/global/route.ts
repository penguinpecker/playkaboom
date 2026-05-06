import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/server/api-helpers";
import { supabasePublic } from "@/server/db/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Global live-feed of recent settled games across every player. Powers
 * the Stake-style ticker under the grid + on the home page. Public — no
 * auth, RLS handles the read scoping.
 *
 * Returns the most recent ~30 settled rows. Caller can paginate via
 * ?before=<slot> when we add infinite scroll later (not wired yet).
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
    const sb = supabasePublic();
    const { data, error } = await sb
      .from("games")
      .select(
        "signature, player, outcome, bet, payout, multiplier_bps, mine_count, settled_at, slot",
      )
      .order("slot", { ascending: false })
      .limit(limit);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      events: (data ?? []).map((g) => ({
        signature: g.signature,
        player: g.player,
        outcome: g.outcome, // "won" | "lost"
        bet: g.bet?.toString() ?? "0",
        payout: g.payout?.toString() ?? "0",
        multiplierBps: g.multiplier_bps ?? 0,
        mineCount: g.mine_count ?? 0,
        time: g.settled_at,
        slot: g.slot,
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
