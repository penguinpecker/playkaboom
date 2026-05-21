-- ────────────────────────────────────────────────────────────────────────────
-- 2026-05-21 — Drop game_session_keys.
--
-- This table was the encrypted-blob store for the Magicblock ER reveal path
-- (per-game ed25519 session keys, encrypted with SESSION_ENC_KEY). The
-- Magicblock spike has been abandoned and the entire ER code path is gone
-- from the web app, the SDK, and the Anchor source. The table is no longer
-- referenced by any code.
--
-- Drop is safe: rows held only encrypted ephemeral secrets keyed by
-- GameSession PDA. Any "in-flight" rows would correspond to never-settled
-- ER games — none can exist because `er_enabled` was never flipped on at
-- the program level. If a stale row somehow remained, deleting it has no
-- on-chain effect (legacy refund_expired / close_unsettled_game cover the
-- recovery surface).
-- ────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.game_session_keys;
