-- ────────────────────────────────────────────────────────────────────────────
-- 2026-05-21 — Slot-guard the LP RPCs so they are commutative under replay.
--
-- The ingest loop in apps/web/src/server/indexer.ts uses an INSERT-first
-- processed_events claim with a `DELETE` of the claim on apply-error so the
-- signature can be retried by the next cron pass. That pattern is safe IFF
-- every applyEvent handler is commutative (re-applying the same event is a
-- no-op).
--
-- These four LP RPCs were bare UPDATEs that mutated `units` / `pending_units`
-- with `± p_units` and `GREATEST(last_event_slot, p_event_slot)`. Replay
-- after a claim-release double-applied the math (a withdraw request would
-- subtract `p_units` twice from `units`, eventually tripping the
-- `units_nonneg` CHECK and breaking ingest indefinitely).
--
-- Fix: guard every UPDATE with `last_event_slot < p_event_slot`. Stale
-- replays (same or older slot) no-op. The lp_actions row is already keyed
-- on signature PK so the action-log side is naturally idempotent.
--
-- Edge case: two distinct LP events for the same user at the same slot
-- (two signed txs landing in the same ~400ms block). The second will
-- now be skipped at the position-update level. This is rare (a single
-- wallet can't realistically race itself across a slot boundary) and the
-- conservative outcome — losing a single delta — is far better than the
-- current bug, which corrupts the running balance indefinitely under any
-- transient ingest error.
-- ────────────────────────────────────────────────────────────────────────────

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
    units                = lp_positions.units + EXCLUDED.units,
    cumulative_deposited = lp_positions.cumulative_deposited + EXCLUDED.cumulative_deposited,
    first_action_at      = COALESCE(lp_positions.first_action_at, EXCLUDED.first_action_at),
    last_action_at       = EXCLUDED.last_action_at,
    last_event_slot      = EXCLUDED.last_event_slot
  WHERE lp_positions.last_event_slot < EXCLUDED.last_event_slot;
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
      pending_units       = pending_units - p_units_returned,
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
  SET pending_units        = pending_units - p_units_burned,
      pending_unlock_slot  = 0,
      cumulative_withdrawn = cumulative_withdrawn + p_lamports_out,
      last_action_at       = p_block_time,
      last_event_slot      = p_event_slot
  WHERE user_address  = p_user_address
    AND last_event_slot < p_event_slot;
END;
$$;
