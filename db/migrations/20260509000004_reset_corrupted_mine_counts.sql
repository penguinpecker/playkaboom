-- Ported from supabase/migrations/20260509000004_reset_corrupted_mine_counts.sql for plain Postgres (Railway).
-- DATA-ONLY: no statements.

-- Intentionally empty on Railway: this file was a one-shot DATA fix on the
-- Supabase production rows. Those rows arrive already fixed via the copy
-- script, and on an empty DB the statements would be no-ops. Original SQL:
-- supabase/migrations/20260509000004_reset_corrupted_mine_counts.sql
select 1;
