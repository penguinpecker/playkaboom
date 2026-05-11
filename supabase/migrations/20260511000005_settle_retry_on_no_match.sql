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
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idx_apply_game_settled(text, int, int, text, text, text, bigint)
  TO service_role;

-- Fix part 2: backfill the one known-affected row (`52mySrDaDM…`) using
-- the chain-truth values decoded from the GameSettled event in tx
-- `5ujvhsbTj7M…` at slot 419014577. This is a one-shot recovery, not a
-- general backfill. Per the team's 2026-05-11 policy, the 17 legacy
-- corrupted rows from the GameSettled race stay as-is for record. This
-- row is from today (post-deploy), needs to display correctly to the
-- user who won the bet, and the chain settle DID land — only the
-- indexer pairing failed.
--
-- All four fields come from the chain settle event:
--   mine_count    = 12
--   mine_layout   = 0x6f7e (28542, popcount=12 matching mine_count)
--   salt          = 3b4dede4d6cc52d36e103a811f2c3dda3a823ff06bf210e57fdfa41ab09d025b
--   commitment    = 99561811e82aad823b1c220c45c0a885b27c4a710e2a96cec2473b2cc24bb8dd
-- Verified: sha256(layout_LE || mine_count || salt) == commitment.

UPDATE public.games SET
  mine_count       = 12,
  mine_layout      = 28542,
  settled_layout   = 28542,
  salt             = '3b4dede4d6cc52d36e103a811f2c3dda3a823ff06bf210e57fdfa41ab09d025b',
  commitment       = '99561811e82aad823b1c220c45c0a885b27c4a710e2a96cec2473b2cc24bb8dd',
  settle_signature = '5ujvhsbTj7MNftN8SPiUZWfFLokP31nWPMNdGwKhWSjucNBNtHNjYMPsyhhKEtWT82hs6vpVkJMUbE8fvxkq8S2L'
WHERE signature = '52mySrDaDM3q4ncQzPTYf3DBLwNWtvDfmUDK47MJY5oDkkbTorx7Ymdd6grmCmBrkLtPEK8ohBWwuRLrJRtkTsSy'
  AND mine_layout IS NULL;
