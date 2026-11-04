-- Ported from supabase/migrations/20260511000003_null_legacy_settle_signature.sql for plain Postgres (Railway).
-- DATA-ONLY: no statements.

-- Intentionally empty on Railway: this file was a one-shot DATA fix on the
-- Supabase production rows. Those rows arrive already fixed via the copy
-- script, and on an empty DB the statements would be no-ops. Original SQL:
-- supabase/migrations/20260511000003_null_legacy_settle_signature.sql
select 1;
