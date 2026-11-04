-- Ported from supabase/migrations/20260509000003_realtime_scope_trim.sql for plain Postgres (Railway).
-- REALTIME-ONLY: no statements.

-- Intentionally empty on Railway: Supabase Realtime publication / replica
-- identity only. Replaced by the pg_notify trigger in
-- 20261104000001_pg_notify_relay.sql.
select 1;
