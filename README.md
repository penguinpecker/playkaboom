# PlayKaboom

> A fully on-chain Minesweeper-style game with a community-owned DeFi vault, built on Solana.

[![Live](https://img.shields.io/badge/live-playkaboom.gg-a4c9ff?style=flat-square)](https://www.playkaboom.gg)
[![Solana](https://img.shields.io/badge/solana-mainnet--beta-9945FF?style=flat-square&logo=solana&logoColor=white)](https://solscan.io/account/9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh)
[![License](https://img.shields.io/badge/license-MIT-emerald?style=flat-square)](LICENSE)
[![X](https://img.shields.io/badge/x-@playkaboom-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/playkaboom)

PlayKaboom is a provably-fair on-chain Mines casino on Solana mainnet. Players bet SOL, the program commits a SHA-256 hash of the mine layout up front, and publishes the layout + salt at settlement so anyone can verify the layout existed before any reveal. The vault that backs payouts is a permissionless yield vehicle — anyone can deposit SOL via `lp_deposit` and share net P&L pro-rata.

---

## Live deployment

| | |
|---|---|
| Web app | <https://www.playkaboom.gg> |
| Program ID | [`9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh`](https://solscan.io/account/9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh) |
| Vault PDA | [`9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK`](https://solscan.io/account/9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK) |
| Vault V2 State | [`6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb`](https://solscan.io/account/6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb) |
| House signer (Turnkey HSM) | [`7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp`](https://solscan.io/account/7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp) |
| Cluster | `mainnet-beta` |
| Anchor version | 0.31.1 |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                            CLIENT (browser)                            │
│  React 19 + Next.js 15 App Router · Tailwind · Privy embedded wallets  │
│                                                                        │
│  /play  /vault  /leaderboard  /referrals  /logs  /verify/[sig]         │
└────────────────────────────────────────────────────────────────────────┘
              │                                │
              │ REST                           │ Solana RPC (proxied)
              ▼                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  SERVER · Next.js Functions on Vercel                  │
│                                                                        │
│  /api/commit       /api/reveal      /api/settle      /api/cleanup      │
│  /api/vault/*      /api/leaderboard /api/activity/*  /api/whoami       │
│  /api/cron/*       /api/webhook/*   /api/verify/[sig] /api/rpc/*       │
│                                                                        │
│  Privy JWT verification · Zod schemas · Pino logger · Upstash rate-    │
│  limit · Session encryption (AES-256-GCM)                              │
└────────────────────────────────────────────────────────────────────────┘
              │                  │                       │
              │ ed25519 sign     │ HTTPS                 │ Postgres
              ▼                  ▼                       ▼
       ┌──────────────┐   ┌─────────────┐         ┌─────────────┐
       │ Turnkey HSM  │   │  Solana     │         │  Supabase   │
       │ (house sig)  │   │  mainnet    │ ──────▶ │  indexer    │
       │              │   │  (Alchemy)  │   logs  │  mirror     │
       └──────────────┘   └─────────────┘         └─────────────┘
                                 │
                                 │ Anchor 0.31 program (Rust)
                                 ▼
            ┌──────────────────────────────────────────────┐
            │   Vault · VaultV2State · GameSession PDAs    │
            │   PlayerStats · ReferralAccount · LpPosition │
            └──────────────────────────────────────────────┘
```

### Tech stack

| Layer | Technology |
|---|---|
| Smart contract | [Anchor](https://www.anchor-lang.com/) 0.31.1 (Rust), Solana mainnet-beta |
| TypeScript SDK | Hand-rolled instruction builders + account decoders + event decoders (no IDL runtime dependency) |
| Backend | [Next.js](https://nextjs.org/) 15 App Router, Vercel serverless functions (Node.js runtime) |
| Frontend | [React](https://react.dev/) 19, [Tailwind CSS](https://tailwindcss.com/), [Zustand](https://zustand-demo.pmnd.rs/), [TanStack Query](https://tanstack.com/query) |
| Auth | [Privy](https://privy.io/) (embedded wallets + social login + server-side JWT verification) |
| Hot signer | [Turnkey](https://www.turnkey.com/) HSM (TEE-backed ed25519 keypair, never local) |
| Database | [Supabase](https://supabase.com/) Postgres (indexer mirror, RLS-forced, public read / service-role write) |
| RPC | [Alchemy](https://www.alchemy.com/) Solana mainnet (HTTP + WS) |
| Rate limiting | [Upstash Redis](https://upstash.com/) sliding-window (per-IP + per-wallet) |
| Price feed | [Pyth](https://pyth.network/) Hermes (SOL/USD overlay) |
| Multisig (planned) | [Squads V4](https://squads.so/) — owner + treasury + upgrade authority handover |
| Hosting | [Vercel](https://vercel.com/) |
| CI cron | GitHub Actions (5 min Solana log indexing as backstop to inline ingest) |

---

## Provably fair

Every game uses a server-assisted commit-reveal scheme:

1. **Commit (`start_game`)** — server generates a 4×4 mine layout + 32-byte salt off-chain, computes `commitment = SHA-256(layout ‖ mine_count ‖ salt)`, and broadcasts `start_game(mine_count, bet, commitment)`. Layout + salt remain server-side.
2. **Reveal (`reveal_tile`)** — for each tile the player taps, server signs `reveal_tile(tile_index, is_mine)` via the Turnkey HSM. The session's gameToken (encrypted server-side) keeps the layout consistent across reveals.
3. **Settle (`settle_game`)** — server publishes `(mine_layout, salt)` on chain. The program recomputes the SHA-256 hash and **rejects** the settle if it doesn't match the original commitment, and **rejects** any individual reveal that's inconsistent with the published layout.
4. **Verify (`/verify/[sig]`)** — anyone can recompute the hash in their browser from public on-chain data via [`@noble/hashes`](https://github.com/paulmillr/noble-hashes). The verifier UI shows a green ✓ when the hash matches the original commitment.

If the house disappears mid-game, the player can call `refund_expired` 300 slots (~2 minutes) after start to recover their bet.

---

## On-chain accounts

| Account | PDA seeds | Purpose |
|---|---|---|
| `Vault` | `[kaboom_vault]` | House bankroll, config (edge/cap/split), withdrawal allowlist (8 entries max), pending-owner field for two-step rotation |
| `VaultV2State` | `[kaboom_v2_state]` | Phase 2 state — total LP units, house units, seed units (anti-inflation), pending withdraws, health-factor config |
| `GameSession` | `[kaboom_game, player]` | One active game per player; commitment, reveal mask, max payout reservation, expiry slot |
| `PlayerStats` | `[kaboom_stats, player]` | Lifetime stats (games played, won, wagered, biggest win, current streak); referrer field for one-time attribution |
| `ReferralAccount` | `[kaboom_referral, referrer]` | Per-referrer accrual, tier (bronze/silver/gold by volume), claimable lamports |
| `LpPosition` | `[kaboom_lp, user]` | LP units held, pending withdraw units, unlock slot, cumulative deposit/withdraw |

22 instructions cover gameplay, owner ops, LP flow, referral claim, and a one-shot `repair_referral` migration ix.

---

## LP vault

Anyone can deposit SOL into the vault PDA via `lp_deposit(amount)` and receive `units` (an LP position) that share casino P&L pro-rata. Withdrawals are timelocked behind a 3-day cooldown (`648,000` slots) — units stay live during the cooldown (still earning or losing).

- **Health factor**: dynamically scales `max_bet_bps` and `max_payout_bps` based on outstanding game obligations vs vault assets. Prevents the vault from accepting bets it can't underwrite.
- **Anti-inflation seed**: 1 SOL of locked units (carved from house seed at `initialize_v2`) prevents the first depositor from gaming unit value math.
- **House LP position**: the operator has its own LP position with a configurable minimum share floor (default 50%). The house cannot withdraw below this floor without re-balancing.
- **Treasury split**: 50% of every settle's house profit is retained in the vault (boosting unit value for all LPs); the other 50% goes to the multisig treasury.
- **Live config**: every cap is dynamically computed at `start_game` time from the current vault state. No staleness.

---

## Repository layout

```
playkaboom/
├── apps/
│   └── web/                Next.js 15 app — UI + API routes + indexer
│       ├── src/app/        pages: /, /play, /vault, /leaderboard, /referrals, /logs,
│       │                          /verify/[sig], /profile/[wallet], /terms, /privacy
│       ├── src/app/api/    REST: commit, reveal, settle, vault/*, leaderboard,
│       │                         activity/*, cron/*, webhook/*, rpc/*
│       ├── src/server/     server-only: env, auth, session, indexer, solana, turnkey
│       └── src/components/ React components (game grid, modals, providers, layout)
├── programs/
│   └── kaboom/             Anchor program (Rust, ~2.2k LOC)
│       └── src/lib.rs      Vault, GameSession, PlayerStats, ReferralAccount,
│                           VaultV2State, LpPosition + 22 instructions
├── packages/
│   ├── sdk/                TS SDK — instruction builders, account/event decoders, PDAs
│   └── shared/             constants + zod schemas + multiplier math
├── supabase/migrations/    indexer schema (player_stats, games, referrals, lp_*, ...)
├── scripts/                ops scripts (init-vault, rotate-*, upgrade, repair-*)
├── tests/                  Vitest unit tests + Anchor integration runner
├── Anchor.toml             program IDs per cluster
└── turbo.json              monorepo task graph
```

---

## Local development

### Prerequisites

- Node 20+
- Rust + [Solana CLI](https://docs.anza.xyz/cli/install) + [Anchor](https://www.anchor-lang.com/) 0.31.1 (only needed to build/deploy the program)

### Install + run web app

```bash
npm install
cp .env.example apps/web/.env.local
# Fill in PRIVY_APP_SECRET, SESSION_ENC_KEY (openssl rand -hex 32),
#         SUPABASE_*, TURNKEY_*, etc. (see .env.example for the full list)
npm run dev    # http://localhost:4000
```

### Build the Anchor program

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor build
```

### Run tests

```bash
npm run typecheck    # workspace tsc --noEmit
npm run test         # Vitest across packages
```

### Deploy to mainnet

The deploy + setup pipeline is in [`scripts/`](./scripts/):

| Script | What it does |
|---|---|
| `init-vault-mainnet.ts` | One-shot `initialize_vault` |
| `init-v2-mainnet.ts` | One-shot `initialize_v2` (after vault funded ≥1 SOL) |
| `rotate-to-squads-mainnet.ts` | Atomic 3-ix tx to rotate treasury + propose owner to Squads multisig |
| `repair-referrals.ts` | One-shot Squads-signed migration for legacy default-zeroed `ReferralAccount`s |
| `upgrade-program-via-squads.ts` | Buffer-write + Squads 2/2 upgrade flow |

---

## Security model

- **House signer is an HSM** — Turnkey holds the `house_authority` ed25519 keypair inside a TEE. We never see the private bytes; signing happens inside Turnkey's enclave.
- **No custody** — wagers settle wallet ↔ vault PDA on chain. The web app has no deposit balance to drain.
- **Server-only secrets** — all sensitive Vercel env vars are marked `Sensitive` (encrypted at rest, write-only after creation). Server modules use `import "server-only"` to fail any accidental client import at build time.
- **Strict CSP** — same-origin scripts + Privy + Cloudflare Turnstile + WalletConnect explorer + Alchemy Solana + Supabase + Pyth Hermes. No third-party trackers.
- **Rate limiting** — Upstash sliding window on per-IP + per-(IP, wallet) combos for every player-mutating route.
- **Account hardening** — Anchor seed/bump validation throughout, account-discriminator type-cosplay defense, owner-check via `Account<'info, T>`, no `init_if_needed` in privileged ixs.
- **Audit-fix patch deployed** — covers explicit referral PDA derivation, executable-account rejection in treasury withdrawals, min-floor on cooldown + health-bps, aliasing assert on treasury destination. Full thread of fixes in `docs/security/program-audit.md`.
- **Squads multisig handover (planned)** — `vault.owner`, `vault.treasury`, and the BPF upgrade authority all rotate to a Squads V4 2-of-2 multisig once mainnet operations stabilise.

For vulnerability disclosures, reach out via [@playkaboom](https://x.com/playkaboom) on X.

---

## Repository

- Source: [github.com/penguinpecker/playkaboom](https://github.com/penguinpecker/playkaboom)
- Live: [playkaboom.gg](https://www.playkaboom.gg)
- X: [@playkaboom](https://x.com/playkaboom)
- License: [MIT](LICENSE)
