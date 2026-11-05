# PlayKaboom — Session Handoff

A self-contained snapshot to pick up where the last session left off. Top section refreshed **2026-11-05** (relaunch, K Points); the rest was refreshed **2026-08-09** (security review, off-chain hardening deployed, footer + Terms rewrite). Full session-by-session log lives in `records.txt` (local-only, gitignored), durable lessons in `learnings.txt` (same).

## STATUS — 2026-11-05: RELAUNCHED (Pinocchio, VRF-only, Railway API + Vercel frontend)

**Live on Solana mainnet at <https://playkaboom.gg> under a new program ID.** The program is a Pinocchio port of the old one and is VRF-only: legacy `start_game` returns 6057 `LegacyModeDisabled`, and only the legacy wind-down instructions remain. There is no Turnkey and no Supabase anywhere in the live system.

**Every section below this one (2026-10-17 and older) is pre-relaunch history.** Wherever it describes Turnkey, Supabase, commit-reveal play, the API on Vercel, or program `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh`, that is not the live system.

| Item | Address / value | Note |
|---|---|---|
| Program ID | `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju` | Pinocchio port, VRF-only |
| BPF upgrade authority | `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG` | the deployer, for now. Squads handover pending |
| Squads vault (handover target) | `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5` | |
| Vault PDA | `7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7` | |
| `vault.owner` | `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG` | the deployer, temporarily (config, house rotation, admin release) |
| `vault.house_authority` | `8h7a62wscqmnmDaLeuCnaB9NgQHrWivnDRfUGAmA289D` | raw house key (below) |
| `vault.treasury` | `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG` | the deployer, temporarily |
| Vault V2 State | `Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue` | |
| VRF validator | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` | `as.magicblock.app` |
| `vrf_max_payout_bps` | 5000 (50%) | an AGGREGATE cap over every open VRF game, not per game; set by the owner 2026-11-05 |
| Min bet (UI) | 0.01 SOL | `GAME_CONFIG.MIN_BET_SOL`; MagicBlock keeps ~0.003 SOL per delegated round on top |
| Vault | ~1.075 SOL on 2026-11-05 | owner rule: keep the vault at about 1 SOL; live values at `/api/vault/state` |

**House key.** A raw keypair, held only as the sealed Railway variable `HOUSE_SECRET_KEY` on the kaboom-web service (`apps/web/src/server/house-signer.ts`). It can only do bounded cleanup and settlement: VRF settle, force-undelegate and refund, legacy wind-down, and LP auto-complete. Because the program is VRF-only, it cannot start a commit-reveal game. It is never on Vercel and never in the repo.

| Layer | Where |
|---|---|
| Frontend | Vercel: `playkaboom.gg`, `www`, `status`. Built with `KABOOM_API_ORIGIN`, so every `/api/*` except `/api/version` is proxied to Railway. Vercel holds no server secret. |
| API + crons | Railway service kaboom-web (`kaboom-web-production.up.railway.app`). Holds `DATABASE_URL`, the house key, the Privy secret and the RPC URL. |
| DB | Railway Postgres; kaboom-web connects as role `kaboom_app` |
| Relay | Railway, `apps/realtime` (`kaboom-realtime-production.up.railway.app`). Postgres `LISTEN` as role `kaboom_relay`; calls `/api/cron/tick` every 60 s |
| Retired | Supabase, Turnkey, the API on Vercel |

Runbook: `pinocchio/MIGRATION/DEPLOY.md` (DNS stays on Vercel; there is no DNS move). Secrets inventory: `docs/security/secrets.md`.

**Shipped 2026-11-05** (all live on Vercel + Railway and pushed):
- **K Points.** Every settled round earns `bet × edge ÷ 0.00002 SOL` (1 per 0.001 SOL at 2%), win or lose, from the existing `points_ledger` engine (`apps/web/src/server/points.ts`). `/api/leaderboard` returns `kPoints` (the `points_balance` total) on every row of every view, and the leaderboard shows a K POINTS column. Never expose `points_ledger` rows directly.
- **LP K Points.** Cron pass `lp-points` (`apps/web/src/server/cron/lp-points-pass.ts`) credits each user LP position `K_POINTS_LP_PER_SOL_HOUR` (default 10) per SOL of live position value once per UTC hour, with exact carry in `lp_points_accrual` (migration `20261105000002_lp_points.sql`). A pending withdrawal earns 0 for that hour and resumes the hour after a cancel; house and seed units never earn; missed hours are not back-filled.
- **Payout speed.** House txs use a confirmed blockhash and retry the empty-logs preflight case; `/api/vrf/settle` polls its own read before answering; the client retries settle on 409/429/5xx; the RPC proxy has its own 300/10 s budget per client (client IP forwarded by the Vercel middleware with a shared secret).
- **Session keys** are kept until their gas sweep is confirmed; the LP deposit cap applies the house-share floor; `/api/verify` reports refunds; maintenance banner removed; link-preview image `og.png` is opaque on the brand background (`?v=2`).
- **Real-money check:** 30 rounds (1 mine, 0.01 SOL): every payout, VRF replay, treasury cut and referral accrual matched the chain exactly; the referrer's claim paid in full.

Open owner decisions:
- `min_house_share_bps` is 50% with tiny house units, so the LP max deposit is 0 (LP deposits revert). Lower it or keep LP closed.
- Whether to show MagicBlock's ~0.003 SOL per-round fee in the game UI.
- Frontend shakedown (test browser + one Privy email login) still to run; MAX button and mine-count selection by vault capacity still pending.

Owner to-dos:
- The old Turnkey house wallet `7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp` is retired but still holds ~0.97 SOL. Sweep it from the Turnkey dashboard.
- Hand the upgrade authority, `vault.owner` and `vault.treasury` over to the Squads vault above.

The old program `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh` was closed on 2026-10-05 (section below).

## STATUS — 2026-10-17: REDEPLOY SIZING (nothing deployed; corrected 2026-10-22)

**What a redeploy costs, program only.** Every row needs a new program ID.

| Build | ELF bytes | ProgramData rent | Change needed |
|---|---|---|---|
| Anchor HEAD as is | 1,037,320 | 5.27 SOL | **do not deploy**: SDK bug below |
| **Anchor, `ephemeral-rollups-sdk` 0.16.2 + `opt-level = "z"` + `no-idl`** | **741,232** | **3.77 SOL** | one version bump, one profile line, one feature flag |
| Pinocchio port (ESTIMATE; probe builds measured 110,368–160,096 bytes) | 150,000–220,000 | 0.76–1.12 SOL | full rewrite, ~10–15 days, fresh audit |

Add about 0.01 SOL for the program account, the vault and v2-state accounts, and write fees. Rent is `(elf_bytes + 173) × 5,080` lamports today; it was 6,960 per byte when the old program was allocated, so always re-query it. Going live also needs at least 1 SOL in the vault before `initialize_v2` (`ANTI_INFLATION_SEED_LAMPORTS`, locked as seed units). That is bankroll, not deploy cost.

- **Bump `ephemeral-rollups-sdk` to 0.16.2 or later before any redeploy.** 0.15.5's undelegation callback does not check that the buffer is the account's own undelegate-buffer PDA. Upstream fixed it in 0.16.2 after it was exploited elsewhere in July 2026. 0.16.2 builds with no code change; 0.17.3 needs one renamed VRF import.
- **The old ID cannot come back on today's mainnet.** Agave 4.3 abandoned loader-v4 and removed the loader-v3 `Migrate` instruction. The only future path is SIMD-0432 (spec merged, implementation not shipped), which would let the old program keypair free the address. Keep that keypair.
- **There is no bytecode compression on Solana.** Cost only falls by making the ELF smaller.
- **Safe build settings:** `opt-level = "z"` (no logic change) and `no-idl` (removes Anchor's IDL-account instructions; the app and SDK never load the IDL).
- **Do not use `no-log-ix-name`.** Both `/api/verify` routes find VRF settlements by searching logs for `Instruction: SettleVrf`. A Pinocchio port must log that line too.
- **Do not strip `emit!`.** The SDK decodes 19 of the 34 events for the indexer and UI.
- **Unmeasured:** compute units under `opt-level = "z"`. The client sets a 200,000 CU limit. Measure `settle_game`, `settle_vrf`, `start_game_vrf` and `lp_deposit` before deploying a z build.
- **A Pinocchio port keeps the frontend working** if it keeps the existing instruction and account discriminators, per-instruction account order, PDA seeds, Borsh layouts, event bytes and error codes, because the SDK hand-codes all of them. Use `ephemeral-rollups-pinocchio` 0.16.2 or later.

Full measurements, the reproduction script, the recovered probe sources and the port notes are in the local archive under `redeploy/sizing/`.

## STATUS — 2026-10-05: PROGRAM CLOSED

**The mainnet program `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh` was closed on 2026-10-05 and its rent reclaimed.** The site stays up with a maintenance banner; every on-chain game/vault call now fails. Everything below this section describes the pre-close system and is kept for a future redeploy. That redeploy needs a **new program ID** (a closed upgradeable program cannot be redeployed at the same address); keep the old program keypair anyway (see the 2026-10-17 section for why). The full decommission record, backups and redeploy guide live outside the repo in the local archive `~/Projects/kaboom-archive-2026-10-05/` (start with its `HANDOFF.md`).

## STATUS — 2026-08-09 (pre-close)

**Live on Solana mainnet at <https://playkaboom.gg>.** Per-click VRF over MagicBlock ephemeral rollups is the default game mode and is armed on chain. Commit-reveal remains as the legacy path. All admin/treasury/upgrade authorities are on Squads 2-of-2; the hot game-ix signer is a Turnkey HSM (retired 2026-11-04). Public health page at <https://status.playkaboom.gg>.

| Authority | Address | Type |
|---|---|---|
| `vault.owner` | `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5` | Squads vault PDA |
| `vault.treasury` | `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5` | Squads vault PDA |
| BPF upgrade authority | `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5` | Squads vault PDA |
| `vault.house_authority` | `7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp` | Turnkey HSM (game ixs only) (retired 2026-11-04) |
| Squads multisig config | `H8MdHx8pHvhrA5kTziSFszKNWMVJ1SUorR8hmezTdoUm` | threshold 2-of-2, time_lock 0 |
| Program ID | `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh` | 41 instructions |
| ProgramData | `8TTVAvxig6dQfLiHcDXrXUs8sjiGTAxk6viNPC1y1SJb` | |
| Vault PDA | `9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK` | program-owned |
| Vault V2 State | `6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb` | |
| MagicBlock VRF queue | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` | program constant |
| Pinned ER validator | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` | in `VaultV2State` |
| Deployer wallet | `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG` | zero admin powers — fee-payer only |

**Key implication:** a stolen deployer or Turnkey key gets you nothing material. Turnkey signs gameplay instructions only; admin, treasury and upgrade all need Squads 2-of-2. (Pre-relaunch only: Turnkey was retired on 2026-11-04, and since the relaunch the deployer is the upgrade authority; see the top section.)

## Live config — verified on chain 2026-08-04

Decode these yourself rather than trusting this table after a config change; the status page and `/api/vault/state` are always current.

| Param | Value | Note |
|---|---|---|
| `house_edge_bps` | 200 (2.00%) | |
| `max_bet_bps` | 200 (2% of vault) | |
| `max_payout_bps` | **5000 (50% of vault)** ⚠️ | Biggest open risk. Industry std 0.5–1%. Still queued. |
| `treasury_split_bps` | 5000 | 50/50 LP / treasury |
| `vrf_mode_enabled` | 1 | armed |
| `vrf_max_payout_bps` | 500 (5%) | VRF games take the tighter of this and `max_payout_bps` |
| `min_health_bps` | 1000 (10%) | |
| `withdraw_cooldown_slots` | 648,000 (3 days) | |
| `min_lp_deposit` | 10,000,000 (0.01 SOL) | |
| `seed_units` | **0** ⚠️ | Anti-inflation seed is NOT set |
| `min_house_share_bps` | **0** ⚠️ | House share floor is DISABLED |
| `max_user_position_bps` | **0** ⚠️ | Per-user LP cap is DISABLED — one depositor may take an unbounded share |
| Vault balance | ~2.10 SOL | health 7382 bps |
| `total_outstanding_max_payout` | 0.5488 SOL | ⚠️ ~26% of the vault, and **all of it is one abandoned game ~85 days old** |
| house units / total units | 314,505 / 330,509,106 | house holds **0.10%** — the bankroll is almost entirely other people's money |

The three zeroed LP guards and the stale obligation were surfaced by this session's audit and have **not** been changed. Each fix is a Squads vote.

Multiplier math is `C(16,s)/C(16−m,s) × (1 − edge)`, edge applied once. Rust `calc_multiplier` and TS `calcMultiplierBps` both assert against `tests/fixtures/multiplier.json` (675 rows) in CI; drift breaks the build.

## Game modes

**Per-click VRF (default).** No layout is ever generated.
1. `start_game_vrf` + session-key funding + `delegate_vrf` in **one atomic transaction** — a half-started game is not a reachable state.
2. Each tap: `reveal_request_vrf` → oracle → `reveal_callback_vrf` writes raw randomness into the delegated `VrfGame`; `decide_mine()` derives the tile.
3. `settle_and_undelegate_vrf` → `settle_vrf` **replays every recorded randomness value on L1**. Bet, mine count and edge come from the never-delegated `VrfClaim`; its `reserved` field is a hard payout cap.
4. `refund_stalled_vrf` after `STALL_SLOTS`; abandoned games reclaimable after `ABANDON_SLOTS` (~24 h).

**VRF startup overhead: 11,795,760 lamports (~0.0118 SOL) on top of the bet**, nearly all refundable when the round closes but required in the wallet at bet time. Breakdown: VrfClaim rent 1,371,120 · VrfGame rent 5,213,040 · session funding 2,000,000 · delegation 3,206,600 · fee ~10,000. This is a **12× onboarding floor** against the 0.001 SOL minimum bet — VrfGame rent and session funding are 61% of it and are the two levers worth pulling.

**Commit-reveal (legacy).** Server commits `SHA-256(layout ‖ mine_count ‖ salt)`, Turnkey signs each reveal (retired 2026-11-04), `settle_game` rejects any settle whose hash doesn't match. Session tokens are bound to the on-chain commitment (see Security below).

## Stack & infra

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 App Router, React 19, Tailwind, Zustand, Privy embedded wallets |
| Rollup | MagicBlock ephemeral rollups, `ephemeral-rollups-sdk` 0.15.5 (`vrf` feature) |
| RPC | Alchemy mainnet (HTTP + WS) |
| Indexer | Alchemy `logsSubscribe` push via the Railway relay → `/api/ingest` → Supabase (retired 2026-11-04). VRF settles emit no event, so they are mirrored explicitly at settle time. Cron sweep as backstop. |
| Realtime | Railway WS relay (`apps/realtime`); Supabase Realtime as layer-2 fallback (retired 2026-11-04); 60s polling as layer-3 |
| House signing | Turnkey HSM — gameplay ixs only (retired 2026-11-04) |
| Hosting | Vercel, `kaboomweb3` team (**never** penguinpeckers-projects). Since 2026-11-04 Vercel hosts the frontend only; the API is on Railway |
| **Deploys** | **CLI-only. There is NO git integration — pushing to `main` deploys nothing.** |
| DB | Supabase Postgres (project ref in `NEXT_PUBLIC_SUPABASE_URL`) (retired 2026-11-04) |
| Secrets | Vercel encrypted env, `Sensitive` (unreadable by API by design). Since 2026-11-04 server secrets are sealed Railway variables (`docs/security/secrets.md`). Local keystore files under `~/.keystores/` — never in the repo. |

## Deploying

```bash
./scripts/deploy.sh                          # build → deploy → verify, all or nothing
./scripts/deploy.sh "toast copy,identifier"  # assert these RUNTIME strings landed in the bundle
./scripts/verify-deploy.sh                   # read-only re-verify of production
./scripts/watch-deploy.sh --once             # watch for the next deploy and verify it
```

`verify-deploy.sh` checks READY **and** aliased-to-domain, env vars decrypt non-empty, marker strings present in the served bundle, program live on chain, VRF client flag vs on-chain gate, and CSP allows the rollup endpoints.

Two traps that have each cost a session:
- **Markers must be runtime strings.** Minification strips comments, so a comment marker always reports a false FAIL.
- **Run the local build before deploying.** Next prerenders `/play`, so a hook that throws during render fails the build while typechecking clean.

Config that lives outside the repo (it is public): `~/.keystores/kaboom-vercel.ids` (project + team id), `~/.keystores/vercel-kaboomweb3.token`, `~/.keystores/kaboom-deploy-rpc.txt`, `~/.keystores/kaboom-relay-secrets.env`.

## Security posture

- Governance 2-of-2 on owner, treasury and upgrade authority; Turnkey confined to gameplay (retired 2026-11-04).
- **Session tokens are commitment-bound** — `/api/reveal` compares the token's commitment against the live on-chain one and returns 409 on mismatch. This closed a vault-drain vector where a token from a settled round could be replayed against a new game.
- VRF fail-closed: oracle queue is a program constant, validator is pinned in vault state, and both `vrf_mode_enabled` and a non-zero pinned validator must be set deliberately before any VRF game can open.
- `settle_vrf` trusts no committed rollup value that prices a payout.
- CSP must list `magicblock.app` — its absence silently killed every rollup request in the browser and produced four separate "the game keeps failing" reports with a healthy backend.
- Client version guard polls `/api/version` and reloads a stale tab when idle (banner mid-round), so the operator and the code are never on different builds.

## Security review — 2026-08-04

A full read of the codebase (on-chain program, API routes, server library, client,
database, CI, relay) was carried out on 2026-08-04. **The findings, their exploit
paths and the patch designs are deliberately NOT in this repo** — several concern
code that is still deployed, and this repository is public. They live in the
operator's local notes alongside `records.txt`.

What that review changed here, all shipped to production on 2026-08-06:

- **Event logs are attributed to the emitting program.** `extractEventsFromLogs`
  now rebuilds the invoke stack and decodes only what this program emitted, and
  `assertProgramInvoked` confirms from the transaction's account keys — which the
  runtime records, unlike log text — that it really ran. The indexer and the public
  verifier both gate on it. Log text is not authenticated; treat it as a
  convenience, never a proof.
- **A losing reveal is not disclosed until it is settled.** `sendHouseTx` returns on
  RPC acceptance, so answering immediately told a player the outcome while the game
  was still `Playing` on chain. `/api/reveal` now waits for the round to be decided
  and fails closed rather than disclosing early.
- **Reveal accounting reads the chain.** `revealed_mask` / `safe_reveals` on the game
  account, not the encrypted session copy, which two concurrent reveals could race
  into dropping a tile.
- **`/rpc-ws` on the relay is bounded.** Method allow-list, per-connection token
  bucket, frame and batch caps — matching what the HTTP proxy already enforced.
- **15 mines is withdrawn** from `MINE_OPTIONS` and rejected in `/api/commit`. See
  the note on that constant: a 15-mine board has one safe tile, so the perfect-game
  guard fires on the first reveal and the round has no winning path. Restore it only
  with the on-chain fix that makes the full-clear branch pay.
- **A working disclosure channel**: `/.well-known/security.txt`, `SECURITY.md` and
  `CONTRIBUTING.md` all point at GitHub's private advisory form. `SECURITY.md`'s
  claim that the treasury is a separate key from the owner was false and is corrected.
- **Terms §4 describes the game that is actually running** — per-click VRF as the
  default and commit-reveal as legacy — and points at the status endpoint for live
  values instead of quoting numbers that drift.

Remaining work from that review is on-chain and ships as one Squads upgrade.

## Pending / queued

**Squads 2-of-2 votes:**
1. The audit's program-side bundle. Designs and an integration review exist in the
   operator's local notes; they conflict with each other in specific ways and must
   be merged against one canonical account layout — read that review before writing
   any of it. The client must ship before the chain.
2. `max_payout_bps` 5000 → 100. Largest survival risk.
3. Release the 0.5488 SOL stale obligation (~85 days old).
4. Decide `max_user_position_bps` / `min_house_share_bps` / `seed_units`, all currently 0.
5. Bankroll top-up (~86 SOL to underwrite all mine counts at current caps).

**No vote needed:**
- Rotate the Alchemy RPC key. It was exposed in an earlier revision of this repo;
  rotation is the only fix.
- Enable private vulnerability reporting in the GitHub repo settings, or the link in
  `security.txt` and `SECURITY.md` 404s.
- Dependency bumps, narrowest first: `ws` in `apps/realtime` (that app is a public
  WebSocket server and is on a vulnerable version), then `bigint-buffer`, `js-cookie`.
  Do not run a blanket `npm audit fix` on this repo — it rewrites the lockfile across
  60+ advisories in one unreviewable step.
- CSP still ships `'unsafe-inline'` in `script-src`. Removing it needs a nonce; do
  not ship that blind.
- LP P&L SQL backfill.
- `LICENSE` file does not exist but the README claims MIT and `package.json` has no
  license field. Add the MIT text or drop the claim.
- Shrink VRF startup overhead: session funding is a one-line client constant and
  looks generous for a rollup where fees are ~0; VrfGame account size is a program
  change.

## Repo layout

```
playkaboom/
├── apps/
│   ├── web/                    Next.js 15 app + API routes + indexer
│   │   ├── src/app/api/        commit, reveal, settle, vrf/*, vault/*, status,
│   │   │                       version, ref/*, cron/*, ingest, rpc/*, verify/*
│   │   ├── src/lib/vrf/        rollup client — atomic start, confirm polling, undelegate
│   │   ├── src/server/         env, auth, session-store, indexer, solana, turnkey (retired 2026-11-04),
│   │   │                       verify-vrf, ratelimit
│   │   ├── src/hooks/          use-vrf-game (rollup state machine), use-game-actions
│   │   └── src/middleware.ts   status-subdomain host isolation
│   └── realtime/               Railway WS relay + Alchemy logsSubscribe ingest
├── programs/kaboom/src/
│   ├── lib.rs                  vault, commit-reveal, LP, referrals, owner ops
│   └── vrf_mode.rs             VrfClaim/VrfGame, delegation, per-click VRF, L1 replay
├── packages/sdk/               ix builders, decoders, PDAs, vrf, verify
├── packages/shared/            constants + zod schemas + multiplier math
├── supabase/migrations/       (retired 2026-11-04; live schema is db/migrations/)
├── scripts/                    deploy.sh, verify-deploy.sh, watch-deploy.sh + ops scripts
├── docs/security/              audit fix threads
├── tests/                      Vitest + Anchor integration + multiplier fixture
├── records.txt                 full session log — LOCAL-ONLY, gitignored
├── learnings.txt               durable lessons — LOCAL-ONLY, gitignored
└── HANDOFF.md                  this file (tracked)
```

## Quick verification

```bash
# Public health — every dependency in one request
curl -sS https://status.playkaboom.gg/api/status | python3 -m json.tool

# Vault state
curl -sS https://www.playkaboom.gg/api/vault/state | python3 -m json.tool

# Chain-only fairness check (no DB)
node scripts/verify-sig.mjs <sig>

# Production, end to end
./scripts/verify-deploy.sh

# Math tests
cargo test -p kaboom --lib
npm run test
```
