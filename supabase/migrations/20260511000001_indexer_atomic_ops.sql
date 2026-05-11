-- Indexer hardening (2026-05-11):
-- - Add last_event_slot to player_stats, referrals, lp_positions so absolute-
--   snapshot writes can be slot-monotonic (no late-event reverts).
-- - Add atomic-delta + slot-guarded RPC functions for every read-modify-write
--   handler in apps/web/src/server/indexer.ts. The TS layer will call these
--   via supabase.rpc(), eliminating the "read row → compute new value → write
--   row" race that today's GameSettled corruption shares a family with.
--
-- All functions are SECURITY INVOKER — caller is the indexer running as
-- service_role, which already has the right grants. No SECURITY DEFINER to
-- avoid leaking write capability through any future grant change.

-- ── Add last_event_slot guards ──────────────────────────────────────────────

ALTER TABLE public.player_stats
  ADD COLUMN IF NOT EXISTS last_event_slot bigint NOT NULL DEFAULT 0;

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS last_event_slot bigint NOT NULL DEFAULT 0;

ALTER TABLE public.lp_positions
  ADD COLUMN IF NOT EXISTS last_event_slot bigint NOT NULL DEFAULT 0;

-- ── player_stats absolute snapshot, only-if-newer ──────────────────────────

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
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.player_stats (
    player, games_played, games_won, total_wagered, total_payouts,
    biggest_win, current_streak, best_streak, last_played, last_event_slot
  ) VALUES (
    p_player, p_games_played, p_games_won, p_total_wagered, p_total_payouts,
    p_biggest_win, p_current_streak, p_best_streak, p_last_played, p_event_slot
  )
  ON CONFLICT (player) DO UPDATE SET
    games_played    = EXCLUDED.games_played,
    games_won       = EXCLUDED.games_won,
    total_wagered   = EXCLUDED.total_wagered,
    total_payouts   = EXCLUDED.total_payouts,
    biggest_win     = GREATEST(player_stats.biggest_win, EXCLUDED.biggest_win),
    current_streak  = EXCLUDED.current_streak,
    best_streak     = GREATEST(player_stats.best_streak, EXCLUDED.best_streak),
    last_played     = EXCLUDED.last_played,
    last_event_slot = EXCLUDED.last_event_slot
  WHERE player_stats.last_event_slot < EXCLUDED.last_event_slot;
END;
$$;

