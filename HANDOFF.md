# PlayKaboom — Session Handoff

A self-contained snapshot you can paste into a fresh Claude session to pick up where the previous session left off. Refreshed **2026-05-08** (post-Phase H + post-indexer-self-heal). Full session-by-session log lives in `records.txt`.

## STATUS — 2026-05-08 (mainnet, fully multisig-controlled)

**Live on Solana mainnet at https://playkaboom.gg.** Every privileged authority is on Squads or Turnkey. No single key can move admin levers.

| Authority | Address | Type |
|---|---|---|
| `vault.owner` | `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5` | Squads vault PDA |
| `vault.treasury` | `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5` | Squads vault PDA |
| `vault.house_authority` | `7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp` | Turnkey HSM (game ixs only) |
| BPF upgrade authority | `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5` | Squads vault PDA |
| Squads multisig config | `H8MdHx8pHvhrA5kTziSFszKNWMVJ1SUorR8hmezTdoUm` | threshold 2-of-2, time_lock 0 |
| Squads member 1 | `6wvvcCZ44f9AeJPC7k1VKMNdexCUsuwpaw1sZjyktGr1` | Initiate + Vote + Execute |
| Squads member 2 | `EchyZCoLtfDjcpY7dWEAurmzyGqSHKGMeE2sKfpcg4MG` | Initiate + Vote + Execute |
| Program ID (mainnet) | `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh` | |
| Vault PDA | `9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK` | program-owned, ~11.13 SOL |
| Deployer wallet | `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG` | zero admin powers — fee-payer only |

**Key implication:** a stolen deployer or Turnkey key gets you nothing material. Turnkey can sign game ixs only (start/reveal/settle); admin/treasury/upgrade all need Squads 2/2.

## Live config + economics (mainnet vault)

| Param | Value | Notes |
|---|---|---|
| `house_edge_bps` | 200 (2.00%) | 2× Stake/BC's 1%. Tradeable for volume. |
| `max_bet_bps` | 200 (2% of vault) | At 11 SOL vault → 0.222 SOL max |
| `max_payout_bps` | **5000 (50% of vault)** ⚠️ | Industry std is 0.5–1%. **Single biggest risk fix** queued |
| `treasury_split_bps` | 5000 (50/50) | LP gets half, treasury gets half |
| `total_games` lifetime | 21 | Test/early traffic |
| Vault PDA balance | ~11.13 SOL | LP + obligations + accrued fees |
| LP unit accounting | seed 90.83% / house 9.08% / users 0.09% | seed permanently locked by design |

Math is locked: 2% edge × handle = GGR every dollar wagered, regardless of strategy or mine count. No formula escapes it (verified for all 5 mine options × all reasonable cashout points). Realized hold over 14 games was +38.7% but that's noise; converges to 2% by ~1000 games.

## Stack & infra

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, Tailwind, Privy embedded wallets |
| RPC | Alchemy mainnet (deploy & user reads); public mainnet for fallback |
| Indexer | Helius webhook → Supabase Postgres (fed via inline-ingest in /api/reveal + /api/settle, plus GH Actions cron every 5min via /api/cron/index-events for redundancy) |
| House signing | Turnkey HSM — signs reveal/settle ixs only |
| Hosting | **Vercel kaboomweb3-6280 account, project `playkaboom`** (not the older `penguinpecker1-4937` account, which has been retired) |
| Auto-deploy | **GitHub Actions** (`.github/workflows/vercel-deploy.yml`) — every push to main → `vercel deploy --prod` via repo secrets. Vercel native git integration was a dead-end (new account has no GitHub Login Connection, no token can substitute). |
| DB | Supabase project `vrxeqgynejlnmwsifvml` |
| Sensitive secrets | Vercel-only encrypted env (TURNKEY_*, SUPABASE_SERVICE_ROLE_KEY, PRIVY_APP_SECRET, SESSION_ENC_KEY, HELIUS_WEBHOOK_AUTH, CRON_SECRET). Local `.env.local` files are public values only — restore via `vercel env pull` if ever needed (stripped 2026-05-08). |

## Indexer reliability

