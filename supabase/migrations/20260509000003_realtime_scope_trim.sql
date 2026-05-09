-- Scope trim: Railway relay + Supabase Realtime should ONLY broadcast
-- live game-settle events. Everything else (LP deposits/withdrawals,
-- leaderboard, vault state, player stats) stays on Supabase polling /
-- direct REST per the rest of the architecture.
--
-- Migration 20260509000001 originally added BOTH public.games and
-- public.lp_actions to the supabase_realtime publication. Per the
-- repo's "Railway = live trade fees only" rule (records PART 5,
-- 2026-05-09 session 2), drop lp_actions from the publication. The
-- table itself stays untouched; only its push-broadcast capability
-- is removed.

alter publication supabase_realtime drop table public.lp_actions;
