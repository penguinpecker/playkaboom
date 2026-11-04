-- Ported from supabase/migrations/20260516000001_game_session_keys_delegated_at.sql for plain Postgres (Railway).
-- No Supabase-only statements; verbatim.

-- Magicblock ER lazy-delegate state.
--
-- Historical (pre-2026-11-04 relaunch): this described the old commit-reveal
-- ER path, house-signed through Turnkey (retired). The column is kept for schema
-- history; the relaunch program is VRF-only.
--
-- /api/reveal runs delegate_game (house-signed, L1) on the first reveal
-- call for a Magicblock-routed game, then writes delegated_at so subsequent
-- reveals skip the delegate step. NULL means "not yet delegated"; the row
-- is created by /api/commit's storeSessionKey and the column stays NULL
-- until the first successful delegate_game lands.

ALTER TABLE public.game_session_keys
  ADD COLUMN IF NOT EXISTS delegated_at timestamptz;

COMMENT ON COLUMN public.game_session_keys.delegated_at IS
  'Timestamp when delegate_game landed on L1 for this game. NULL = not yet delegated. Set by markDelegated() in session-keys.ts on first successful reveal.';