- **Inline-ingest** runs after every reveal+settle tx; retries `getTransaction` up to 4× with backoff (5.2s worst case) to handle RPC propagation lag (1-3s)
- **Cron** at `/api/cron/index-events` triggered by GH Actions every 5 min (free-tier throttling means actual cadence is more like 1-3h — tolerable now). Pages `getSignaturesForAddress` with a **100-sig safety window** past the cursor so historically-failed sigs always get re-checked. `processed_events` dedup keeps it idempotent.
- **One-shot rescue**: `?reset=1` query param (CRON_SECRET-gated) nullifies `until`, pulls 600 sigs from head. Or trigger via workflow_dispatch input `reset=true` on the index-events workflow.

Bug found + fixed 2026-05-08 evening: pre-fix, games with 13+ mines silently dropped because `mine_count BETWEEN 0 AND 12` CHECK constraint was stale (program later bumped MAX_MINES to 15). Migration `20260508000002_mine_count_15.sql` fixes it. After the fix + a `?reset=1` cron run, games table is in sync with on-chain.

## Recent shipped — 2026-05-08

(Newest first, all live on production.)

| Commit | What |
|---|---|
| `701e008` | DB: bump games.mine_count CHECK 0..12 → 0..15 (the silent-drop bug) |
| `949e5a3` | CI: index-events workflow accepts `reset=true` input |
| `65b5dc7` | Indexer self-heal: cron safety window + ?reset=1 + inline-ingest retry |
| `45d8d2d` | Revert "inline SVG logo" (unrelated local edit accidentally bundled) |
| `55537af` | CI: server-side build (vercel deploy --prod, NOT --prebuilt) |
| `037de32` | CI: pass Vercel token via env: block, not --token= inline |
| `675eeba` | CI: new `.github/workflows/vercel-deploy.yml` for auto-deploy |
| `74ce0cc` | Mobile: /logs cards, /leaderboard flex layout; ref-code prefetch on auth |
| `5bed0a4` | XP ledger (silent — service-role-only DB grants, no UI yet) |
| `c0b6a57` | Withdraw confirmation screen + /logs MY WALLET ACTIVITY (localStorage) |
| `ae5bbc4` | MAX bet button + withdraw uses useSignTransaction (Privy embedded) |
| `b8fc4db` | Resume banner timing fix + ENGAGE wallet-disconnect + dedupe footer |
| `65d9441` | WITHDRAW button + modal in profile dropdown |
| `59fa469` | /play mobile overhaul (Grid responsive, Navbar shrunk) |

Phase H (full multisig handover) landed earlier in the day:
- D1: atomic update_vault + allowlist_add + propose_owner
- D2: Squads-signed `accept_ownership` (tx `4SxxC3X…`) → vault.owner = 464Fe…
- D3: `solana program set-upgrade-authority` → BPF auth = 464Fe…

## Pending / queued for next session

**Highest priority (single Squads 2/2 vote each):**
1. **`update_vault`: max_payout_bps 5000 → 100.** A single 12-mine win at max bet currently drains 50% of vault in one round (P=0.055% per attempt). Industry std is 0.5–1%. Biggest survival risk we have.
2. **`update_v2_config`: min_health_bps 1000 → 2000.** Auto-pause earlier when stressed.
3. **Optional: `house_edge_bps` 200 → 100** to match Stake/BC if competing on price. Or keep 2% for non-comparing SOL-native users.

**Loyalty / XP rollout (when ready):**
- Add LP tier multiplier feeder: `tier_mult_bps = 10000 + min(5000, lp_share_of_vault × 500000)` reading live from `LpPosition.units / v2.total_units`
- Add daily streak feeder: +5%/day, caps +25%, resets on missed 24h
- Public the `points_balance` view: `grant select on public.points_balance to anon, authenticated;`
- Create `/api/points/[wallet]` reader; surface in profile dossier
- Defer airdrop / token decision; the daily Merkle commit infra can be added later

**Operational:**
- Squads time_lock 0 → 24h (one-shot 2/2 vote, gives reaction window if a member key gets compromised)
- Migrate cron trigger from GH Actions (irregular) to cron-job.org or Cloudflare Worker for true 5-min cadence. Safety window mitigates current irregular cadence so it's not urgent
- Old Vercel account `penguinpecker1-4937` — user already deleted the playkaboom project there per their commitment; verify no lingering references
- Verified-program flag on Solscan (deterministic build mismatch deferred from PART 7; needs amd64 VPS or OtterSec coordination)

