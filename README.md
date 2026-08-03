# PlayKaboom

> A fully on-chain Minesweeper-style game with a community-owned DeFi vault, built on Solana.

[![Live](https://img.shields.io/badge/live-playkaboom.gg-a4c9ff?style=flat-square)](https://www.playkaboom.gg)
[![Status](https://img.shields.io/badge/status-status.playkaboom.gg-22c55e?style=flat-square)](https://status.playkaboom.gg)
[![Solana](https://img.shields.io/badge/solana-mainnet--beta-9945FF?style=flat-square&logo=solana&logoColor=white)](https://solscan.io/account/9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh)
[![License](https://img.shields.io/badge/license-MIT-emerald?style=flat-square)](#repository)
[![X](https://img.shields.io/badge/x-@playkaboom-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/playkaboom)

PlayKaboom is a provably-fair Mines casino on Solana mainnet. Players bet SOL against a
permissionless bankroll: anyone can deposit into the vault via `lp_deposit` and share net
P&L pro-rata. Money never leaves layer 1 and the house never custodies a player balance —
every wager settles wallet ↔ vault PDA on chain.

Two fairness engines run side by side:

| Mode | How randomness is produced | Where it runs |
|---|---|---|
| **Per-click VRF** | Each tap requests fresh randomness from MagicBlock's ephemeral VRF; the outcome does not exist until you tap | MagicBlock ephemeral rollup, replayed and verified on L1 at settle |
| **Commit-reveal** | Server commits `SHA-256(layout ‖ mine_count ‖ salt)` before the first tap, publishes layout + salt at settle | Solana L1 |

VRF mode is the default whenever the vault has it armed. It is strictly stronger: there is no
pre-existing layout to leak, and no server-held secret that determines your result.

---

## Live deployment

| | |
|---|---|
| Web app | <https://www.playkaboom.gg> |
| Public status | <https://status.playkaboom.gg> |
| Program ID | [`9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh`](https://solscan.io/account/9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh) |
| Vault PDA | [`9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK`](https://solscan.io/account/9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK) |
| Vault V2 State | [`6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb`](https://solscan.io/account/6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb) |
| Owner · treasury · upgrade authority | [`464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5`](https://solscan.io/account/464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5) — Squads V4 vault PDA, **2-of-2** |
| House signer (game ixs only) | [`7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp`](https://solscan.io/account/7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp) — Turnkey HSM |
| MagicBlock VRF queue (pinned) | [`5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`](https://solscan.io/account/5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc) |
| Cluster | `mainnet-beta` |
| Anchor version | 0.31.1 |

Every admin, treasury and upgrade path sits behind the Squads 2-of-2. The Turnkey key signs
gameplay instructions and nothing else — stealing it moves no vault capital.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                             CLIENT (browser)                               │
│   React 19 + Next.js 15 App Router · Tailwind · Privy embedded wallets      │
│                                                                            │
│   /play  /vault  /leaderboard  /referrals  /logs  /verify/[sig]  /profile   │
│   version guard (auto-reload on new build)  ·  WS live feed                 │
└────────────────────────────────────────────────────────────────────────────┘
        │                    │                          │
        │ REST               │ Solana RPC (proxied)     │ WebSocket
        ▼                    ▼                          ▼
┌───────────────────────────────────────────┐   ┌────────────────────────────┐
│      SERVER · Next.js on Vercel           │   │  RELAY · Railway           │
│                                           │   │  apps/realtime             │
│  /api/commit /reveal /settle /cleanup     │   │                            │
│  /api/vrf/{fund-session,settle,refund}    │   │  fan-out of Supabase       │
│  /api/vault/* /leaderboard /activity/*    │   │  Realtime → N browsers     │
│  /api/status /version /health /ingest     │   │  + Alchemy logsSubscribe   │
│  /api/cron/{index-events,vault-health,    │   │    push → /api/ingest      │
│             vrf-settle}                   │   │  + 60s cron tickler        │
│                                           │   └────────────────────────────┘
│  Privy JWT · Zod · Pino · Upstash rate-   │
│  limit · AES-256-GCM session encryption   │
└───────────────────────────────────────────┘
        │                │                    │
        │ ed25519 sign   │ HTTPS              │ Postgres
        ▼                ▼                    ▼
 ┌──────────────┐  ┌─────────────┐      ┌─────────────┐
 │ Turnkey HSM  │  │   Solana    │ ───▶ │  Supabase   │
 │ (house sig)  │  │  mainnet    │ logs │  indexer    │
 └──────────────┘  │  (Alchemy)  │      │  mirror     │
                   └─────────────┘      └─────────────┘
                         │   ▲
     delegate / commit   │   │   commit + undelegate
                         ▼   │
             ┌───────────────────────────────┐
             │  MagicBlock ephemeral rollup  │
             │  per-click VRF · instant taps │
             └───────────────────────────────┘
                         │
                         │ Anchor 0.31 program (Rust, 41 instructions)
                         ▼
   ┌──────────────────────────────────────────────────────┐
   │  Vault · VaultV2State · GameSession · GameSessionV2   │
   │  VrfClaim · VrfGame · PlayerStats · ReferralAccount   │
   │  LpPosition                                           │
   └──────────────────────────────────────────────────────┘
```

### Tech stack

| Layer | Technology |
|---|---|
| Smart contract | [Anchor](https://www.anchor-lang.com/) 0.31.1 (Rust), Solana mainnet-beta — 41 instructions |
| Rollup + VRF | [MagicBlock](https://magicblock.gg/) ephemeral rollups, `ephemeral-rollups-sdk` 0.15.5 with the `vrf` feature |
| TypeScript SDK | Hand-rolled instruction builders + account/event decoders (no IDL runtime dependency) |
| Backend | [Next.js](https://nextjs.org/) 15 App Router, Vercel functions (Node.js runtime) |
| Frontend | [React](https://react.dev/) 19, [Tailwind CSS](https://tailwindcss.com/), [Zustand](https://zustand-demo.pmnd.rs/), [TanStack Query](https://tanstack.com/query) |
| Auth | [Privy](https://privy.io/) (embedded wallets + social login + server-side JWT verification) |
| Hot signer | [Turnkey](https://www.turnkey.com/) HSM (TEE-backed ed25519 keypair, never local) |
| Database | [Supabase](https://supabase.com/) Postgres (indexer mirror, RLS-forced, public read / service-role write) |
| Live feed | Railway WebSocket relay (`apps/realtime`) — one upstream connection fans out to every viewer |
| RPC | [Alchemy](https://www.alchemy.com/) Solana mainnet (HTTP + WS) |
| Rate limiting | [Upstash Redis](https://upstash.com/) sliding-window (per-IP + per-wallet) |
| Price feed | [Pyth](https://pyth.network/) Hermes (SOL/USD overlay) |
| Governance | [Squads V4](https://squads.so/) 2-of-2 — owner, treasury and upgrade authority (live) |
| Hosting | [Vercel](https://vercel.com/) (web) + [Railway](https://railway.app/) (relay) |

---

## Provably fair

### Per-click VRF (default)

The mine layout is never generated. Each tap draws its own randomness.

1. **Start — `start_game_vrf` + session funding + `delegate_vrf`, in ONE transaction.** The
   bet is locked on L1 into a `VrfClaim` PDA, a throwaway session key is funded, and the
   `VrfGame` account is delegated to the MagicBlock rollup atomically, so a half-started game
   is not a reachable state.
2. **Tap — `reveal_request_vrf` → `reveal_callback_vrf`.** The rollup requests randomness from
   the pinned ephemeral-VRF oracle queue. The oracle's callback writes the raw 32 bytes into
   the game account and `decide_mine(randomness, safe_reveals, mine_count)` derives the
   outcome. Nobody — player, server or validator — knows the tile before that callback lands.
3. **Settle — `settle_and_undelegate_vrf` → `settle_vrf`.** The rollup commits state back to
   L1 and undelegates. `settle_vrf` then **replays every recorded randomness value on L1** and
   recomputes the result from scratch. Bet, mine count and house edge are pinned to the
   `VrfClaim` written at start (never delegated), so a rogue committer cannot inflate a
   payout — and the claim's `reserved` field is an absolute cap on what the game can pay.
4. **Stall recovery — `refund_stalled_vrf`.** If the rollup stops responding, the player (or
   the operator relay) undelegates and refunds the bet after `STALL_SLOTS`. Games abandoned
   for `ABANDON_SLOTS` (~24 h) are reclaimable so their reservation is released.

### Commit-reveal (legacy mode)

1. **Commit — `start_game`.** Server generates a 4×4 layout + 32-byte salt off chain, computes
   `commitment = SHA-256(layout ‖ mine_count ‖ salt)`, and broadcasts
   `start_game(mine_count, bet, commitment)`. Layout and salt stay server-side.
2. **Reveal — `reveal_tile`.** Each tap is signed by the Turnkey HSM. The encrypted session
   token is bound to the on-chain commitment, so a token from a previous round cannot be
   replayed against a new one.
3. **Settle — `settle_game`.** The program recomputes the hash from the published
   `(mine_layout, salt)` and **rejects** any settle whose hash doesn't match the original
   commitment, or any reveal inconsistent with the published layout.
4. **Refund — `refund_expired`.** If the house disappears mid-game, the player recovers the
   bet 300 slots (~2 min) after start.

### Verify it yourself

`/verify/[sig]` recomputes everything in your browser from public on-chain data via
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes) — hash match for commit-reveal
games, randomness replay for VRF games. `GET /api/verify/[signature]` returns the same
verdict as JSON.

---

## On-chain accounts

| Account | PDA seeds | Purpose |
|---|---|---|
| `Vault` | `[kaboom_vault]` | House bankroll, config (edge/cap/split), withdrawal allowlist (8 entries max), pending-owner field for two-step rotation |
| `VaultV2State` | `[kaboom_v2_state]` | LP units, house units, seed units (anti-inflation), pending withdraws, health config, and the VRF gate (`vrf_mode_enabled`, pinned validator, `vrf_max_payout_bps`) |
| `GameSession` | `[kaboom_game, player]` | Commit-reveal game — commitment, reveal mask, max-payout reservation, expiry slot |
| `VrfClaim` | `[kaboom_vrf_claim, player]` | The VRF game's **money side**, on L1, never delegated: bet, reserved payout, mine count, and the edge snapshot settle must match |
| `VrfGame` | `[kaboom_vrf_game, player]` | The VRF game's **play side**. Delegated to the rollup; stores up to 16 `(tile, randomness)` reveals for L1 replay |
| `PlayerStats` | `[kaboom_stats, player]` | Lifetime stats (games, wins, wagered, biggest win, streak) + referrer field for one-time attribution |
| `ReferralAccount` | `[kaboom_referral, referrer]` | Per-referrer accrual, tier (bronze/silver/gold by volume), claimable lamports |
| `LpPosition` | `[kaboom_lp, user]` | LP units held, pending withdraw units, unlock slot, cumulative deposit/withdraw |

41 instructions cover gameplay in both modes, owner ops, LP flow, referral claim, VRF
settle/refund/admin-release, and a one-shot `repair_referral` migration ix.

---

## LP vault

Anyone can deposit SOL into the vault PDA via `lp_deposit(amount)` and receive `units` that
share casino P&L pro-rata. Withdrawals sit behind a 3-day cooldown (`648,000` slots) — units
stay live during the cooldown, still earning or losing.

- **Health factor** — dynamically scales `max_bet_bps` and `max_payout_bps` from outstanding
  game obligations vs vault assets, so the vault never accepts a bet it can't underwrite.
- **VRF payout ceiling** — a VRF game takes the tighter of the vault-wide cap and
  `vrf_max_payout_bps`. This is the aggregate bound on a forged-outcome attack.
- **Anti-inflation seed** — `initialize_v2` can lock a tranche of units that no one can
  withdraw, so the first depositor cannot game unit-value math.
- **House LP position** — the operator holds its own position, and `min_house_share_bps`
  can pin a floor below which it cannot withdraw without re-balancing.
- **Per-user cap** — `max_user_position_bps` bounds any single depositor's share of the
  vault. Like the two above it is owner-configured; the live value of every parameter is
  on the [status page](https://status.playkaboom.gg) and in `/api/vault/state`.
- **Treasury split** — 50% of each settle's house profit stays in the vault (raising unit
  value for every LP); the other 50% goes to the Squads treasury.
- **Live config** — every cap is recomputed from current vault state at start time. No
  staleness.

---

## Status & transparency

`status.playkaboom.gg` is a public, unauthenticated health page on its own subdomain,
isolated in middleware so it serves `/` and `/api/status` and nothing else from the main app.
It reports, live:

| Component | What it proves |
|---|---|
| Solana RPC | reachable, current slot |
| Mines program | deployed and executable at the published address |
| Bankroll & solvency | vault balance, health % against the floor, paused flag |
| Per-click VRF mode | whether VRF is armed, and its payout ceiling |
| Stuck capital | any abandoned game still reserving vault capital, and for how long |
| MagicBlock rollup | rollup slot and validator core version |
| Database | Supabase reachable |
| Indexer | slots behind the program, minutes since the last mirrored game |
| Realtime relay | Railway relay live, connected viewer count |

`GET https://status.playkaboom.gg/api/status` returns the same payload as JSON.

---

## Repository layout

```
playkaboom/
├── apps/
│   ├── web/                Next.js 15 app — UI + API routes + indexer
│   │   ├── src/app/        pages: /, /play, /vault, /leaderboard, /referrals, /logs,
│   │   │                          /status, /verify/[sig], /profile/[wallet], /r/[code],
│   │   │                          /install, /terms, /privacy
│   │   ├── src/app/api/    REST: commit, reveal, settle, vrf/*, vault/*, status, version,
│   │   │                         leaderboard, activity/*, ref/*, cron/*, ingest, rpc/*
│   │   ├── src/lib/vrf/    rollup client — atomic start, confirmation polling, undelegate
│   │   ├── src/server/     server-only: env, auth, session-store, indexer, solana,
│   │   │                                turnkey, verify-vrf, ratelimit
│   │   ├── src/hooks/      use-vrf-game (rollup state machine), use-game-actions, …
│   │   ├── src/components/ game grid, bet controls, recovery banner, providers
│   │   └── src/middleware.ts  status-subdomain isolation
│   └── realtime/           Railway WebSocket relay + Alchemy logsSubscribe ingest
├── programs/
│   └── kaboom/src/
│       ├── lib.rs          vault, commit-reveal gameplay, LP, referrals, owner ops
│       └── vrf_mode.rs     VrfClaim / VrfGame, delegation, per-click VRF, L1 replay settle
├── packages/
│   ├── sdk/                instruction builders, account/event decoders, PDAs, vrf, verify
│   └── shared/             constants + zod schemas + multiplier math
├── supabase/migrations/    indexer schema (player_stats, games, referrals, lp_*, …)
├── scripts/                ops + deploy tooling (see below)
├── docs/                   security audits, MagicBlock handoff, operations runbooks
├── tests/                  Vitest unit tests + Anchor integration runner
├── Anchor.toml             program IDs per cluster
└── turbo.json              monorepo task graph
```

---

## Development

```bash
npm install
npm run dev --workspace=@playkaboom/web    # web app on :3000
npm run test                               # Vitest unit tests
anchor build && anchor test                # program
```

The multiplier is `C(16,s)/C(16−m,s) × (1 − edge)`, with the edge applied exactly once. Rust
`calc_multiplier` and TypeScript `calcMultiplierBps` both assert against a shared 675-row
fixture (`tests/fixtures/multiplier.json`) covering `mine_count` 1..15 × `safe_reveals`
0..(16−mc) × `edge_bps` {0, 100, 200, 500, 1000}. Any drift between the two breaks CI.

### Deploying

Production is **CLI-only** — the Vercel project has no git integration, so pushing to `main`
does not deploy anything. Deploy and verification are deliberately one step:

```bash
./scripts/deploy.sh                          # build → deploy → verify, all or nothing
./scripts/deploy.sh "toast copy,identifier"  # also require these runtime strings in the bundle
./scripts/verify-deploy.sh                   # read-only re-verify of production
./scripts/watch-deploy.sh --once             # watch for the next deploy and verify it
```

`verify-deploy.sh` checks that the deployment is READY *and* aliased to the domain, that env
vars decrypt to non-empty values, that the served bundle contains the markers you claimed to
ship, and that the program is live on chain. Markers must be **runtime** strings —
minification strips comments, so a comment marker always reports a false failure.

Clients run a version guard that polls `/api/version` and reloads on a new build while the
player is idle (a banner instead, mid-round), so a stale tab can't keep running a dead bundle.

---

## Security model

- **House signer is an HSM** — Turnkey holds the `house_authority` ed25519 keypair in a TEE.
  The private bytes never exist outside the enclave, and the key authorises gameplay
  instructions only.
- **Governance is 2-of-2** — `vault.owner`, `vault.treasury` and the BPF upgrade authority
  are all the Squads V4 vault PDA. No single key can upgrade the program or move treasury
  funds.
- **No custody** — wagers settle wallet ↔ vault PDA on chain. There is no deposit balance to
  drain, and the VRF path keeps every lamport on L1 while only gameplay state visits the
  rollup.
- **Session tokens are commitment-bound** — the encrypted game token is checked against the
  live on-chain commitment on every reveal, so a token from a settled round is rejected
  rather than replayed against a new one.
- **VRF is fail-closed** — the oracle queue is a program constant, the rollup validator is
  pinned in vault state, and both `vrf_mode_enabled` and a non-zero pinned validator must be
  set deliberately by the owner before a single VRF game can open.
- **L1 re-verification** — `settle_vrf` never trusts committed rollup state for anything that
  prices a payout: bet, mine count and edge come from the never-delegated `VrfClaim`, the
  outcome is replayed from the recorded randomness, and `reserved` caps the payout absolutely.
- **Server-only secrets** — sensitive Vercel env vars are marked `Sensitive` (encrypted at
  rest, write-only after creation). Server modules `import "server-only"` so an accidental
  client import fails the build.
- **Strict CSP** — same-origin scripts plus Privy, Turnstile, WalletConnect explorer, Alchemy,
  Supabase, Pyth Hermes and MagicBlock. No third-party trackers.
- **Rate limiting** — Upstash sliding window on per-IP and per-(IP, wallet) for every
  player-mutating route.
- **Account hardening** — Anchor seed/bump validation throughout, discriminator
  type-cosplay defense, owner checks via `Account<'info, T>`, no `init_if_needed` in
  privileged instructions.
- **Audited** — full fix threads in `docs/security/`.

Report vulnerabilities via [SECURITY.md](SECURITY.md) or [@playkaboom](https://x.com/playkaboom) on X.

---

## Repository

- Source: [github.com/penguinpecker/playkaboom](https://github.com/penguinpecker/playkaboom)
- Live: [playkaboom.gg](https://www.playkaboom.gg) · Status: [status.playkaboom.gg](https://status.playkaboom.gg)
- X: [@playkaboom](https://x.com/playkaboom)
- License: MIT
