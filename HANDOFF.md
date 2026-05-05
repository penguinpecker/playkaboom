# PlayKaboom — Session Handoff

A self-contained status doc you can paste into a new Claude session. Up-to-date as of commit `fa89d0f` (security pass).

## TL;DR

Provably-fair on-chain Mines casino on Solana. Anchor program + Next.js 15 frontend + Supabase indexer. Built to deploy to mainnet. Code is feature-complete for P1 devnet alpha; deployment is gated on toolchain install + account setup.

- **Repo**: https://github.com/penguinpecker/playkaboom
- **Local path**: `~/Desktop/Projects/playkaboom`
- **Domain**: `playkaboom.gg` (not yet pointed)
- **Current state**: code complete for P1; needs Anchor build + devnet deploy + env vars to play end-to-end

## Architecture (one paragraph)

Server-assisted commit-reveal Mines. Server generates mine layout + 32-byte salt, commits `SHA256(layout || mine_count || salt)` on-chain when the player calls `start_game`. Server signs each tile reveal. On settle (win or loss) the server publishes `(layout, salt)` and the program verifies the hash matches and every recorded reveal is consistent. Per-player `PlayerStats` and per-referrer `ReferralAccount` PDAs accrue on-chain, indexed off-chain in Supabase via Helius webhooks.

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Domain `playkaboom.gg` | confirmed by user |
| 2 | Game roster: Mines only | scope discipline; expand to dice/plinko at P3 |
| 3 | No geographic block | self-selecting crypto-native players; ToS instead; no fiat ramps reduce regulated exposure |
| 4 | 2-of-2 Squads multisig as `owner` and `treasury` | simplest M-of-N for two-person operation |
| 5 | Audits skipped before mainnet | accepted risk; defended by on-chain bet/payout caps + bug bounty |
| 6 | VRF: Switchboard On-Demand | TEE-attested oracle, on-chain submission, recent but adequate; user preference over ORAO |
| 7 | Treasury split: 50% to treasury, 50% retained as vault liquidity | editable via `update_vault`, withdrawals only to allowlisted addresses (max 8) |
| 8 | Stats + leaderboard: `PlayerStats` PDA on-chain (truth) + Helius webhook → Supabase (fast queries) | trustless source of truth, fast UI |
| 9 | Referrals: 25/30/35% of house edge by tier, on-chain accrual, manual claim | matches Stake/Rollbit norms; tier auto-upgrades by referred volume |
| 10 | Hosting: Vercel (frontend + API routes) + Supabase (Postgres) | no Railway needed; serverless functions handle every workload |
| 11 | Auth: Privy embedded wallets (default) + native adapters | wallet-less UX for new users, power users keep their keys |
| 12 | Token: SOL only at P1; USDC at P3+ | Solana-native, simplest |

## Tech stack

| Layer | Pick | Why |
|---|---|---|
| Runtime | Node 20, Next.js 15, React 19 | App Router, server components |
| Auth | Privy + `@privy-io/server-auth` | embedded wallets + social login + server-side JWT verification |
| RPC primary | Helius Professional | webhooks + priority-fee oracle + 99.9% SLA |
| RPC fallback | Triton One | independent infra |
| VRF | Switchboard On-Demand | TEE-attested |
| Indexer | Helius webhooks → Supabase Postgres | one writer, public reads |
| DB | Supabase Postgres | RLS, free tier ample for P1 |
| Cache / RL | Upstash Redis (sliding window) | already wired |
| Queue | Upstash QStash | when needed for retries |
| Email | Resend | growth notifications later |
| Errors | Sentry (browser + server) | P2 |
| Uptime | Better Stack | $24/mo, status page included |
| Hosting | Vercel Pro | Next.js native |
| Multisig | Squads | Solana standard |
| Bug bounty | Immunefi | P3 |

## Repository layout

