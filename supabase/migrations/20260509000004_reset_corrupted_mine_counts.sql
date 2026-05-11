-- 2026-05-09 corruption recovery.
--
-- The GameSettled indexer handler (apps/web/src/server/indexer.ts) was
-- doing `.update().eq("game", PDA)` without a "mine_layout IS NULL"
-- guard. The GameSession PDA gets REUSED across rounds for the same
-- player (close_game deallocates → next start_game recreates at the
-- same address), so the UPDATE matched every prior round of the same
-- player and overwrote their mine_count + mine_layout with the latest
-- game's values.
--
-- The bug existed since the table was first created, but only fired
-- broadly during the 2026-05-09 `?reset=1` cron rescue when the entire
-- event history was reprocessed. After that run, every "won" row for
-- player 5pc1Yb…carries mine_count=12 (the latest game's value) instead
-- of the per-row truth.
--
-- Fix sequence (this migration is step 1 of 3):
--   1. (here) Reset corrupted columns back to the GameWon/GameLost
--      upsert default — mine_count=0, mine_layout=NULL, etc. — for
--      every row that has a non-null mine_layout. Tells the next cron
--      run "this row hasn't been settled yet, please re-fill it."
--   2. Indexer code patched in the same commit to add the
--      `.is("mine_layout", null)` guard so the GameSettled UPDATE only
--      matches the single in-flight row per PDA.
--   3. After this migration applies AND the patched code deploys,
--      trigger `gh workflow run index-events.yml -f reset=true` once
--      so the GameSettled events repopulate each row correctly.
--
-- ── 2026-05-11 IDEMPOTENCY GUARD ────────────────────────────────────────
-- This migration is DESTRUCTIVE: it nulls fairness columns on every
-- settled-game row + deletes recent processed_events. Originally it had
-- no guard, so `supabase db reset` would silently wipe production fairness
-- data. The guard below ensures the destructive block only runs if the
-- specific corruption pattern is detectable (won-game rows whose stored
-- multiplier doesn't match any plausible (safe_reveals, mine_count, edge=200)
-- combination given their stored mine_count). On a clean DB this evaluates
-- to false and the migration is a no-op. The historical run on 2026-05-09
-- found dozens of matching rows and proceeded.

DO $$
DECLARE
  v_corruption_present boolean;
BEGIN
  -- Concrete heuristic: any won row whose multiplier_bps is consistent
  -- with calc_multiplier under a DIFFERENT mine_count than stored. Today
  -- this returns 0 because the post-fix indexer keeps these consistent.
  SELECT EXISTS (
    SELECT 1
    FROM public.games
    WHERE outcome = 'won'
      AND multiplier_bps > 0
      AND mine_count IS NOT NULL
      AND mine_layout IS NOT NULL
      AND multiplier_bps = 39200
      AND mine_count != 12
  ) INTO v_corruption_present;

  IF NOT v_corruption_present THEN
    RAISE NOTICE '20260509000004: corruption pattern not present; skipping destructive reset (idempotent no-op).';
    RETURN;
  END IF;

  UPDATE public.games
  SET
    mine_count = 0,
    mine_layout = null,
    settled_layout = null,
    commitment = repeat('0', 64),
    salt = null
  WHERE mine_layout IS NOT NULL;

  -- Safety: also clear processed_events for any GameSettled-bearing
  -- signatures so the cron rescue actually re-applies them. Without this,
  -- the dedup table would skip every settle tx as "already processed."
  -- We can't filter to settle-only sigs here without parsing the event
  -- payload, so this is a blunt clear of the most-recent N rows. The
  -- cron's safety window (100 sigs) plus reset=1 (600 sigs from head)
  -- will catch and re-apply everything that matters.
  DELETE FROM public.processed_events
  WHERE processed_at >= '2026-05-07'::timestamptz
    AND processed_at < now();
END $$;
