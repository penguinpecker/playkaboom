-- Deep referral tracking: per-visit attribution from click → signup → on-chain
-- set_referrer.
--
-- Why a row-per-visit table instead of just bumping counters: we want to
-- attribute a *signup* (wallet connect after a /r/<code> click) and a
-- *confirmation* (set_referrer ix landing) back to the specific click that
-- brought the visitor in. This lets the referrals dashboard show
-- "12 clicks → 4 signups → 2 confirmed" instead of just an opaque counter.
--
-- The funnel:
--   1. /r/<code>  →  insert referral_visits(code, session_id) + click_count++
--   2. wallet connects with kb.ref.session cookie still set →
--      visit.wallet = X, visit.signed_up_at = now, signup_count++
--   3. set_referrer ix lands on-chain with that same wallet as player →
--      visit.set_referrer_signature = sig, visit.set_referrer_at = now,
--      confirmed_count++

-- Per-visit row. session_id is a random UUID set as a cookie on the /r/<code>
-- response so subsequent client calls can correlate to the original click.
CREATE TABLE IF NOT EXISTS public.referral_visits (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text NOT NULL REFERENCES public.referral_codes(code) ON DELETE CASCADE,
  session_id               text NOT NULL,
  wallet                   text,
  signed_up_at             timestamptz,
  set_referrer_signature   text,
  set_referrer_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_visits_code_idx     ON public.referral_visits(code);
CREATE INDEX IF NOT EXISTS referral_visits_wallet_idx   ON public.referral_visits(wallet);
CREATE INDEX IF NOT EXISTS referral_visits_session_idx  ON public.referral_visits(session_id);
-- A wallet can only "claim" one visit row per session — duplicate signup
-- pings are no-ops via this unique partial index.
CREATE UNIQUE INDEX IF NOT EXISTS referral_visits_session_wallet_idx
  ON public.referral_visits(session_id) WHERE wallet IS NOT NULL;

ALTER TABLE public.referral_visits ENABLE ROW LEVEL SECURITY;
-- No policies = service role only. Visit data isn't browseable by anon.

-- Top-level counters on referral_codes for fast dashboard reads. The detail
-- table above stays as the source of truth; these are derived but cached so
-- the dashboard isn't doing a COUNT() on every render.
ALTER TABLE public.referral_codes
  ADD COLUMN IF NOT EXISTS signup_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confirmed_count integer NOT NULL DEFAULT 0;