```
playkaboom/
├── apps/web/                  Next.js 15 frontend + API routes
│   ├── src/app/               Pages: /, /play, /vault, /leaderboard, /referrals, /logs
│   ├── src/app/api/           commit, reveal, settle, cleanup, health, game/[player]
│   ├── src/components/        layout (Navbar, Footer, MobileDrawer), game (Grid, Tile, BetControls), modals (8 types), providers (web3, modal, toast), ui (KaboomLogo, Icons)
│   ├── src/hooks/             use-game-actions, use-vault, use-player-stats, use-referral, useGame (compat), useContracts (compat), useGameHistory, useToast, useModal
│   ├── src/server/            env, auth (Privy verify), session (AES-256-GCM), game (mine layout), solana (sender + RPC), webhook-auth (HMAC), player (referrer cache), db/supabase, db/types
│   ├── src/stores/            game-store, history-store (Zustand)
│   ├── src/lib/               cluster, api, format, compat (wagmi-shim), chain
│   └── tailwind.config.ts     Deep-purple theme #1b0639, primary #a4c9ff, etc.
├── programs/kaboom/           Anchor program (Rust)
│   └── src/lib.rs             Vault, GameSession, PlayerStats, ReferralAccount + 12 instructions
├── packages/sdk/              TS SDK (instruction builders, account decoders, verify)
├── packages/shared/           Constants + zod schemas + multiplier math
├── supabase/
│   ├── migrations/
│   │   ├── 20260505000001_init.sql        Schema: player_stats, games, referrals, referral_events, processed_events + 3 leaderboard views
│   │   └── 20260505000002_security.sql    CHECK constraints, FORCE RLS, role grants, updated_at trigger
│   └── config.toml
├── tests/
│   ├── anchor/runner.ts       Integration runner stub (fill in once toolchain in)
│   └── sdk/*.test.ts          Vitest: multiplier, verifier, instruction builders
├── ROADMAP.md                 Phases + tech stack + run-rate
├── SECURITY.md                Threat model + defense-in-depth controls
├── HANDOFF.md                 (this file)
├── README.md
├── CONTRIBUTING.md
├── Anchor.toml                Program IDs (devnet + mainnet placeholders)
├── Cargo.toml                 Workspace
├── package.json               npm workspaces + turbo
└── .env.example               Template (real values in .env.local, gitignored)
```

## Status: DONE ✅

### On-chain program (`programs/kaboom/src/lib.rs`)

| Feature | Where | Notes |
|---|---|---|
| `initialize_vault` | line ~67 | Sets owner, house_authority, treasury, default 50/50 split, empty allowlist |
| `fund_vault` | ~96 | Anyone can deposit |
| `set_referrer` | ~108 | Player one-time stamps referrer; init_if_needed for both stats + referral PDAs |
| `start_game` | ~154 | Bet caps enforced, init_if_needed PlayerStats |
| `reveal_tile` | ~218 | House signs, expiry-aware |
| `cash_out` | ~282 | Player signs, defense-in-depth solvency check |
| `settle_game` | ~322 | Verifies SHA-256 commit, updates PlayerStats, credits referrer (optional remaining_account) |
| `claim_referral` | ~440 | Referrer drains accrued lamports |
| `refund_expired` | ~471 | Player recovery after 300 slots |
| `close_game` | ~501 | Rent reclaim |
| `withdraw_to_treasury` | ~514 | Treasury signer + allowlist enforced |
| `update_vault` | ~558 | Owner-only config + treasury_split_bps + new_treasury |
| `allowlist_add` / `allowlist_remove` | ~596 / ~625 | Owner manages withdrawal targets |

### Accounts

| Account | Seeds | Purpose |
|---|---|---|
| `Vault` | `[kaboom_vault]` | House bankroll, config, allowlist |
| `GameSession` | `[kaboom_game, player]` | One active game per player |
| `PlayerStats` | `[kaboom_stats, player]` | Lifetime stats, optional referrer |
| `ReferralAccount` | `[kaboom_referral, referrer]` | Per-referrer accrual + tier |

### Events emitted

`VaultInitialized`, `VaultFunded`, `VaultUpdated`, `AllowlistChanged`, `TreasuryWithdrawal`, `GameStarted`, `TileRevealed`, `GameWon`, `GameLost`, `GameSettled`, `GameRefunded`, `StatsUpdated`, `ReferrerSet`, `ReferralAccrued`, `ReferralTierChanged`, `ReferralClaimed`. All carry `slot`.

### TypeScript SDK (`packages/sdk`)

- PDA derivers: `deriveVaultPda`, `deriveGamePda`, `derivePlayerStatsPda`, `deriveReferralPda`
- Instruction builders for every program ix (above)
- Account decoders: `decodeVault`, `decodeGameSession`, `decodePlayerStats`, `decodeReferralAccount`
- `computeCommitment` / `verifyGame` (uses `@noble/hashes`, browser + node safe)
- `KaboomClient` for RPC reads + v0 tx building
- Error name extractor from logs

### Server (`apps/web/src/server/`)

- `env.ts` — lazy-validated env (HOUSE_AUTHORITY_KEY 64-byte JSON, SESSION_ENC_KEY 32-byte hex, PROGRAM_ID, SOLANA_RPC)
- `auth.ts` — Privy JWT verification + `verifyPlayerAuth(req, player)` enforces wallet ownership
- `session.ts` — AES-256-GCM with `pk1:` prefix, nonce field for replay protection
- `game.ts` — unbiased Fisher-Yates mine layout, rejection-sampled `randomBytes`
- `solana.ts` — house tx sender with priority fee + compute budget
- `webhook-auth.ts` — `timingSafeEqual` shared-secret + HMAC fallback
- `player.ts` — 60s cache for player's on-chain referrer
- `db/supabase.ts` — `supabaseAdmin()` (service role, server-only) + `supabasePublic()` (anon)
- `ratelimit.ts` — Upstash sliding window 30/10s
- `logger.ts` — pino with secret redaction

