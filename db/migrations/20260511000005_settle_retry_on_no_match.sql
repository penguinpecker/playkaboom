-- Ported from supabase/migrations/20260511000005_settle_retry_on_no_match.sql for plain Postgres (Railway).
-- Removed 1 Supabase-only statement(s) (role grant) + the one-row data backfill; all else verbatim.

-- 2026-05-11 indexer race fix: settle events that find no matching cashout
-- row must NOT mark the signature as processed, so a future cron pass
-- (with the cashout row now present) can re-apply.
--
-- Today's specific failure mode (cashout `52mySrDaDM…` slot 419014575,
-- settle `5ujvhsbTj7M…` slot 419014577): Helius delivered the GameSettled
-- event before the GameWon event. The handler ran idx_apply_game_settled,
-- the WHERE-clause subquery found no row (cashout not yet inserted),
-- UPDATE affected 0 rows, and the handler silently no-op'd. The
-- processed_events claim was already inserted (INSERT-first dedupe), so
-- the cron's safety-window retries skip the settle as "already processed."
-- Row stays unsettled forever even though the chain settled correctly.
--
-- Fix part 1: idx_apply_game_settled returns the affected-row count.
-- The indexer.ts handler will throw on 0, which trips the
-- "DELETE processed_events on apply error" path I added earlier today —
-- effectively releasing the dedupe claim so the cron re-tries.

-- Postgres refuses CREATE OR REPLACE when the return type changes
-- (void → integer here). Drop first.
DROP FUNCTION IF EXISTS public.idx_apply_game_settled(text, int, int, text, text, text, bigint);

CREATE FUNCTION public.idx_apply_game_settled(
  p_game text,
  p_mine_layout int,
  p_mine_count int,
  p_commitment text,
  p_salt text,
  p_settle_signature text,
  p_event_slot bigint
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.games SET
    mine_layout      = p_mine_layout,
    settled_layout   = p_mine_layout,
    mine_count       = p_mine_count,
    commitment       = p_commitment,
    salt             = p_salt,
    settle_signature = p_settle_signature
  WHERE signature = (
    SELECT signature FROM public.games
    WHERE game = p_game
      AND mine_layout IS NULL
      AND slot <= p_event_slot
    ORDER BY slot DESC
    LIMIT 1
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.idx_apply_game_settled(text, int, int, text, text, text, bigint)
  FROM PUBLIC;
-- [railway] removed Supabase-only: grant execute on function public.idx_apply_game_settled(text, int, int, text, text, text, 

-- [railway] removed Fix part 2: one-shot DATA backfill of row 52mySrDaDM... (already
-- applied in the Supabase rows the copy script carries over; no-op on an empty DB).
