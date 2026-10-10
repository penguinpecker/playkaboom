# PlayKaboom

> A fully on-chain Minesweeper-style game with a community-owned DeFi vault, built on Solana.

[![Live](https://img.shields.io/badge/live-playkaboom.gg-a4c9ff?style=flat-square)](https://www.playkaboom.gg)
[![Status](https://img.shields.io/badge/status-status.playkaboom.gg-22c55e?style=flat-square)](https://status.playkaboom.gg)
[![Solana](https://img.shields.io/badge/solana-mainnet--beta-9945FF?style=flat-square&logo=solana&logoColor=white)](#architecture)
[![MagicBlock](https://img.shields.io/badge/rollup-MagicBlock%20ER%20%2B%20VRF-ff6b35?style=flat-square)](https://magicblock.gg/)
[![License](https://img.shields.io/badge/license-MIT-emerald?style=flat-square)](#repository)
[![X](https://img.shields.io/badge/x-@playkaboomgg-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/playkaboomgg)

PlayKaboom is a provably-fair Mines casino on Solana mainnet. Players bet SOL against a
permissionless bankroll: anyone can deposit into the vault via `lp_deposit` and share net
P&L pro-rata. Money never leaves layer 1 and the house never custodies a player balance —
every wager settles wallet ↔ vault PDA on chain.

**Gameplay runs on a MagicBlock ephemeral rollup with per-click VRF.** Each tap draws fresh
randomness from MagicBlock's ephemeral VRF oracle inside the rollup, so the outcome of a
tile does not exist until you tap it, and the whole round is replayed and re-verified on
L1 at settlement. There is no server-held secret and no hot signer in the game loop.

The original commit-reveal engine (server commits `SHA-256(layout ‖ mine_count ‖ salt)`
before the first tap, with each reveal signed by a Turnkey HSM) is still in the program as
a legacy path, but it is no longer the way the game is played.

> **Status — 2026-10-05.** The mainnet program has been closed and the site is in
> maintenance mode. The rest of this document describes the system as it ran on mainnet and
> is kept as the reference for the next deployment, which will use a new program ID.

---

## Deployment

| | |
|---|---|
| Web app | <https://www.playkaboom.gg> |
| Public status | <https://status.playkaboom.gg> |
| Cluster | `mainnet-beta` |
| Rollup | MagicBlock ephemeral rollup, pinned validator + pinned VRF oracle queue |
| Anchor version | 0.31.1 |

Every admin, treasury and upgrade path sits behind a Squads V4 **2-of-2** multisig. The
only key the server holds is the house key (kept in a Turnkey HSM in production), and in VRF
mode it is confined to submitting settle and refund transactions — it cannot change config, move
treasury funds, upgrade the program, or influence a single tile.

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
│  /api/vrf/{settle,refund}                 │   │                            │
│  /api/vault/* /leaderboard /activity/*    │   │  fan-out of Supabase       │
│  /api/status /version /health /ingest     │   │  Realtime → N browsers     │
│  /api/cron/{index-events,vault-health,    │   │  + Alchemy logsSubscribe   │
│             vrf-settle}                   │   │    push → /api/ingest      │
│  /api/commit /reveal /settle  (legacy)    │   │  + 60s cron tickler        │
│                                           │   └────────────────────────────┘
│  Privy JWT · Zod · Pino · Upstash rate-   │
│  limit · AES-256-GCM session encryption   │
└───────────────────────────────────────────┘
        │                                      │
        │ settle / refund (permissionless)     │ Postgres
        ▼                                      ▼
 ┌─────────────────────────┐            ┌─────────────┐
 │   Solana mainnet (L1)   │ ─── logs ▶ │  Supabase   │
 │   via Alchemy RPC       │            │  indexer    │
 └─────────────────────────┘            │  mirror     │
        │   ▲                           └─────────────┘
        │   │  delegate ▼ · commit + undelegate ▲
        ▼   │
 ┌──────────────────────────────────────────────────────┐
 │        MagicBlock ephemeral rollup (ER)              │
 │   per-click VRF oracle · instant taps · TEE-capable  │
 └──────────────────────────────────────────────────────┘
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
| Rollup + randomness | [MagicBlock](https://magicblock.gg/) ephemeral rollups + ephemeral VRF, `ephemeral-rollups-sdk` 0.15.5 with the `vrf` feature |
| TypeScript SDK | Hand-rolled instruction builders + account/event decoders (no IDL runtime dependency) |
| Backend | [Next.js](https://nextjs.org/) 15 App Router, Vercel functions (Node.js runtime) |
| Frontend | [React](https://react.dev/) 19, [Tailwind CSS](https://tailwindcss.com/), [Zustand](https://zustand-demo.pmnd.rs/), [TanStack Query](https://tanstack.com/query) |
| Auth | [Privy](https://privy.io/) (embedded wallets + social login + server-side JWT verification) |
| Database | [Supabase](https://supabase.com/) Postgres (indexer mirror, RLS-forced, public read / service-role write) |
| Live feed | Railway WebSocket relay (`apps/realtime`) — one upstream connection fans out to every viewer |
| RPC | [Alchemy](https://www.alchemy.com/) Solana mainnet (HTTP + WS) |
| Rate limiting | [Upstash Redis](https://upstash.com/) sliding-window (per-IP + per-wallet) |
| Price feed | [Pyth](https://pyth.network/) Hermes (SOL/USD overlay) |
| Governance | [Squads V4](https://squads.so/) 2-of-2 — owner, treasury and upgrade authority |
| Hosting | [Vercel](https://vercel.com/) (web) + [Railway](https://railway.app/) (relay) |

---

## Gameplay

PlayKaboom is a Minesweeper-style game played on a 4×4 grid. Each game hides a configurable number of mines beneath the tiles; the fewer mines in play, the higher the potential multiplier. Tap tiles to reveal safe spots and build your multiplier, or cash out at any time to lock in your winnings — hit a mine and the round ends. Each tile's outcome is drawn from MagicBlock's VRF at the moment you tap it and replayed on chain at settlement, so there is no pre-generated layout anywhere for anyone to leak.

---

## Provably fair

### Per-click VRF on the MagicBlock rollup

The mine layout is never generated. Each tap draws its own randomness.

1. **Start — `start_game_vrf` + session funding + `delegate_vrf`, in ONE transaction.** The
   bet is locked on L1 into a `VrfClaim` PDA, a throwaway session key is funded by the
   player, and the `VrfGame` account is delegated to the MagicBlock rollup atomically, so a
   half-started game is not a reachable state.
2. **Tap — `reveal_request_vrf` → `reveal_callback_vrf`.** The rollup requests randomness from
   the pinned ephemeral-VRF oracle queue. The oracle's callback writes the raw 32 bytes into
   the game account and `decide_mine(randomness, safe_reveals, mine_count)` derives the
   outcome. Neither the player nor the server knows the tile before that callback lands.
3. **Settle — `settle_and_undelegate_vrf` → `settle_vrf`.** The rollup commits state back to
   L1 and undelegates. `settle_vrf` then **replays every recorded randomness value on L1** and
   recomputes the result from scratch. Bet, mine count and house edge are pinned to the
   `VrfClaim` written at start (never delegated), so a rogue committer cannot inflate a
   payout — and the claim's `reserved` field is an absolute cap on what the game can pay.
   `settle_vrf` is permissionless: the server submits it as a convenience, but anyone can.
4. **Stall recovery — `refund_stalled_vrf`.** Once a game is back under program ownership
   on L1 (never delegated, or committed and undelegated while still playing), the player or
   the house key can refund the bet after `STALL_SLOTS`. A game stranded inside an
   unresponsive rollup has no refund path until it is undelegated. Games abandoned for
   `ABANDON_SLOTS` (~24 h) can have their vault reservation released by the owner
   (`admin_release_vrf_claim`, a Squads vote).

### Commit-reveal (legacy, retained in the program)

1. **Commit — `start_game`.** Server generates a 4×4 layout + 32-byte salt off chain, computes
   `commitment = SHA-256(layout ‖ mine_count ‖ salt)`, and broadcasts
   `start_game(mine_count, bet, commitment)`. Layout and salt stay server-side.
2. **Reveal — `reveal_tile`.** Each tap is signed by the house key (a Turnkey HSM in
   production). The encrypted session token is bound to the on-chain commitment, so a token
   from a previous round cannot be replayed against a new one.
3. **Settle — `settle_game`.** The program recomputes the hash from the published
   `(mine_layout, salt)` and **rejects** any settle whose hash doesn't match the original
   commitment, or any reveal inconsistent with the published layout.
4. **Refund — `refund_expired`.** If the house disappears mid-game, the player recovers the
   bet 300 slots (~2 min) after start.

### Verify it yourself

`/verify/[sig]` recomputes everything in your browser from public on-chain data via
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes) — randomness replay for VRF
games, hash match for legacy commit-reveal games. `GET /api/verify/[signature]` returns the
same verdict as JSON.

---

## On-chain accounts

| Account | PDA seeds | Purpose |
|---|---|---|
| `Vault` | `[kaboom_vault]` | House bankroll, config (edge/cap/split), withdrawal allowlist (8 entries max), pending-owner field for two-step rotation |
| `VaultV2State` | `[kaboom_v2_state]` | LP units, house units, seed units (anti-inflation), pending withdraws, health config, and the VRF gate (`vrf_mode_enabled`, pinned validator, `vrf_max_payout_bps`) |
| `VrfClaim` | `[kaboom_vrf_claim, player]` | The VRF game's **money side**, on L1, never delegated: bet, reserved payout, mine count, and the edge snapshot settle must match |
| `VrfGame` | `[kaboom_vrf_game, player]` | The VRF game's **play side**. Delegated to the rollup; stores up to 16 `(tile, randomness)` reveals for L1 replay |
| `GameSession` | `[kaboom_game, player]` | Legacy commit-reveal game — commitment, reveal mask, max-payout reservation, expiry slot |
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
  `vrf_max_payout_bps`. This bounds what a single forged rollup commit can extract; the
  defence against forgery itself is the pinned rollup validator and oracle queue.
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
| Mines program | deployed and executable at its configured program address |
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
│   │   ├── src/app/api/    REST: vrf/*, vault/*, status, version, leaderboard,
│   │   │                         activity/*, ref/*, cron/*, ingest, rpc/*,
│   │   │                         commit, reveal, settle (legacy)
│   │   ├── src/lib/vrf/    rollup client — atomic start, confirmation polling, undelegate
│   │   ├── src/server/     server-only: env, auth, session-store, indexer, solana,
│   │   │                                verify-vrf, ratelimit, legacy house signer
│   │   ├── src/hooks/      use-vrf-game (rollup state machine), use-game-actions, …
│   │   ├── src/components/ game grid, bet controls, recovery banner, providers
│   │   └── src/middleware.ts  status-subdomain isolation
│   └── realtime/           Railway WebSocket relay + Alchemy logsSubscribe ingest
├── programs/
│   └── kaboom/src/
│       ├── vrf_mode.rs     VrfClaim / VrfGame, delegation, per-click VRF, L1 replay settle
│       └── lib.rs          vault, LP, referrals, owner ops, legacy commit-reveal gameplay
├── packages/
│   ├── sdk/                instruction builders, account/event decoders, PDAs, vrf, verify
│   └── shared/             constants + zod schemas + multiplier math
├── supabase/migrations/    indexer schema (player_stats, games, referrals, lp_*, …)
├── scripts/                ops + deploy tooling (see below)
├── docs/                   security reviews, MagicBlock handoff, operations runbooks
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

The web app reads its configuration from `apps/web/.env.local`; the variable names are
validated in `apps/web/src/server/env.ts`.

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

- **No hot signer in the game loop** — in VRF mode no house key signs a reveal. Taps are
  signed by a throwaway session key the player funds, the rollup's VRF oracle writes the
  randomness, the program derives the outcome, and L1 replays it. The house key only
  submits settle (permissionless) and refund transactions, and prices nothing.
- **Governance is 2-of-2** — `vault.owner`, `vault.treasury` and the BPF upgrade authority
  are all the Squads V4 vault PDA. No single key can upgrade the program or move treasury
  funds.
- **No custody** — wagers settle wallet ↔ vault PDA on chain. There is no deposit balance to
  drain, and the VRF path keeps every lamport on L1 while only gameplay state visits the
  rollup.
- **VRF is fail-closed** — the oracle queue is a program constant, the rollup validator is
  pinned in vault state, and both `vrf_mode_enabled` and a non-zero pinned validator must be
  set deliberately by the owner before a single VRF game can open.
- **L1 re-verification** — `settle_vrf` never trusts committed rollup state for anything that
  prices a payout: bet, mine count and edge come from the never-delegated `VrfClaim`, the
  outcome is replayed from the recorded randomness, and `reserved` caps the payout absolutely.
- **Legacy path is commitment-bound** — on the commit-reveal path the encrypted game token is
  checked against the live on-chain commitment on every reveal, and the house key that signs
  those reveals lives in a Turnkey HSM, never on disk.
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
- **Security reviews** — internal review threads and the fixes they produced are in
  `docs/security/`.

Report vulnerabilities via [SECURITY.md](SECURITY.md) or [@playkaboomgg](https://x.com/playkaboomgg) on X.

---

## Repository

- Source: [github.com/penguinpecker/playkaboom](https://github.com/penguinpecker/playkaboom)
- Live: [playkaboom.gg](https://www.playkaboom.gg) · Status: [status.playkaboom.gg](https://status.playkaboom.gg)
- X: [@playkaboomgg](https://x.com/playkaboomgg)
- License: MIT
