-- ────────────────────────────────────────────────────────────────────────────
-- 2026-05-21 — Schema hardening (defense-in-depth CHECK constraints +
-- missing indexes + cron seed row).
--
-- These are all additive constraints / indexes that codify invariants the
-- application already maintains. They turn silent corruption into explicit
-- 23514 errors that the indexer's terminal-PG-code handler will surface
-- once (the matching app change is in apps/web/src/server/indexer.ts).
-- ────────────────────────────────────────────────────────────────────────────

-- referral_codes.code must be 6 chars from the documented 30-char alphabet
-- (lowercase a-z minus i,l,o,u + digits 2-9). The mint helper enforces this
-- today; the CHECK guarantees a stray service-role insert can't pollute the
-- table with a code shape that mismatches /r/<code> resolver expectations.
ALTER TABLE public.referral_codes
  DROP CONSTRAINT IF EXISTS referral_codes_code_shape;
ALTER TABLE public.referral_codes
  ADD CONSTRAINT referral_codes_code_shape
  CHECK (code ~ '^[a-hj-km-np-tv-z2-9]{6}$');

-- referral_visits.session_id is a server-set UUID cookie. Empty-string is a
-- silent failure mode of the cookie-parser path: an empty value passes the
-- NOT NULL constraint, but then collides with the partial unique index
-- `(session_id) WHERE wallet IS NOT NULL` — one bad row would block every
-- subsequent wallet claim. CHECK length so a misparse 4xx's loudly.
ALTER TABLE public.referral_visits
  DROP CONSTRAINT IF EXISTS referral_visits_session_id_shape;
ALTER TABLE public.referral_visits
  ADD CONSTRAINT referral_visits_session_id_shape
  CHECK (length(session_id) BETWEEN 16 AND 128);

-- processed_events: the cron sweeps + retention queries use `processed_at`
-- as the filter column. Today the table is small; at scale the missing
-- index forces a full table scan on every sweep. Add the index now so we
-- don't notice it 6 months from now during a retention purge.
CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at
  ON public.processed_events (processed_at DESC);

-- cron_indexer_state: ensure a `kaboom` row exists at deploy time. Without
-- this, the indexer's UPDATE-only cursor write silently no-ops on a fresh
-- environment and the ingester appears to "work" while never advancing.
INSERT INTO public.cron_indexer_state (program)
  VALUES ('kaboom')
  ON CONFLICT (program) DO NOTHING;

-- last_slot sanity. Defaults to 0; nothing else should ever go negative.
ALTER TABLE public.cron_indexer_state
  DROP CONSTRAINT IF EXISTS cron_indexer_state_last_slot_nonneg;
ALTER TABLE public.cron_indexer_state
  ADD CONSTRAINT cron_indexer_state_last_slot_nonneg
  CHECK (last_slot >= 0);
