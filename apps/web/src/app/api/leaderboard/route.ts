import { NextResponse, type NextRequest } from "next/server";
import { supabasePublic } from "@/server/db/supabase";
import { jsonError } from "@/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 30;

/**
 * Indexer-backed leaderboard. Returns top 50 by the requested view.
 *
 *   GET /api/leaderboard?view=alltime   (default; sorted by biggest_win)
 *   GET /api/leaderboard?view=volume    (sorted by total_wagered)
 *   GET /api/leaderboard?view=streak    (sorted by best_streak)
 */
export async function GET(req: NextRequest) {
  try {
    const view = req.nextUrl.searchParams.get("view") ?? "alltime";
    const table =
      view === "volume"
        ? "leaderboard_volume"
        : view === "streak"
          ? "leaderboard_streaks"
          : "leaderboard_alltime";

    const db = supabasePublic();
    const { data, error } = await db.from(table).select("*").limit(50);
    if (error) throw error;

    return NextResponse.json({ view, rows: data ?? [] });
  } catch (err) {
    return jsonError(err);
  }
}
