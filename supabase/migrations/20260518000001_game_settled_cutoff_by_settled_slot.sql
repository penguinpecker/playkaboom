-- 2026-05-18 indexer race fix #3: GameSettled must not fall through to a
-- stranded older unsettled row on the same PDA.
--
-- Recurrence today: cashout `5i6A5N87…` (slot 420481749) GameWon event
-- ingested AFTER its paired settle `z5DCzB9R…` (slot 420481753) was
-- processed. When the settle ran, the cashout row did not yet exist, and
-- the existing "most-recent unsettled at slot <= event_slot" predicate
-- correctly returned 0 — BUT a previous game session on the same PDA
-- (cashout `vEcNh8Ut…` slot 420319943) had its OWN settle silently
-- mis-attributed weeks ago, leaving it stuck with mine_layout=NULL. The
-- new settle then matched that orphaned row instead of throwing for
-- retry, so the corruption cascades: today's settle data overwrites
-- yesterday's cashout, and today's cashout stays in sentinel forever.
--
-- Fix: add the cutoff "matched row's slot must be GREATER than the
-- slot of the most recent ALREADY-SETTLED row for the same PDA". That
-- eliminates stranded predecessors from the candidate set without
-- weakening the happy path:
--   - Normal in-order delivery: the cashout row is the most recent on
--     its PDA, MAX(settled slot) refers to the previous game (lower
--     slot), the new clause is trivially satisfied.
--   - First-ever game on a PDA: MAX returns NULL, COALESCE → 0, the
--     clause is trivially satisfied.
--   - Out-of-order arrival (today's failure mode): the orphaned older
--     unsettled row has slot < MAX(settled slot) since at least one
--     newer game has already settled, so it's excluded. Match returns
--     0 → handler throws → processed_events claim released → cron
--     retries → when the cashout row eventually lands, it satisfies
--     the cutoff and matches correctly.
--
-- The 2026-05-11 fix moved corruption from "silent at-most-once" to
-- "retried until paired row exists", but only on the same-tx race —
-- not on the cross-PDA-session race that requires this slot cutoff.

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
  v_last_settled_slot bigint;
BEGIN
  SELECT COALESCE(MAX(slot), 0) INTO v_last_settled_slot
  FROM public.games
  WHERE game = p_game
    AND mine_layout IS NOT NULL
    AND slot <= p_event_slot;

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
      AND slot > v_last_settled_slot
    ORDER BY slot DESC
    LIMIT 1
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.idx_apply_game_settled(text, int, int, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idx_apply_game_settled(text, int, int, text, text, text, bigint)
  TO service_role;
