-- Magicblock ER lazy-delegate state.
--
-- /api/reveal runs delegate_game (Turnkey-signed, L1) on the first reveal
-- call for a Magicblock-routed game, then writes delegated_at so subsequent
-- reveals skip the delegate step. NULL means "not yet delegated"; the row
-- is created by /api/commit's storeSessionKey and the column stays NULL
-- until the first successful delegate_game lands.

ALTER TABLE public.game_session_keys
  ADD COLUMN IF NOT EXISTS delegated_at timestamptz;

COMMENT ON COLUMN public.game_session_keys.delegated_at IS
  'Timestamp when delegate_game landed on L1 for this game. NULL = not yet delegated. Set by markDelegated() in session-keys.ts on first successful reveal.';
