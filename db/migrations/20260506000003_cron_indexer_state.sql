-- Ported from supabase/migrations/20260506000003_cron_indexer_state.sql for plain Postgres (Railway).
-- Removed 3 Supabase-only statement(s) (RLS/policies/role grants); all else verbatim.

-- Cursor table for the cron-based event indexer (replaces Helius webhooks).
-- One row per program key. The cron route reads `last_signature`, fetches all
-- signatures since (until that signature is reached, paged), processes them,
-- and writes the newest signature back. Idempotent at row-level via
-- `processed_events` (existing table from 20260505000001_init.sql).

create table if not exists public.cron_indexer_state (
  program          text        primary key,
  last_signature   text,                                -- newest sig already ingested
  last_slot        bigint      not null default 0,
  last_run_at      timestamptz,
  updated_at       timestamptz not null default now()
);

-- [railway] removed Supabase-only: alter table public.cron_indexer_state enable row level security;

-- [railway] removed Supabase-only: revoke all on public.cron_indexer_state from anon, authenticated;
-- [railway] removed Supabase-only: grant all on public.cron_indexer_state to service_role;

create trigger trg_cron_indexer_state_updated_at
  before update on public.cron_indexer_state
  for each row execute function public.touch_updated_at();

comment on table public.cron_indexer_state is
  'Cursor for the cron-based program-log indexer. Service role only.';
