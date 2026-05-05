import { NextResponse, type NextRequest } from "next/server";
import { supabasePublic } from "@/server/db/supabase";
import { jsonError } from "@/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/verify?sig=<signature>
 * Returns the indexed game row + everything needed for browser-side
 * SHA-256 verification (commitment, mine_count, mine_layout, salt).
 */
export async function GET(req: NextRequest) {
  try {
    const sig = req.nextUrl.searchParams.get("sig");
    if (!sig) {
      return NextResponse.json({ error: "Missing sig" }, { status: 400 });
    }
    const db = supabasePublic();
    const { data, error } = await db
      .from("games")
      .select(
        "signature, player, bet, mine_count, outcome, payout, multiplier_bps, safe_reveals, mine_layout, settled_layout, commitment, salt, settled_at, slot",
      )
      .eq("signature", sig)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ found: false });
    }
    return NextResponse.json({ found: true, game: data });
  } catch (err) {
    return jsonError(err);
  }
}
