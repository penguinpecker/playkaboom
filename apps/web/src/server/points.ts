import "server-only";
import { supabaseAdmin } from "./db/supabase";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// PlayKaboom XP / loyalty engine.
//
// Formula (BC.Game-style, edge-weighted; see migration 20260508000001):
//
//   base_points  = bet_lamports * edge_bps / 200_000_000
//                  → 1 SOL @ 2% edge = 1000 base points
//                  → 0.001 SOL @ 2%  = 1 base point  (smallest meaningful)
//
//   total_points = round( base_points * tier_mult * streak_mult * event_mult )
//
// All multipliers are stored as bps (10000 = 1.0×). On insert we capture the
// inputs (bet_lamports, edge_bps, every multiplier) so the row remains
// auditable even after the formula evolves.
//
// IMPORTANT: this module is purely server-side. There is intentionally no
// `getPointsForPlayer` export yet — the user has asked us to accumulate
// silently and not expose a frontend surface. When that changes, add a
// thin reader here that queries the `points_balance` view.
// ─────────────────────────────────────────────────────────────────────────────

/** Divisor that yields 1000 base points for 1 SOL wagered at 2% edge.
 *  i.e. (1e9 lamports) × (200 bps) / 200_000_000 = 1000. */
const BASE_DIVISOR = 200_000_000n;

/** Multiplier ceilings — protect against bug/farm in the multiplier feeders. */
const MAX_TIER_MULT_BPS = 15_000;   // +50% (LP boost cap)
const MAX_STREAK_MULT_BPS = 12_500; // +25% (5-day streak cap)
const MAX_EVENT_MULT_BPS = 30_000;  // +200% (operator can run 3× promos)

export type PointsSource =
  | "game_won"
  | "game_lost"
  | "streak_bonus"
  | "race_payout"
  | "referral"
  | "manual_adjust";

export interface AwardPointsInput {
  player: string;
  /** Idempotency key. For game-derived rows: the kaboom-program tx signature.
   *  For synthetic rows: e.g. `streak:<player>:<yyyy-mm-dd>`. */
  sourceKey: string;
  source: PointsSource;
  betLamports: bigint;
  /** house_edge_bps as set on the vault at the time of the wager (200 = 2%).
   *  Captured here rather than read live so historical points stay correct
   *  if the on-chain edge changes later. */
  edgeBps: number;
  /** All multipliers default to 1.0× (10000 bps). Pass values >10000 to add
   *  bonuses, never <10000 (use a smaller base instead). */
  tierMultBps?: number;
  streakMultBps?: number;
  eventMultBps?: number;
  signer?: string | null;
  notes?: string | null;
}

export interface AwardResult {
  basePoints: bigint;
  totalPoints: bigint;
  /** True if the row landed; false if the (sourceKey, source) tuple was
   *  already present (idempotent skip). */
  inserted: boolean;
}

/** Pure: compute base + total points. Exposed for tests and the backfill
 *  script so they don't have to reach into Supabase. */
export function computePoints(args: {
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
  // bps × bps × bps means we divide by 10000^3 = 1e12 at the end.
  const totalScaled =
    basePoints * BigInt(tier) * BigInt(streak) * BigInt(event);
  const totalPoints = totalScaled / 1_000_000_000_000n;
  return { basePoints, totalPoints };
}

function clampMult(v: number, max: number): number {
  if (!Number.isFinite(v) || v < 10_000) return 10_000;
  return Math.min(max, Math.floor(v));
}

/** Insert a points row. Idempotent on (sourceKey, source) — safe to call
 *  multiple times for the same event (indexer replay, backfill re-runs). */
export async function awardPoints(args: AwardPointsInput): Promise<AwardResult> {
  const { basePoints, totalPoints } = computePoints({
    betLamports: args.betLamports,
    edgeBps: args.edgeBps,
    tierMultBps: args.tierMultBps,
    streakMultBps: args.streakMultBps,
    eventMultBps: args.eventMultBps,
  });

  const db = supabaseAdmin();
  const { error, data } = await db
    .from("points_ledger")
    .upsert(
      {
        player: args.player,
        source_key: args.sourceKey,
        source: args.source,
        base_points: basePoints.toString(),
        tier_mult_bps: clampMult(args.tierMultBps ?? 10_000, MAX_TIER_MULT_BPS),
        streak_mult_bps: clampMult(args.streakMultBps ?? 10_000, MAX_STREAK_MULT_BPS),
        event_mult_bps: clampMult(args.eventMultBps ?? 10_000, MAX_EVENT_MULT_BPS),
        total_points: totalPoints.toString(),
        bet_lamports: args.betLamports.toString(),
        edge_bps: args.edgeBps,
        signer: args.signer ?? null,
        notes: args.notes ?? null,
      },
      { onConflict: "source_key,source", ignoreDuplicates: true },
    )
    .select("id");

  if (error) {
    // Don't throw — we don't want a points-ledger hiccup to break game
    // indexing. Log and move on; the row is recoverable via backfill.
    logger.error(
      { err: error.message, player: args.player, source: args.source, sourceKey: args.sourceKey },
      "points_ledger insert failed",
    );
    return { basePoints, totalPoints, inserted: false };
  }
  return {
    basePoints,
    totalPoints,
    inserted: Array.isArray(data) && data.length > 0,
  };
}
