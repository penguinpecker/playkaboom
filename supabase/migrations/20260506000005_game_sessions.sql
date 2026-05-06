-- Server-side session storage so players can recover an in-flight game from
-- any device (not just the one that has the localStorage gameToken).
--
-- The session payload is the same one we already encrypt into gameToken
-- (mineLayout + salt + reveals + nonce). We store the ENCRYPTED ciphertext
-- here, never plaintext — server reads it and decrypts on request just like
-- it does with the client-side token. This means a Supabase compromise still
-- doesn't reveal layouts; the SESSION_ENC_KEY is needed.
--
-- Keyed by GameSession PDA so reveal/settle/cleanup can look up the right
-- row regardless of which tx the player is operating on. Player column
-- exists for indexed access from the recovery API ("does my wallet have
-- any open games?").

create table if not exists public.game_sessions (
  game            text        primary key,            -- GameSession PDA, base58
  player          text        not null,
  ciphertext      text        not null,               -- the encrypted gameToken value
  created_slot    bigint      not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_game_sessions_player
  on public.game_sessions (player);
create index if not exists idx_game_sessions_created
  on public.game_sessions (created_at);

alter table public.game_sessions enable row level security;
revoke all on public.game_sessions from anon, authenticated;
grant  all on public.game_sessions to service_role;

create trigger trg_game_sessions_updated_at
  before update on public.game_sessions
  for each row execute function public.touch_updated_at();

comment on table public.game_sessions is
  'Server-side gameToken storage keyed by GameSession PDA. Encrypted with the same SESSION_ENC_KEY as the client-side cookie. Service-role only.';
