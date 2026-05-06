-- Indexer/games table fixes:
-- 1. GameWon and GameLost events don't carry mine_count (only GameSettled does),
--    and GameSettled lands in a different tx for the win path. The previous
--    CHECK constraint mine_count between 1 and 12 silently rejected the row,
--    leaving the games table empty.
-- 2. We now store the GameSession PDA so settle data can be merged with the
--    earlier win/lose row even though their tx signatures differ.

alter table public.games drop constraint if exists games_mine_count_range;
alter table public.games add constraint games_mine_count_range
  check (mine_count between 0 and 12);

alter table public.games drop constraint if exists games_commitment_hex_64;
-- Allow either real commitment hash OR a sentinel of 64 zeros while we wait
-- for the GameSettled tx to fill in the proof.
alter table public.games add constraint games_commitment_hex_64
  check (commitment ~ '^[0-9a-f]{64}$');

alter table public.games add column if not exists game text;
create index if not exists idx_games_game on public.games (game);
