# Secrets management

Last reviewed: 2026-05-06.

## Inventory

Every secret used by playkaboom.gg, where it lives, what compromises it,
and how to rotate. **Mark every entry in this list as Sensitive in Vercel
project settings** — Sensitive vars are write-only after creation: the
Vercel API and dashboard cannot read them back, only overwrite. This is
the single most important defense against the recent class of platform
incidents (Vercel preview-URL exposure, Railway CDN cache leak).

| Var | Scope | Risk if leaked | Where it lives | Rotation cost |
|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | server | full DB read+write, bypasses RLS | Vercel env, `.env.local` | 1 click in Supabase → reissue |
| `PRIVY_APP_SECRET` | server | mint server-issued auth tokens, impersonate any user | Vercel env, `.env.local` | Privy dashboard → Rotate |
| `TURNKEY_API_PRIVATE_KEY` | server | sign as the house authority on-chain (drain payouts via legitimate ixs) | Vercel env, `.env.local` | Turnkey dashboard → New API key, then `update_vault` to swap house authority |
| `TURNKEY_API_PUBLIC_KEY` | server | half of the P-256 keypair; useless alone | Vercel env, `.env.local` | Reissued together with private key |
| `TURNKEY_ORG_ID` | server | identifies our org; not secret per se but private | Vercel env | n/a |
| `SESSION_ENC_KEY` | server | decrypt all stored game sessions, recover mine layouts mid-game | Vercel env, `.env.local` | Generate new, re-encrypt active sessions, drop stale rows |
| `HELIUS_WEBHOOK_AUTH` | server | spoof webhook payloads to corrupt indexer | Vercel env, `.env.local` | Helius dashboard → Rotate |
| `CRON_SECRET` | server | trigger our cron without rate limit (low impact, idempotent) | Vercel env, GitHub Actions secret | Generate new in both places |

## Public-by-design (intentionally exposed in client bundle)

These start with `NEXT_PUBLIC_*` and **are baked into the JavaScript that
ships to every browser**. Do not put anything sensitive here.

| Var | What's in it | Why it's safe |
|---|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app identifier | Pairs with `PRIVY_APP_SECRET` server-side; ID alone can't authenticate |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon JWT | Constrained by Postgres RLS — can only do what RLS allows |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Public endpoint |
| `NEXT_PUBLIC_PROGRAM_ID` | Anchor program ID | Public on-chain account |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | "devnet" / "mainnet-beta" | Trivial |

## Known issue: Alchemy API key in client bundle

`NEXT_PUBLIC_SOLANA_RPC` currently embeds `https://solana-devnet.g.alchemy.com/v2/-j7ptOh-PDq8Dzh8PqnQ-`
in the client bundle. Anyone visiting the site can extract the key and
spend our Alchemy quota.

**Severity**: medium — quota drain (cost / DoS), not data exfiltration.
The endpoint is read-only RPC; nothing on Alchemy is account-scoped beyond
quota.

**Fix (planned)**: proxy reads through `/api/rpc/devnet` so the key only
exists server-side. Implementation:

```ts
// apps/web/src/app/api/rpc/[cluster]/route.ts
export async function POST(req: NextRequest, { params }: { params: { cluster: "devnet" | "mainnet-beta" } }) {
  // Re-check rate limit per IP, validate the JSON-RPC method (allow-list
  // safe methods: getAccountInfo, getSignatureStatuses, getSlot, getBlockHeight,
  // getLatestBlockhash, sendTransaction, simulateTransaction, ...).
  // Forward to process.env.SOLANA_RPC, return body verbatim.
}
```

Then update `cluster.ts` to use `/api/rpc/devnet` for the client `Connection`.
This also gives us central rate-limiting and request logging — useful for
spotting abuse or integration bugs.

## Rotation runbook

Run on a calendar (every 90 days) AND immediately after any of:

- Confirmed leak (e.g. accidental commit, bug bounty report, screenshot in support thread)
- Departure of anyone who had access to Vercel team / Supabase project / Turnkey org
- A public CVE in any dependency that ships secrets through environment
  variables (Vercel pre-render, Next.js fetch cache poisoning, etc.)

Order matters — the Turnkey rotation requires a working Turnkey signature
to swap the on-chain house authority, so don't rotate it first if you
suspect compromise (do `update_vault` to a fresh raw key as a break-glass,
then re-Turnkey from there).

```bash
# 1. SESSION_ENC_KEY — generate, deploy, then discard old key
openssl rand -hex 32              # set as new SESSION_ENC_KEY in Vercel
# Active sessions encrypted under the old key become unrecoverable; that
# only blocks cross-device resume for in-flight games. Players can still
# refund_expired or close_unsettled_game on stuck games.

# 2. SUPABASE_SERVICE_ROLE_KEY
# Supabase dashboard → Settings → API → "Reset" service_role key

# 3. PRIVY_APP_SECRET
# Privy dashboard → Settings → API Keys → Rotate

# 4. TURNKEY_API_PRIVATE_KEY (paired with public key)
# Turnkey dashboard → API Keys → New
# Then update SOLANA_RPC etc. on Vercel to match.

# 5. CRON_SECRET
openssl rand -hex 32              # set in Vercel + `gh secret set CRON_SECRET`
```

After every rotation: trigger a Vercel redeploy so the new env var is in
the running pods. Edge runtime caches env per build — no auto-refresh.

## What we DON'T store anywhere

- Player private keys — held by Privy in user-controlled embedded wallets;
  we have zero access. (Privy custody is currently non-multisig / seedphrase
  recoverable per the user's flow choice.)
- Raw house authority key — retired 2026-05-06. The on-chain authority is
  Turnkey wallet `3TCMevgU…dQKWL`; we sign through Turnkey API with a P-256
  key whose private half never leaves Turnkey HSM.
- Mine layouts — held only in encrypted form (SESSION_ENC_KEY) for the
  duration of a game; revealed on-chain at settle and nowhere else.

## Lessons from recent platform incidents

The **Vercel preview-URL exposure** (mid-2026) was caused by Vercel returning
preview deployment metadata via a public API endpoint that included
non-Sensitive env vars. Mitigation: mark every secret Sensitive (write-only)
in Vercel project settings — applies retroactively; existing values are
re-stored encrypted and become invisible to subsequent reads.

The **Railway CDN cache poisoning** showed how a CDN edge can leak
short-lived per-request data across users. Mitigation we already follow:
all secrets live in environment variables, never in URL paths or query
strings; CSP `connect-src` is host-allowlisted so a compromised CDN edge
can't be used to exfiltrate data to an attacker-controlled host. The
recent CSP tightening (2026-05-06: dropped Helius/Triton/WalletConnect
hosts that aren't actually called from the browser) shrinks this surface
further.

## Defense-in-depth checklist (state today)

- [x] All secrets in environment variables, none committed to git
- [x] `.env.local` files gitignored; `.env.example` committed without values
- [x] Server-only secrets never exposed via `NEXT_PUBLIC_*`
- [x] CSP `connect-src` host-allowlisted
- [x] Trusted Types enforced where supported
- [x] HSTS preloaded (production)
- [x] Turnkey HSM holds the house signing key
- [ ] Mark every var Sensitive in Vercel (manual UI step — do this NOW)
- [ ] RPC proxy to hide Alchemy key from client bundle
- [ ] Squads 2-of-2 multisig on owner key
- [ ] Squads 2-of-2 multisig on program upgrade authority
- [ ] Calendar reminder for 90-day rotation
- [ ] `secret-scan` GitHub Action so a stray commit fails CI
