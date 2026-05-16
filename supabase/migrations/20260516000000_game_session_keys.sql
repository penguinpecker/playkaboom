-- Per-game ephemeral session keys for the Magicblock ER reveal path.
-- Encrypted with SESSION_ENC_KEY (AES-256-GCM) — see session-keys.ts.
-- Rows are deleted on settle; cleanup cron may also sweep stale rows
-- older than the on-chain refund window.

create table if not exists public.game_session_keys (
  game_pda         text        primary key,
  encrypted_secret bytea       not null,
  created_at       timestamptz not null default now()
);

comment on table public.game_session_keys is
  'Encrypted ed25519 secrets for Magicblock ER session signing. One row per active GameSession PDA. Server-only (service-role).';

-- Service-role only; no anon read.
alter table public.game_session_keys enable row level security;

-- No policies = no access for anon. Service role bypasses RLS by design.
