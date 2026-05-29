-- ────────────────────────────────────────────────────────────────────────────
-- 2026-05-30 — Clamp the LP unit math so the cumulative_* running totals can
-- never be lost to a CHECK abort.
--
-- Root cause (found 2026-05-30): the inline indexer writes the lp_actions log
-- row BEFORE calling the aggregate RPC, and classifies a Postgres CHECK
-- violation (23514) as a *terminal* error — it keeps the processed_events
-- claim and never retries. The LP RPCs bundled the unit move
-- (`pending_units = pending_units - burned`, which can go negative if the
-- matching request wasn't applied or arrived out of order) together with the
-- `cumulative_withdrawn += lamports` update in ONE statement. When the
-- units_nonneg / pending_nonneg CHECK fired, the WHOLE statement rolled back —
-- so cumulative_withdrawn stayed 0 forever while the withdrawal still showed in
-- the action log. Net effect: a profitable LP rendered as −100%.
--
-- Fix: GREATEST(0, …) clamp on every unit subtraction. The CHECK can no longer
-- fire, so the cumulative_deposited / cumulative_withdrawn totals (which drive
-- the user-facing net + P&L) always commit. The units/pending_units columns are
-- display-irrelevant — the position API reads live units from the on-chain
-- LpPosition account, not these columns — so clamping them is harmless; they
-- stay directionally correct and any drift is re-synced by the repair script.
-- The slot-guard (idempotent replay) is preserved unchanged.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.idx_apply_lp_request(
  p_user_address text,
  p_units numeric,
  p_unlock_slot bigint,
  p_block_time timestamptz,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.lp_positions
  SET units               = GREATEST(0, units - p_units),
      pending_units       = pending_units + p_units,
      pending_unlock_slot = p_unlock_slot,
      last_action_at      = p_block_time,
      last_event_slot     = p_event_slot
  WHERE user_address  = p_user_address
    AND last_event_slot < p_event_slot;
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
      pending_units       = GREATEST(0, pending_units - p_units_returned),
      pending_unlock_slot = 0,
      last_action_at      = p_block_time,
      last_event_slot     = p_event_slot
  WHERE user_address  = p_user_address
    AND last_event_slot < p_event_slot;
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
  SET pending_units        = GREATEST(0, pending_units - p_units_burned),
      pending_unlock_slot  = 0,
      cumulative_withdrawn = cumulative_withdrawn + p_lamports_out,
      last_action_at       = p_block_time,
      last_event_slot      = p_event_slot
  WHERE user_address  = p_user_address
    AND last_event_slot < p_event_slot;
END;
$$;

REVOKE ALL ON FUNCTION public.idx_apply_lp_request(text, numeric, bigint, timestamptz, bigint)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_lp_cancel(text, numeric, timestamptz, bigint)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.idx_apply_lp_complete(text, numeric, bigint, timestamptz, bigint)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idx_apply_lp_request(text, numeric, bigint, timestamptz, bigint)  TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_lp_cancel(text, numeric, timestamptz, bigint)           TO service_role;
GRANT EXECUTE ON FUNCTION public.idx_apply_lp_complete(text, numeric, bigint, timestamptz, bigint)  TO service_role;
