-- 2026-05-19 indexer race fix #4: GameWon/GameLost insert no longer 23505s
-- after a player calls close_unsettled_game.
--
-- Today's failing sigs (retrying every 60s of the Railway cron tickler):
--   4rrCxGeQqkK4ifGt…  [GameWon.upsert→games]   23505
--   5297dJuLP9bX6RXu…  [GameLost.upsert→games]  23505
-- Both trip uniq_games_unsettled_per_pda (added 2026-05-11 in
-- 20260511000004_db_hardening.sql) — partial unique on `game` filtered to
-- mine_layout IS NULL. They never succeed; processed_events claim is
-- released on apply error so the cron retries forever.
--
-- The on-chain reason this state is legitimate now:
-- programs/kaboom/src/lib.rs:931 ships close_unsettled_game, a player
-- self-recovery path that closes the Game account on chain WITHOUT
-- emitting GameSettled. After CLOSE_UNSETTLED_EXPIRY_SLOTS (38 slots,
-- ~15s, lowered from 600 on 2026-05-17) the player can self-close any
-- stuck Won/Lost game. The Game PDA seeds are (GAME_SEED, player_pubkey)
-- — the SAME PDA is reused for the next game. The indexer row from the
-- closed-unsettled game stays mine_layout=NULL forever (no settle event
-- will ever arrive — the chain account is gone). The next GameWon/Lost
-- for that PDA tries to insert a second mine_layout=NULL row and trips
-- the partial unique index.
--
-- The 2026-05-11 constraint was over-tight. Its stated goal (read the
-- comment block in 20260511000004_db_hardening.sql §5) was to prevent
-- two unsettled rows for the same PDA AT THE SAME SLOT, which would
-- tie-break idx_apply_game_settled's "most recent at slot <= event_slot"
-- pick non-deterministically. Phrasing it as `(game) WHERE mine_layout
-- IS NULL` forbade a much larger state than necessary.
--
-- Fix: drop and recreate with the tuple `(game, slot)`. Still rejects
-- the original concern (two unsettled at the same (PDA, slot)) but
-- permits the legitimate post-close_unsettled state of multiple
-- unsettled rows at different slots.
--
-- Why no code change to indexer.ts:
--   - GameWon/Lost upsert uses onConflict=signature (PK) and now inserts
--     succeed because (game, slot) is unique per real cashout.
--   - idx_apply_game_settled already disambiguates by `ORDER BY slot DESC
--     LIMIT 1` and the 2026-05-18 cutoff `slot > MAX(settled slot on PDA)`
--     (20260518000001_game_settled_cutoff_by_settled_slot.sql), so the
--     correct settle still targets the correct unsettled row.
--
-- Why no data migration: existing unsettled rows trivially satisfy
-- (game, slot) uniqueness — each cashout is recorded at a distinct slot.
-- The two currently-failing rows will land on the next cron pass after
-- this migration applies.

DROP INDEX IF EXISTS public.uniq_games_unsettled_per_pda;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_games_unsettled_per_pda_slot
  ON public.games (game, slot)
  WHERE mine_layout IS NULL;