### API routes (`apps/web/src/app/api/`)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/commit` | Privy + wallet match | Generate session, return start_game ix |
| `POST /api/reveal` | Privy + wallet match | Server signs reveal_tile (atomic settle on mine), credits referrer |
| `POST /api/settle` | Privy + wallet match | Returns cash_out ix or settles after cashout |
| `POST /api/cleanup` | Privy + wallet match | Returns close + refund instructions |
| `GET /api/health` | none | Vault PDA + balance + house authority pubkey |
| `GET /api/game/[player]` | none | Active game status snapshot |

### Frontend pages (`apps/web/src/app/`)

| Page | Status |
|---|---|
| `/` (home) | Hero, stats banner, how-it-works, reactive modules, real-time intel, footer |
| `/play` | Grid + BetControls + on-chain stats sidebar |
| `/vault` | Vault health bar, contracts list, deposit form |
| `/leaderboard` | Tabs (Top Wins / Volume / Streak) backed by `/api/leaderboard` (Supabase views) with localStorage fallback |
| `/profile/[wallet]` | On-chain stats + recent games + referral status |
| `/referrals` | Pending-referrer prompt, copy link, tier ladder, claim button, my referrer |
| `/logs` | Combat log with filters + pagination |

### Theme + components

- Tailwind: deep-purple `#1b0639` base, `#a4c9ff` primary, `#fda9ff` tertiary, `#34d399` emerald, `#fbbf24` amber
- Fonts: Space Grotesk (headline) + Inter (body) via `@fontsource`
- Material Symbols Outlined icons
- Custom utilities: `stealth-card` clip-path, `kinetic-grid`, `gem-glow`, `boom-glow`, `modal-backdrop`
- 9 keyframe animations (fade-up, scale-in, shake, pop-in, slide-down, float, cash-pulse, tile-reveal, pulse)

### Database (Supabase project `kaboom`, ref `vrxeqgynejlnmwsifvml`, Tokyo)

| Table | Rows | RLS |
|---|---|---|
| `player_stats` | mirrors PlayerStats PDA | public SELECT, service_role write |
| `games` | one per settled game | public SELECT, service_role write |
| `referrals` | mirrors ReferralAccount PDA | public SELECT, service_role write |
| `referral_events` | per-credit log | public SELECT, service_role write |
| `processed_events` | webhook idempotency | service_role only |

Views: `leaderboard_alltime`, `leaderboard_volume`, `leaderboard_streaks`. CHECK constraints on every numeric. `updated_at` trigger via SECURITY DEFINER fn with `search_path=''`.

### Security

- `Content-Security-Policy` strict allow-list (Privy + Solana RPCs + Supabase + Pyth + WalletConnect)
- HSTS in prod, frame-ancestors `'none'`, COOP/CORP, Permissions-Policy locked down
- `import "server-only"` on every server module — accidental client import fails build
- All player-mutating routes require Privy auth + wallet ownership match
- Rate limit 30/10s per (IP, player)
- Schema CHECK constraints + FORCE RLS

## Status: TO-DO

### Code work (no external blockers)

| # | Item | Status |
|---|---|---|
| 26 | `/api/webhook/helius` receiver | ✅ done |
| — | `/leaderboard` switched to on-chain via `/api/leaderboard` (Supabase view) with localStorage fallback | ✅ done |
| — | `/profile/[wallet]` reading on-chain `PlayerStats` | ✅ done |
| — | SDK event decoders (`StatsUpdated`, `GameWon/Lost`, `ReferralAccrued`, etc.) | ✅ done |
| — | Anchor flow tests (`tests/anchor/runner.ts`) | ⏸ needs Anchor toolchain |
| 22 | Switchboard On-Demand VRF — server requests randomness, folds into salt before commit | ⏸ P2 |
| — | Pyth Hermes USD overlay on bet input (`SOL/USD = …`) | ⏸ |
| — | PWA manifest + service worker | ⏸ P3 |
| — | i18n scaffold (next-intl, en-US first) | ⏸ P3 |

### Account setup (you do, blocks deploy)

