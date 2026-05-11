-- 2026-05-11 DB hardening — six follow-on fixes from today's RLS audit.
-- All defense-in-depth; none of these gaps moved SOL, but tightening them
-- closes future drift surfaces.

-- ── 1. Slot guard on idx_apply_referral_accrued tier write ──────────────
-- The earlier version unconditionally set tier = p_tier in the ON CONFLICT
-- branch. A late-arriving older event could silently downgrade a referrer's
-- tier even though last_event_slot was correctly GREATEST'd. Fix: only
-- mutate tier when the event is actually the newest seen.

CREATE OR REPLACE FUNCTION public.idx_apply_referral_accrued(
  p_referrer text,
  p_amount bigint,
  p_tier int,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
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
    -- Tier only moves on equal-or-newer events. Prevents an older accrued
    -- event from clobbering a tier that a newer ReferralTierChanged set.
    tier             = CASE
                         WHEN p_event_slot >= referrals.last_event_slot
                         THEN p_tier
                         ELSE referrals.tier
                       END,
    last_event_slot  = GREATEST(referrals.last_event_slot, p_event_slot);
END;
$$;

-- ── 2. Slot guard on idx_apply_referral_claimed ─────────────────────────
-- Replays of an older claim event would double-decrement the counter (the
-- processed_events dedupe catches this in practice, but in-handler
-- protection is the second line of defense and is cheap).

CREATE OR REPLACE FUNCTION public.idx_apply_referral_claimed(
  p_referrer text,
  p_amount bigint,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.referrals
  SET accrued_lamports = GREATEST(0::bigint, accrued_lamports - p_amount),
      last_event_slot  = p_event_slot
  WHERE referrer = p_referrer
    AND last_event_slot < p_event_slot;
END;
$$;

-- ── 3. FORCE RLS on the 8 tables that only ENABLE it ────────────────────
-- Tables with `enable row level security` but not `force` can be bypassed
-- by the table owner. On managed Supabase the owner role is not externally
-- exposed, so practical risk is low — but parity with the 2026-05-05
-- security migration is cleaner and protects against future schema-tier
-- changes that might surface the owner.

ALTER TABLE public.lp_positions             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.lp_actions               FORCE ROW LEVEL SECURITY;
ALTER TABLE public.vault_unit_value_history FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cron_indexer_state       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.game_sessions            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.points_ledger            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.referral_codes           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.referral_visits          FORCE ROW LEVEL SECURITY;

-- ── 4. SECURITY INVOKER on touch_updated_at ─────────────────────────────
-- The trigger function was SECURITY DEFINER for no reason (the writer is
-- always service_role, which already has the necessary grants). Footgun:
-- if this trigger is ever attached to a table writable by anon, the
-- DEFINER context would elevate the write. Drop the privilege.

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── 5. Unique partial constraint preventing two unsettled rows per PDA ──
-- idx_apply_game_settled relies on a "most recent unsettled row at slot ≤
-- event_slot" heuristic. If two unsettled rows ever existed for the same
-- PDA at the SAME slot, the function would pick one and orphan the other
-- forever. Forbid that state at the DB level.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_games_unsettled_per_pda
  ON public.games (game)
  WHERE mine_layout IS NULL;

-- The partial unique allows MANY settled rows per PDA (mine_layout is set)
-- but at most ONE unsettled. If the indexer ever tries to insert a second
-- unsettled row for the same PDA, the INSERT errors with 23505 — which
-- ingestTransactions catches as "already claimed by another ingest" and
-- skips. Net: the first cashout-of-an-instance wins; any duplicate is a
-- bug surfaced loudly rather than silently corrupting the table.

-- ── 6. Ensure points_ledger unique constraint stays in place ────────────
-- awardPoints idempotency depends on (source_key, source) being unique.
-- A future migration could accidentally drop it. Add an explicit assertion
-- migration that fails CI/db-push if the constraint is missing.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'points_ledger'
      AND indexname = 'uniq_points_per_source'
  ) THEN
    RAISE EXCEPTION 'points_ledger.uniq_points_per_source UNIQUE INDEX is missing — awardPoints idempotency would break. Restore it before proceeding.';
  END IF;
END $$;
