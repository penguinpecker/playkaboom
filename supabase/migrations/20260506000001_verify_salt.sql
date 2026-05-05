-- Add fields needed for the public verifier:
-- salt (32 bytes hex) so anyone can recompute SHA256(layout||count||salt)
-- mine_count so we don't need a JOIN to player_stats for verification.

alter table public.games
  add column if not exists salt text,
  add column if not exists settled_layout integer;

-- Salt is 64 hex chars (lowercase). Allow null for in-flight rows.
alter table public.games
  add constraint games_salt_hex check (salt is null or salt ~ '^[0-9a-f]{64}$');

-- Settled layout is the verified mine_layout. We already have mine_layout
-- but it could be set pre-settle in some flows; settled_layout is post-settle truth.
-- Idempotent: nothing breaks if it stays null.

create index if not exists idx_games_settled_layout
  on public.games (settled_layout)
  where settled_layout is not null;