| Step | Where |
|---|---|
| Set `PRIVY_APP_SECRET` in `apps/web/.env.local` | https://dashboard.privy.io → app → "App secret" |
| Get Helius API key + RPC URL | https://dashboard.helius.dev |
| Generate `HELIUS_WEBHOOK_AUTH` | `openssl rand -hex 32` then mirror in Helius dashboard |
| Generate `SESSION_ENC_KEY` | `openssl rand -hex 32` |
| Generate house authority keypair | `solana-keygen new -o keypairs/house.json` then JSON-encode bytes into `HOUSE_AUTHORITY_KEY` |
| Set up Squads multisig | https://app.squads.so |
| Buy domain `playkaboom.gg` + point at Vercel | Namecheap / Cloudflare Registrar |

### Toolchain (mostly installed)

| Tool | Status |
|---|---|
| Node 20 | ✅ |
| Rust | ✅ via brew |
| Solana CLI | ✅ via brew (`solana 3.1.14`) |
| Anchor | ❌ not yet (`cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install 0.31.1 && avm use 0.31.1`) |
| Supabase CLI | ✅ via brew, logged in |
| GitHub CLI | ✅ logged in as penguinpecker |

### Deployment (after toolchain + accounts)

1. `anchor build` → `target/deploy/kaboom.so` + `target/idl/kaboom.json`
2. `anchor deploy --provider.cluster devnet` → grab program ID, update `Anchor.toml` + `PROGRAM_ID` env vars
3. Run a one-shot script calling `initialize_vault(200, 200, 5000)` and `fund_vault(2_000_000_000)` (2 SOL)
4. `vercel link` → push env vars → `vercel --prod`
5. Configure Helius webhook → `https://playkaboom.gg/api/webhook/helius` with `Authorization: <HELIUS_WEBHOOK_AUTH>`
6. Test end-to-end on devnet
7. Repeat with mainnet program (~5 SOL deploy fee)
8. Transfer `owner` + `treasury` to Squads multisig via `update_vault`
9. List on Immunefi

## How to resume in a new Claude session

Paste this block at the top of the new session:

> I'm working on PlayKaboom — a provably-fair on-chain Mines casino on Solana. Repo: `~/Desktop/Projects/playkaboom` (and https://github.com/penguinpecker/playkaboom). Read `HANDOFF.md` first for full context, then `ROADMAP.md` and `SECURITY.md`. Key locked decisions: Mines only, no geo-block, 2-of-2 Squads, Switchboard On-Demand VRF, Vercel + Supabase hosting, 25/30/35% referral rakeback. Last commit: `fa89d0f` (security pass). Auto mode is on. Pick up where the prior session left off — `HANDOFF.md` "Status: TO-DO" lists the next items.

## Resume commands (verify state)

```bash
cd ~/Desktop/Projects/playkaboom
git status -sb                       # should be clean, in sync with origin/main
git log --oneline | head -10         # see commit history
ls -la apps/web/.env.local           # verify env file exists
cat HANDOFF.md | head -50            # quick refresh
supabase migration list --linked     # confirm migrations in sync
gh repo view --web                   # open repo in browser
```

## Restart the dev server

```bash
cd ~/Desktop/Projects/playkaboom/apps/web
npx next dev -p 4000
```

Browser: http://localhost:4000

## Env vars currently set (in `apps/web/.env.local`)

```
NEXT_PUBLIC_SOLANA_CLUSTER=devnet
NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com
SOLANA_RPC=https://api.devnet.solana.com
PROGRAM_ID=Kab1TestProgam11111111111111111111111111111   # placeholder, real after anchor deploy
NEXT_PUBLIC_PRIVY_APP_ID=cmorodpkj004l0ciclclct89u
PRIVY_APP_SECRET=                                         # YOU MUST FILL FROM DASHBOARD
NEXT_PUBLIC_SUPABASE_URL=https://vrxeqgynejlnmwsifvml.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJ…(set)
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJ…(set)
HOUSE_AUTHORITY_KEY=                                      # YOU MUST GENERATE
SESSION_ENC_KEY=                                          # YOU MUST GENERATE (openssl rand -hex 32)
HELIUS_WEBHOOK_AUTH=                                      # YOU MUST GENERATE (openssl rand -hex 32)
```

## Things explicitly accepted as risk

| Risk | Why accepted |
|---|---|
| No formal audit before mainnet | On-chain bet caps + bug bounty + open source |
| No geo-block | Self-selecting players + ToS + no fiat ramps |
| Token rotation manual | Each rotation is a quick env-var update |
| Single house authority key (no MPC) | KMS upgrade is on the P3 roadmap |

## Useful contacts / endpoints

| Service | URL |
|---|---|
| GitHub repo | https://github.com/penguinpecker/playkaboom |
| Supabase project | https://supabase.com/dashboard/project/vrxeqgynejlnmwsifvml |
| Privy dashboard | https://dashboard.privy.io |
| Helius dashboard (TBD) | https://dashboard.helius.dev |
| Squads (TBD) | https://app.squads.so |
| Status page (TBD) | https://status.playkaboom.gg |
