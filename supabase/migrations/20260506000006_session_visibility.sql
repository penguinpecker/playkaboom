-- Track in-flight wager visibility — bet, mineCount, startSlot.
-- This is independent of the on-chain GameSession (which we already mirror
-- via the encrypted ciphertext). Storing bet here means we can show "you
-- have 0.005 SOL in flight, refundable in 87 s" without doing an extra RPC
-- on every page load.

alter table public.game_sessions
  add column if not exists bet_lamports   bigint,
  add column if not exists mine_count     int,
  add column if not exists start_slot     bigint;

create index if not exists idx_game_sessions_start_slot
  on public.game_sessions (start_slot);
