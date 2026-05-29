-- ────────────────────────────────────────────────────────────────────────────
-- 2026-05-30 — Make the referral rollup idempotent (recompute, don't increment).
--
-- Root cause (found 2026-05-30): idx_apply_referral_accrued did an unconditional
-- `total_earned += amount` on every call, with no per-signature dedup and no
-- slot guard. A settle tx emits ReferralAccrued *before* GameSettled in the same
-- signature; when GameSettled throws (paired cashout row not yet ingested), the
-- processed_events claim is released and the whole tx replays — re-adding the
-- accrual each pass. Live drift observed: rollup inflated 1.03×–1.83× vs the
-- on-chain ReferralAccount (which is the source of truth for actual payouts).
--
-- Fix: recompute total_earned + referred_volume from referral_events, which is
-- keyed on signature PK (so it is already exactly-once). Re-applying the same
-- event leaves the SUM unchanged → idempotent. accrued_lamports is derived as
-- total_earned − (amount already claimed), where claimed is recovered from the
-- existing row as (old total_earned − old accrued); this both preserves claim
-- accounting and SELF-HEALS the current inflation on the next accrual event.
-- The call site in apps/web/src/server/indexer.ts is unchanged.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.idx_apply_referral_accrued(
  p_referrer text,
  p_amount bigint,
  p_tier int,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_earned  bigint;
  v_volume  numeric;
  v_claimed bigint;
BEGIN
  -- Lifetime earnings + implied wager volume, summed from the dedup'd event log.
  -- Per-event wager is backed out of the lamport cut via the tier→bps map (50/60/70).
  SELECT
    COALESCE(SUM(amount), 0),
    COALESCE(SUM((amount::numeric * 10000)
      / CASE tier WHEN 1 THEN 60 WHEN 2 THEN 70 ELSE 50 END), 0)
  INTO v_earned, v_volume
  FROM public.referral_events
  WHERE referrer = p_referrer;

  -- Claimed-so-far, recovered from the prior row (0 if none). Preserved across
  -- the recompute so accrued stays correct after partial claims.
  SELECT GREATEST(0, total_earned - accrued_lamports)
  INTO v_claimed
  FROM public.referrals
  WHERE referrer = p_referrer;
  v_claimed := COALESCE(v_claimed, 0);

  INSERT INTO public.referrals (
    referrer, accrued_lamports, total_earned, referred_volume, tier, last_event_slot
  ) VALUES (
    p_referrer, GREATEST(0, v_earned - v_claimed), v_earned, v_volume::bigint, p_tier, p_event_slot
  )
  ON CONFLICT (referrer) DO UPDATE SET
    accrued_lamports = GREATEST(0, v_earned - v_claimed),
    total_earned     = v_earned,
    referred_volume  = v_volume::bigint,
    tier             = p_tier,
    last_event_slot  = GREATEST(referrals.last_event_slot, p_event_slot);
END;
$$;

REVOKE ALL ON FUNCTION public.idx_apply_referral_accrued(text, bigint, int, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idx_apply_referral_accrued(text, bigint, int, bigint) TO service_role;
