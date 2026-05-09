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

update public.games
set
  mine_count = 0,
  mine_layout = null,
  settled_layout = null,
  commitment = repeat('0', 64),
  salt = null
where mine_layout is not null;

-- Safety: also clear processed_events for any GameSettled-bearing
-- signatures so the cron rescue actually re-applies them. Without this,
-- the dedup table would skip every settle tx as "already processed."
-- We can't filter to settle-only sigs here without parsing the event
-- payload, so this is a blunt clear of the most-recent N rows. The
-- cron's safety window (100 sigs) plus reset=1 (600 sigs from head)
-- will catch and re-apply everything that matters.
delete from public.processed_events
where processed_at >= '2026-05-07'::timestamptz
  and processed_at < now();