**Cleanup considerations:**
- Cross-device sync for /logs MY WALLET ACTIVITY — currently localStorage-only. Would need a `wallet_actions` Supabase table + `/api/wallet-activity` if multi-device matters
- Helius webhooks were deferred per user; re-evaluate if push-based event ingestion becomes valuable (current poll-based + inline-ingest model works at current scale)

## How to deploy

**Auto:** push to main. The `Vercel Deploy` Actions workflow (`.github/workflows/vercel-deploy.yml`) builds + ships in 2-3 min. Concurrency group cancels in-flight runs on newer pushes.

**Manual fallback** (if Actions is broken or you want to skip CI):
```bash
cd ~/Projects/playkaboom
# Token persisted at root .env.local as VERCEL_TOKEN= (gitignored)
source <(grep ^VERCEL_TOKEN= .env.local)
npx vercel --prod --token="$VERCEL_TOKEN" --yes
```

**Apply a Supabase migration:**
```bash
cd ~/Projects/playkaboom
supabase db push --linked --include-all
```

**One-shot indexer rescue** (if games-table out-of-sync with on-chain):
```bash
gh workflow run index-events.yml --repo penguinpecker/playkaboom --ref main -f reset=true
```

## Critical lessons (carried forward)

1. **Squads V4 Tx Builder Raw data field expects base58, NOT hex.** Hex passes the form silently but produces broken tx data. Encode discriminators as base58. (Saved as feedback memory.)
2. **Vercel Sensitive env vars are non-decryptable by API or `vercel env pull`.** To run admin ops needing them, trigger via existing GH Actions workflows that already have the secret as a repo secret.
3. **GitHub Actions secret-masking breaks `--token=${{ secrets.X }}` inline.** Use the job's `env:` block; CLIs auto-read.
4. **`gh secret set X --body -` sets the value to literal "-".** Omit `--body` entirely; `gh` reads stdin by default.
5. **`vercel build --prebuilt` fails for Next routes that need runtime ctx.** Use `vercel deploy --prod` (server-side build).
6. **Don't bundle untracked local files into commits even on "push the rest".** Surface unknown files and ask; never silently include. (Saved as feedback memory.)
7. **No secret fragments in committed docs** — even truncated forms (`abc1234…xyz`) leak identity. Refer by env-var name only. (Saved as feedback memory.)
8. **Operator-first deploy, multisig handoff at the literal end** — building under single-key control is fast; flipping authorities should be the last step. (Saved as feedback memory.)

## Repo layout (for orientation)

```
playkaboom/
├── apps/web/                  Next.js 15 app + API routes
│   ├── src/app/api/cron/      index-events (Solana → Supabase indexer)
│   │                          vault-health (alerts on health crit)
│   ├── src/app/api/admin/     backfill-points (XP retroactive, CRON_SECRET-gated)
│   ├── src/server/            indexer.ts, inline-ingest.ts, points.ts,
│   │                          turnkey-signer.ts, auth.ts, etc.
│   └── src/components/        Navbar, Footer, modals, game/, ui/
├── programs/kaboom/src/lib.rs Anchor program
├── packages/sdk/              TS instruction builders + decoders
├── packages/shared/           Zod schemas + multiplier math + constants
├── supabase/migrations/       Postgres migrations
├── scripts/                   ops scripts (rotate-to-squads, backfill, etc.)
├── .github/workflows/         CI: ci.yml, codeql.yml, index-events.yml,
│                              vault-health.yml, vercel-deploy.yml
├── records.txt                full session log (≈2200 lines)
└── HANDOFF.md                 this file
```

## Quick verification commands

Health check without leaving terminal:
```bash
# Vault state
solana account 9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK \
  --url https://api.mainnet-beta.solana.com

# DB row count
curl -s 'https://playkaboom.gg/api/activity/global?limit=1' \
  | python3 -c 'import json,sys; print("rows:", len(json.load(sys.stdin)["events"]))'

# Last auto-deploy
gh run list --repo penguinpecker/playkaboom \
  --workflow=vercel-deploy.yml --limit 1

# Indexer cron health
gh run list --repo penguinpecker/playkaboom \
  --workflow=index-events.yml --limit 3
```
