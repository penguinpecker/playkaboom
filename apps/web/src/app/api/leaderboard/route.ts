import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/server/db/pg";
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

    // `table` is one of three fixed view names above, never request text.
    const rows = await query(`select * from public.${table} limit 50`);

    return NextResponse.json({ view, rows });
  } catch (err) {
    return jsonError(err);
  }
}
