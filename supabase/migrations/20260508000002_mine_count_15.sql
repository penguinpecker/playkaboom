-- Bump games.mine_count CHECK from (0..12) → (0..15) to match the
-- on-chain MAX_MINES bump from 12 → 15 that landed in commit cccf58d
-- (program upgrade 2026-05-08). Without this fix, any settled game with
-- 13, 14, or 15 mines would silently fail the CHECK constraint on the
-- GameSettled UPDATE — applyEvent throws, the cron retries forever, the
-- row never lands in the indexer table, and the player's game vanishes
-- from /logs and the live feed.
--
-- Symptom this fixes: vault.total_games on chain = 21 but DB rows = 19;
-- the missing 2 were 12-mine and 15-mine settles played during testing.
-- (Spec: 12 was previously valid since constraint was inclusive of 12,
--  but the bug appeared after MAX_MINES bump made the indexer try to
--  store mine_count=15. UPDATE then fails for THAT row, AND retries
--  during cron also fail, AND processed_events never gets the row.)

alter table public.games drop constraint if exists games_mine_count_range;
alter table public.games add constraint games_mine_count_range
  check (mine_count between 0 and 15);
