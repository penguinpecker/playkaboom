/* eslint-disable no-console */
/**
 * Retroactively credit XP for every game already in the `games` indexer
 * table. Uses the same `awardPoints` helper as the live indexer, so the
 * formula stays in lockstep and the (source_key, source) unique index
 * keeps re-runs idempotent.
 *
 * Run:
 *   pnpm tsx scripts/backfill-points.ts                # dry-run
 *   pnpm tsx scripts/backfill-points.ts --apply       # actually insert
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env (root .env.local
 * via dotenv). Pulls every row from `games`, computes the same base/total
 * points the live path would, upserts into `points_ledger`. Multipliers
 * stay at 1.0× — historical games don't get LP/streak boosts retroactively.
 */
import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

// Inlined from apps/web/src/server/points.ts — that module imports
// "server-only" which can't load in a tsx script context. Keep this in
// sync with the canonical implementation; both sides have the same
// constants so a divergence is caught by the unique (source_key, source)
// idempotency check.
const BASE_DIVISOR = 200_000_000n;
const MAX_TIER_MULT_BPS = 15_000;
const MAX_STREAK_MULT_BPS = 12_500;
const MAX_EVENT_MULT_BPS = 30_000;
function clampMult(v: number, max: number): number {
  if (!Number.isFinite(v) || v < 10_000) return 10_000;
  return Math.min(max, Math.floor(v));
}
function computePoints(args: {
  betLamports: bigint;
  edgeBps: number;
  tierMultBps?: number;
  streakMultBps?: number;
  eventMultBps?: number;
}): { basePoints: bigint; totalPoints: bigint } {
  if (args.betLamports <= 0n || args.edgeBps <= 0) {
    return { basePoints: 0n, totalPoints: 0n };
  }
  const tier = clampMult(args.tierMultBps ?? 10_000, MAX_TIER_MULT_BPS);
  const streak = clampMult(args.streakMultBps ?? 10_000, MAX_STREAK_MULT_BPS);
  const event = clampMult(args.eventMultBps ?? 10_000, MAX_EVENT_MULT_BPS);
  const basePoints = (args.betLamports * BigInt(args.edgeBps)) / BASE_DIVISOR;
  const totalPoints =
    (basePoints * BigInt(tier) * BigInt(streak) * BigInt(event)) /
    1_000_000_000_000n;
  return { basePoints, totalPoints };
}

dotenvConfig({ path: resolve(process.cwd(), ".env.local") });
dotenvConfig({ path: resolve(process.cwd(), "apps/web/.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APPLY = process.argv.includes("--apply");
const POINTS_EDGE_BPS = 200; // matches indexer.ts and current on-chain edge

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  console.error("Pull them with: vercel env pull apps/web/.env.local");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

interface GameRow {
  signature: string;
  player: string;
  bet: number;
  outcome: "won" | "lost" | "expired";
  settled_at: string;
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (writes will land)" : "DRY-RUN (no writes)"}`);
  console.log("");

  // Stream in pages to handle eventual large volumes without loading all
  // games into memory.
  const PAGE = 500;
  let offset = 0;
  let totalRows = 0;
  let totalInserted = 0;
  let totalSkippedExpired = 0;
  let totalPointsAwarded = 0n;
  const perPlayer = new Map<string, bigint>();

  for (;;) {
    const { data, error } = await db
      .from("games")
      .select("signature, player, bet, outcome, settled_at")
      .order("settled_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error("Read error:", error);
      process.exit(1);
    }
    const rows = (data ?? []) as GameRow[];
    if (rows.length === 0) break;

    for (const r of rows) {
      totalRows++;
      // Skip 'expired' — these were refunded to the player, the protocol
      // didn't actually capture the edge. Awarding XP would be misleading.
      if (r.outcome === "expired") {
        totalSkippedExpired++;
        continue;
      }
      const source = r.outcome === "won" ? "game_won" : "game_lost";
      const { basePoints, totalPoints } = computePoints({
        betLamports: BigInt(r.bet),
        edgeBps: POINTS_EDGE_BPS,
      });
      perPlayer.set(r.player, (perPlayer.get(r.player) ?? 0n) + totalPoints);
      totalPointsAwarded += totalPoints;

      if (!APPLY) continue;

      // Use the row's settled_at as the points created_at so the
      // historical ledger reads chronologically without a separate
      // backfill timestamp column.
      const { error: insErr } = await db.from("points_ledger").upsert(
        {
          player: r.player,
          source_key: r.signature,
          source,
          base_points: basePoints.toString(),
          tier_mult_bps: 10000,
          streak_mult_bps: 10000,
          event_mult_bps: 10000,
          total_points: totalPoints.toString(),
          bet_lamports: r.bet.toString(),
          edge_bps: POINTS_EDGE_BPS,
          notes: "retroactive backfill 2026-05-08",
          created_at: r.settled_at,
        },
        { onConflict: "source_key,source", ignoreDuplicates: true },
      );
      if (insErr) {
        console.error(`  ! ${r.signature.slice(0, 8)} insert failed:`, insErr.message);
      } else {
        totalInserted++;
      }
    }
    offset += PAGE;
    if (rows.length < PAGE) break;
  }

  console.log(`\nTotals (computed from ${totalRows} rows):`);
  console.log(`  Skipped (expired)    : ${totalSkippedExpired}`);
  console.log(`  Eligible             : ${totalRows - totalSkippedExpired}`);
  console.log(`  Total points         : ${totalPointsAwarded.toString()}`);
  console.log(`  Distinct players     : ${perPlayer.size}`);
  console.log(`  Apply mode insertions: ${APPLY ? totalInserted : "(dry-run)"}`);
  console.log("");
  console.log("Top 10 players by retroactive points:");
  const sorted = [...perPlayer.entries()].sort((a, b) =>
    b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
  );
  for (const [p, pts] of sorted.slice(0, 10)) {
    console.log(`  ${p}  →  ${pts.toString()} pts`);
  }

  if (!APPLY) {
    console.log("\n(Dry-run only — re-run with --apply to write rows.)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
