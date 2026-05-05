/**
 * Hand-rolled types matching the Supabase schema in
 * `supabase/migrations/20260505000001_init.sql`.
 *
 * Once the project is linked, regenerate via:
 *   supabase gen types typescript --linked > apps/web/src/server/db/types.ts
 */

export interface PlayerStatsRow {
  player: string;
  games_played: number;
  games_won: number;
  total_wagered: number; // lamports
  total_payouts: number;
  biggest_win: number;
  biggest_multiplier_bps: number;
  current_streak: number;
  best_streak: number;
  last_played: string | null;
  referrer: string | null;
  updated_at: string;
}

export interface GameRow {
  signature: string;
  player: string;
  bet: number;
  mine_count: number;
  outcome: "won" | "lost" | "expired";
  payout: number;
  multiplier_bps: number;
  safe_reveals: number;
  mine_layout: number | null;
  settled_layout: number | null;
  commitment: string;
  salt: string | null;
  settled_at: string;
  slot: number;
}

export interface ReferralRow {
  referrer: string;
  tier: number;
  accrued_lamports: number;
  total_earned: number;
  referred_count: number;
  referred_volume: number;
  updated_at: string;
}

export interface ReferralEventRow {
  signature: string;
  referrer: string;
  player: string;
  amount: number;
  tier: number;
  occurred_at: string;
  slot: number;
}
