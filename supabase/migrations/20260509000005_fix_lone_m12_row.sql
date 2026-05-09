-- One-shot fix for the single row that the 2026-05-09 recovery
-- couldn't repopulate correctly. After the indexer fix +
-- 20260509000004 reset, the second rescue cron run timed out
-- before processing every GameSettled event. Net effect: one
-- m=12 K=1 cash-out (slot 418630335, multiplier_bps=39200) ended
-- up tagged as mine_count=3 instead of mine_count=12.
--
-- Multiplier 39200 (3.92×) is uniquely produced by m=12 K=1:
-- 16/(16-12) × 0.98 = 3.92. No other (m,K) combo produces it
-- on this MAX_MINES=15 program. Safe to identify the row by
-- (multiplier_bps=39200, mine_count=3) and correct it.

update public.games
set mine_count = 12
where multiplier_bps = 39200
  and mine_count = 3;
