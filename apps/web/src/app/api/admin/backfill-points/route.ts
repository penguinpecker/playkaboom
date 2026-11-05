import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/server/api-helpers";
import { query } from "@/server/db/pg";
import { awardPoints, computePoints } from "@/server/points";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * K Points backfill for the CURRENT program. Awards points (via `awardPoints`,
 * the same formula as the live paths) for every settled `games` row — won or
 * lost, legacy or VRF — at or after the program's deploy slot that has NO
 * `points_ledger` row yet. Safe to call repeatedly: a re-run only sees rows
 * still missing, and the (source_key, source) unique index turns a race with
 * a live award into a no-op. Expired (legacy) rows earn nothing.
 *
 * Auth: `Authorization: Bearer ${ADMIN_BACKFILL_SECRET}` (CRON_SECRET still
 * accepted). Method: GET. `?dry=1` counts without inserting; `?limit=N`
 * bounds the run for a smoke test.
 *
 *   curl -H "Authorization: Bearer $ADMIN_BACKFILL_SECRET" \
 *        "https://playkaboom.gg/api/admin/backfill-points?dry=1"
 *
 * Multipliers stay at 1.0×. `games` does not store the edge, so rows get
 * `POINTS_EDGE_BPS` (the current program's vault edge, 200 = 2%).
 */
const POINTS_EDGE_BPS = 200;
/** Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju was deployed at this slot
 *  (2026-11-04); the previous program closed a month earlier, so every games
 *  row at or above it belongs to the current program. */
const CURRENT_PROGRAM_DEPLOY_SLOT = 465_253_927;
const PAGE = 500;

export async function GET(req: NextRequest) {
  try {
    // 2026-05-21: ADMIN_BACKFILL_SECRET is the per-purpose secret for this
    // endpoint; CRON_SECRET kept as a transitional fallback during rotation.
    const auth = req.headers.get("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const token = auth.slice(7);
    const accepted = [process.env.ADMIN_BACKFILL_SECRET, process.env.CRON_SECRET].filter(
      (s): s is string => Boolean(s),
    );
    if (accepted.length === 0 || !accepted.some((s) => s === token)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const limitParam = url.searchParams.get("limit");
    const hardLimit = limitParam ? Math.max(1, Number(limitParam)) : Infinity;

    let cursor = "";
    let missing = 0;
    let inserted = 0;
    let notInserted = 0;
    let totalPoints = 0n;
    const perPlayer = new Map<string, bigint>();

    while (missing < hardLimit) {
      // Keyset on the PK (stable while rows are written); the anti-join uses
      // the ledger's (source_key, source) unique index.
      const rows = await query<{ signature: string; player: string; bet: number; outcome: "won" | "lost" }>(
        `select g.signature, g.player, g.bet, g.outcome
           from public.games g
          where g.outcome in ('won', 'lost')
            and g.slot >= $1
            and g.signature > $2
            and not exists (
              select 1 from public.points_ledger pl
               where pl.source_key = g.signature
                 and pl.source = case g.outcome when 'won' then 'game_won' else 'game_lost' end)
          order by g.signature
          limit $3`,
        [CURRENT_PROGRAM_DEPLOY_SLOT, cursor, PAGE],
      );
      for (const r of rows) {
        if (missing >= hardLimit) break;
        missing++;
        cursor = r.signature;
        const betLamports = BigInt(r.bet);
        let pts: bigint;
        if (dry) {
          pts = computePoints({ betLamports, edgeBps: POINTS_EDGE_BPS }).totalPoints;
        } else {
          const result = await awardPoints({
            player: r.player,
            sourceKey: r.signature,
            source: r.outcome === "won" ? "game_won" : "game_lost",
            betLamports,
            edgeBps: POINTS_EDGE_BPS,
            notes: "retroactive backfill",
          });
          if (result.inserted) inserted++;
          else notInserted++; // raced a live award, or the insert failed (logged)
          pts = result.totalPoints;
        }
        totalPoints += pts;
        perPlayer.set(r.player, (perPlayer.get(r.player) ?? 0n) + pts);
      }
      if (rows.length < PAGE) break;
    }

    const top = [...perPlayer.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .slice(0, 10)
      .map(([player, pts]) => ({ player, points: pts.toString() }));

    logger.info(
      { missing, inserted, notInserted, dry, totalPoints: totalPoints.toString() },
      "points backfill complete",
    );
    return NextResponse.json({
      ok: true,
      dry,
      fromSlot: CURRENT_PROGRAM_DEPLOY_SLOT,
      counts: { missing, inserted, notInserted },
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
