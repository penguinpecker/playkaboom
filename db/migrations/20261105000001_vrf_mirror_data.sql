-- 2026-11-05 — data fixes from the 11-04 mainnet QA run (VRF games emit no events).
--
-- 1. idx_apply_stats never wrote player_stats.biggest_multiplier_bps, so the
--    leaderboard showed 0 for every player (chain: 11199). The VRF mirror now
--    passes the on-chain PlayerStats value; the legacy StatsUpdated event has no
--    such field, so the new parameter defaults to NULL (keep the stored value).
--    Adding a parameter makes a new overload, so the old signature is dropped
--    first (an overload with a default would make every 10-argument call
--    ambiguous).
-- 2. vault_unit_value_history gets a program scope: the cron now snapshots the
--    unit value per program, and APY must not read another deployment's rows.
--    Existing rows keep program NULL (their program is unknown), so APY ignores them.
-- 3. referral_claims: one row per claim_referral tx, so claims are indexed per
--    signature like accruals (referral_events) instead of only decrementing the
--    referrals aggregate.

DROP FUNCTION IF EXISTS public.idx_apply_stats(text, bigint, bigint, bigint, bigint, bigint, int, int, timestamptz, bigint);

CREATE OR REPLACE FUNCTION public.idx_apply_stats(
  p_player text,
  p_games_played bigint,
  p_games_won bigint,
  p_total_wagered bigint,
  p_total_payouts bigint,
  p_biggest_win bigint,
  p_current_streak int,
  p_best_streak int,
  p_last_played timestamptz,
  p_event_slot bigint,
  p_biggest_multiplier_bps bigint DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.player_stats (
    player, games_played, games_won, total_wagered, total_payouts,
    biggest_win, biggest_multiplier_bps, current_streak, best_streak, last_played, last_event_slot
  ) VALUES (
    p_player, p_games_played, p_games_won, p_total_wagered, p_total_payouts,
    p_biggest_win, COALESCE(p_biggest_multiplier_bps, 0), p_current_streak, p_best_streak, p_last_played, p_event_slot
  )
  ON CONFLICT (player) DO UPDATE SET
    games_played           = EXCLUDED.games_played,
    games_won              = EXCLUDED.games_won,
    total_wagered          = EXCLUDED.total_wagered,
    total_payouts          = EXCLUDED.total_payouts,
    biggest_win            = GREATEST(player_stats.biggest_win, EXCLUDED.biggest_win),
    biggest_multiplier_bps = GREATEST(player_stats.biggest_multiplier_bps, EXCLUDED.biggest_multiplier_bps),
    current_streak         = EXCLUDED.current_streak,
    best_streak            = GREATEST(player_stats.best_streak, EXCLUDED.best_streak),
    last_played            = EXCLUDED.last_played,
    last_event_slot        = EXCLUDED.last_event_slot
  WHERE player_stats.last_event_slot < EXCLUDED.last_event_slot;
END;
$$;

REVOKE ALL ON FUNCTION public.idx_apply_stats(text, bigint, bigint, bigint, bigint, bigint, int, int, timestamptz, bigint, bigint) FROM PUBLIC;

-- Non-destructive catch-up (only ever raises the value): the biggest won
-- multiplier already mirrored in games. Same rule as the program: wins only.
UPDATE public.player_stats ps
SET biggest_multiplier_bps = g.m
FROM (
  SELECT player, max(multiplier_bps) AS m
  FROM public.games
  WHERE outcome = 'won'
  GROUP BY player
) g
WHERE g.player = ps.player
  AND g.m >= 10000
  AND g.m > ps.biggest_multiplier_bps;

ALTER TABLE public.vault_unit_value_history
  ADD COLUMN IF NOT EXISTS program text;
CREATE INDEX IF NOT EXISTS idx_vault_uv_program_time
  ON public.vault_unit_value_history (program, block_time DESC);

CREATE TABLE IF NOT EXISTS public.referral_claims (
  signature  text        PRIMARY KEY,
  referrer   text        NOT NULL,
  amount     bigint      NOT NULL CHECK (amount >= 0),
  slot       bigint      NOT NULL,
  claimed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referral_claims_referrer
  ON public.referral_claims (referrer, slot DESC);
