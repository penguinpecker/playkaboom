-- Short referral codes mapped to wallets.
--
-- Why a server-side mapping instead of a client-derivable hash:
--   1. Tamper resistance — the wallet that codes resolve to is set when
--      the OWNER (the wallet itself, via authenticated API) claims their
--      code. A malicious actor cannot mint a code for someone else's
--      wallet because the API checks the bearer-token wallet matches.
--   2. Tracking — click_count + last_visited_at make the referral page
--      meaningfully informative ("12 visits, 3 sign-ups") instead of
--      showing only on-chain accruals.
--   3. Revocable — if a code gets associated with abuse (e.g. spammed in
--      bot replies), service role can null/replace it without rotating
--      the underlying wallet.
--
-- Code format: 6 lowercase chars from a 30-char alphabet
-- (a-z minus i,l,o,u + digits 2-9). 30^6 ≈ 729 million codes; with
-- birthday-paradox math we'd expect ~27k codes before any collision, far
-- past any realistic referral volume. The API retries on PK conflict.
CREATE TABLE IF NOT EXISTS public.referral_codes (
  code            text PRIMARY KEY,
  wallet          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  click_count     integer NOT NULL DEFAULT 0,
  last_visited_at timestamptz,
  -- One code per wallet — saves us from mint-spam and keeps the URL stable
  -- once a wallet has shared it. If we ever want vanity codes per
  -- campaign, drop this and add a `purpose` column.
  CONSTRAINT one_code_per_wallet UNIQUE (wallet)
);

CREATE INDEX IF NOT EXISTS referral_codes_wallet_idx
  ON public.referral_codes(wallet);

-- RLS: deny anon access. The service role used by Next.js API routes
-- bypasses RLS, so server-side reads/writes work as before. Anonymous
-- readers cannot iterate the table to harvest the wallet ↔ code map.
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
-- No policies = no access for anon/authenticated roles. Only service_role
-- can read/write.
