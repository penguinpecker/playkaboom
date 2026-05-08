import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/server/api-helpers";
import { supabaseAdmin } from "@/server/db/supabase";
import { awardPoints } from "@/server/points";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-shot retroactive XP backfill. Reads every settled `games` row and
 * upserts a corresponding `points_ledger` row via `awardPoints`. The
 * (source_key, source) unique constraint makes this safe to call repeatedly
 * — already-credited games are silently skipped.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (same pattern as the other
 * cron routes). Method: GET. Pass `?dry=1` to see counts without
 * inserting. Pass `?limit=N` to bound the run for a smoke test.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://playkaboom.gg/api/admin/backfill-points?dry=1
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://playkaboom.gg/api/admin/backfill-points
 *
 * Multipliers stay at 1.0× — historical games don't get LP/streak
 * boosts retroactively. The on-chain edge is captured per row from
 * `POINTS_EDGE_BPS` (currently 200 = 2%).
 */
const POINTS_EDGE_BPS = 200;
const PAGE = 500;

export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.get("authorization");
    if (!secret || auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const limitParam = url.searchParams.get("limit");
    const hardLimit = limitParam ? Math.max(1, Number(limitParam)) : Infinity;

    const db = supabaseAdmin();
    let offset = 0;
    let totalRows = 0;
    let inserted = 0;
    let skipped = 0;
    let expiredSkipped = 0;
    let totalPoints = 0n;
    const perPlayer = new Map<string, bigint>();

    for (;;) {
      if (totalRows >= hardLimit) break;
      const { data, error } = await db
        .from("games")
        .select("signature, player, bet, outcome, settled_at")
        .order("settled_at", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      if (rows.length === 0) break;

      for (const r of rows as Array<{
        signature: string;
        player: string;
        bet: number;
        outcome: "won" | "lost" | "expired";
        settled_at: string;
      }>) {
        if (totalRows >= hardLimit) break;
        totalRows++;
        if (r.outcome === "expired") {
          expiredSkipped++;
          continue;
        }
        const source = r.outcome === "won" ? "game_won" : "game_lost";
        if (dry) {
          // Recompute points client-side (without the upsert) just to
          // surface the numbers in the response.
          const bet = BigInt(r.bet);
          const base = (bet * BigInt(POINTS_EDGE_BPS)) / 200_000_000n;
          totalPoints += base;
          perPlayer.set(r.player, (perPlayer.get(r.player) ?? 0n) + base);
          continue;
        }
        const result = await awardPoints({
          player: r.player,
          sourceKey: r.signature,
          source,
          betLamports: BigInt(r.bet),
          edgeBps: POINTS_EDGE_BPS,
          notes: "retroactive backfill",
        });
        if (result.inserted) inserted++;
        else skipped++;
        totalPoints += result.totalPoints;
        perPlayer.set(
          r.player,
          (perPlayer.get(r.player) ?? 0n) + result.totalPoints,
        );
      }
      offset += PAGE;
      if (rows.length < PAGE) break;
    }

    const top = [...perPlayer.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .slice(0, 10)
      .map(([player, pts]) => ({ player, points: pts.toString() }));

    logger.info(
      { totalRows, inserted, skipped, expiredSkipped, dry, totalPoints: totalPoints.toString() },
      "points backfill complete",
    );
    return NextResponse.json({
      ok: true,
      dry,
      counts: {
        rowsScanned: totalRows,
        eligible: totalRows - expiredSkipped,
        expiredSkipped,
        inserted,
        skippedAlreadyCredited: skipped,
      },
      totals: {
        totalPoints: totalPoints.toString(),
        distinctPlayers: perPlayer.size,
      },
      top10: top,
    });
  } catch (err) {
    return jsonError(err);
  }
}