-- player_stats.referrer is set exactly once on-chain (immutable). No slot
-- guard required — we use INSERT ON CONFLICT DO NOTHING / no-op on existing.
CREATE OR REPLACE FUNCTION public.idx_apply_referrer_set(
  p_player text,
  p_referrer text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.player_stats (player, referrer)
  VALUES (p_player, p_referrer)
  ON CONFLICT (player) DO UPDATE SET referrer = EXCLUDED.referrer
    WHERE player_stats.referrer IS NULL;
END;
$$;

-- ── referrals atomic deltas + slot-guarded tier ─────────────────────────────

CREATE OR REPLACE FUNCTION public.idx_apply_referral_accrued(
  p_referrer text,
  p_amount bigint,
  p_tier int,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  -- Tier → bps map: 50/60/70. We back out the wager from the lamport cut.
  -- Pre-2026-05-11 the indexer hard-coded × 200 (tier-0 only). Preserve the
  -- previously-recorded values by capping at tier 2; do NOT retroactively
  -- recompute legacy rows.
  v_bps int := CASE p_tier WHEN 1 THEN 60 WHEN 2 THEN 70 ELSE 50 END;
  v_wager_from_cut bigint := (p_amount::numeric * 10000 / v_bps)::bigint;
BEGIN
  INSERT INTO public.referrals (
    referrer, accrued_lamports, total_earned, referred_volume, tier, last_event_slot
  ) VALUES (
    p_referrer, p_amount, p_amount, v_wager_from_cut, p_tier, p_event_slot
  )
  ON CONFLICT (referrer) DO UPDATE SET
    accrued_lamports = referrals.accrued_lamports + p_amount,
    total_earned     = referrals.total_earned + p_amount,
    referred_volume  = referrals.referred_volume + v_wager_from_cut,
    tier             = p_tier,
    last_event_slot  = GREATEST(referrals.last_event_slot, p_event_slot);
END;
$$;

CREATE OR REPLACE FUNCTION public.idx_apply_referral_claimed(
  p_referrer text,
  p_amount bigint,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.referrals
  SET accrued_lamports = GREATEST(0::bigint, accrued_lamports - p_amount),
      last_event_slot  = GREATEST(last_event_slot, p_event_slot)
  WHERE referrer = p_referrer;
END;
$$;

CREATE OR REPLACE FUNCTION public.idx_apply_referral_tier(
  p_referrer text,
  p_new_tier int,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Only apply if this event is at or after the most recent observed slot.
  -- Tier is set to whatever the latest event says; older events no-op.
  UPDATE public.referrals
  SET tier = p_new_tier,
      last_event_slot = p_event_slot
  WHERE referrer = p_referrer
    AND last_event_slot < p_event_slot;
END;
$$;

-- ── lp_positions atomic deltas (units stay numeric/u128) ────────────────────

CREATE OR REPLACE FUNCTION public.idx_apply_lp_deposit(
  p_user_address text,
  p_units_delta numeric,
  p_lamports_delta bigint,
  p_block_time timestamptz,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.lp_positions (
    user_address, units, pending_units,
    cumulative_deposited, first_action_at, last_action_at, last_event_slot
  ) VALUES (
    p_user_address, p_units_delta, 0,
    p_lamports_delta, p_block_time, p_block_time, p_event_slot
  )
  ON CONFLICT (user_address) DO UPDATE SET
    units                = lp_positions.units + p_units_delta,
    cumulative_deposited = lp_positions.cumulative_deposited + p_lamports_delta,
    first_action_at      = COALESCE(lp_positions.first_action_at, p_block_time),
    last_action_at       = p_block_time,
    last_event_slot      = GREATEST(lp_positions.last_event_slot, p_event_slot);
END;
$$;

CREATE OR REPLACE FUNCTION public.idx_apply_lp_request(
  p_user_address text,
  p_units numeric,
  p_unlock_slot bigint,
  p_block_time timestamptz,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.lp_positions
  SET units               = units - p_units,
      pending_units       = pending_units + p_units,
      pending_unlock_slot = p_unlock_slot,
      last_action_at      = p_block_time,
      last_event_slot     = GREATEST(last_event_slot, p_event_slot)
  WHERE user_address = p_user_address;
END;
$$;

CREATE OR REPLACE FUNCTION public.idx_apply_lp_cancel(
  p_user_address text,
  p_units_returned numeric,
  p_block_time timestamptz,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.lp_positions
  SET units               = units + p_units_returned,
      pending_units       = pending_units - p_units_returned,
      pending_unlock_slot = 0,
      last_action_at      = p_block_time,
      last_event_slot     = GREATEST(last_event_slot, p_event_slot)
  WHERE user_address = p_user_address;
END;
$$;

CREATE OR REPLACE FUNCTION public.idx_apply_lp_complete(
  p_user_address text,
  p_units_burned numeric,
  p_lamports_out bigint,
  p_block_time timestamptz,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.lp_positions
  SET pending_units        = pending_units - p_units_burned,
      pending_unlock_slot  = 0,
      cumulative_withdrawn = cumulative_withdrawn + p_lamports_out,
      last_action_at       = p_block_time,
      last_event_slot      = GREATEST(last_event_slot, p_event_slot)
  WHERE user_address = p_user_address;
END;
$$;

-- Grant execute on these RPCs to service_role only. Anon and authenticated
-- must NOT be able to call them — they bypass the read-modify-write protections
-- by design.
REVOKE ALL ON FUNCTION public.idx_apply_stats(text, bigint, bigint, bigint, bigint, bigint, int, int, timestamptz, bigint)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_referrer_set(text, text)                                                                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_referral_accrued(text, bigint, int, bigint)                                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_referral_claimed(text, bigint, bigint)                                                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_referral_tier(text, int, bigint)                                                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_lp_deposit(text, numeric, bigint, timestamptz, bigint)                                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_lp_request(text, numeric, bigint, timestamptz, bigint)                                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_lp_cancel(text, numeric, timestamptz, bigint)                                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_lp_complete(text, numeric, bigint, timestamptz, bigint)                                        FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.idx_apply_stats(text, bigint, bigint, bigint, bigint, bigint, int, int, timestamptz, bigint)             TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_referrer_set(text, text)                                                                       TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_referral_accrued(text, bigint, int, bigint)                                                    TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_referral_claimed(text, bigint, bigint)                                                         TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_referral_tier(text, int, bigint)                                                               TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_lp_deposit(text, numeric, bigint, timestamptz, bigint)                                         TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_lp_request(text, numeric, bigint, timestamptz, bigint)                                        TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_lp_cancel(text, numeric, timestamptz, bigint)                                                  TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_lp_complete(text, numeric, bigint, timestamptz, bigint)                                        TO service_role;
