-- 2026-05-11 follow-up: uniquely match GameSettled → exactly one games row.
--
-- The 2026-05-09 partial fix (`is null mine_layout`) prevents an old settled
-- row from being clobbered, but NOT the case where two concurrent in-flight
-- (mine_layout null) rows exist for the same PDA when a settle fires. That's
-- the actual cause of today's 17 corrupted rows.
--
-- Fix: pick the SINGLE most-recent unsettled row with slot <= event_slot,
-- ORDER BY slot DESC LIMIT 1. There is exactly one such row per real game
-- instance.
--
-- Also: record settle_signature on the row so the public verifier page can
-- look it up from a cashout sig and verify chain-direct against the settle
-- tx, instead of trusting the DB cache for the (mine_layout, salt, commitment)
-- triple.

ALTER TABLE public.games
  ADD COLUMN IF NOT EXISTS settle_signature text;

CREATE INDEX IF NOT EXISTS idx_games_settle_signature
  ON public.games (settle_signature)
  WHERE settle_signature IS NOT NULL;

CREATE OR REPLACE FUNCTION public.idx_apply_game_settled(
  p_game text,
  p_mine_layout int,
  p_mine_count int,
  p_commitment text,
  p_salt text,
  p_settle_signature text,
  p_event_slot bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Single-row UPDATE: pick the most-recent unsettled game row for this PDA
  -- whose cashout/loss slot is <= this settle's slot. There is exactly one
  -- such row per real game instance (PDA reuse implies prior instances
  -- were closed, which means they were settled).
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
END;
$$;

REVOKE ALL ON FUNCTION public.idx_apply_game_settled(text, int, int, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idx_apply_game_settled(text, int, int, text, text, text, bigint)
  TO service_role;
