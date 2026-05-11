# PlayKaboom — Session Handoff

A self-contained snapshot you can paste into a fresh Claude session to pick up where the previous session left off. Refreshed **2026-05-12** (chain-truth gate on reveal/settle, fixes player-reported 500s during play). Full session-by-session log lives in `records.txt`.

## STATUS — 2026-05-12 (mainnet, chain-truth gate live)

**Live on Solana mainnet at https://playkaboom.gg.** All admin/treasury/upgrade authorities on Squads 2/2. Hot game-ix signer on Turnkey HSM. The 2026-05-11 sweep audited every layer (program, SDK, API, frontend, indexer, RLS, build/CI, tests) via 8 parallel sub-agents; every HIGH finding has a fix shipped.

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
| Vault PDA | `9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK` | program-owned, ~11.66 SOL |
| Deployer wallet | `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG` | zero admin powers — fee-payer only |

**Key implication:** a stolen deployer or Turnkey key gets you nothing material. Turnkey can sign game ixs only (start/reveal/settle/refund/close); admin/treasury/upgrade all need Squads 2/2.

## Live config + economics (mainnet vault)

| Param | Value | Notes |
|---|---|---|
| `house_edge_bps` | 200 (2.00%) | |
| `max_bet_bps` | 200 (2% of vault) | At ~11.66 SOL vault → 0.233 SOL max |
| `max_payout_bps` | **5000 (50% of vault)** ⚠️ | Industry std is 0.5–1%. Still queued (Squads 2/2 vote). |
| `treasury_split_bps` | 5000 (50/50) | LP gets half, treasury gets half |
| Vault PDA balance | ~11.66 SOL | LP + obligations + accrued fees |

Math is provably correct on both sides: TS `calcMultiplierBps` and Rust `calc_multiplier` now share a 675-row fixture (`tests/fixtures/multiplier.json`) covering mine_count 1..15 × safe_reveals 0..(16-mc) × edge_bps {0, 100, 200, 500, 1000}. Both implementations assert against the fixture in CI; any drift breaks the build.

## Stack & infra

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, Tailwind, Privy embedded wallets |
| RPC | Alchemy mainnet (deploy & user reads); public mainnet for fallback |
| Indexer | Helius webhook → Supabase Postgres. Atomic SQL deltas (idx_apply_*) on every read-modify-write counter. INSERT-first dedupe with apply-error rollback. Settle handler retries on no-match (handles Helius out-of-order event delivery). |
| Realtime | Railway WS relay (apps/realtime) on INSERT+UPDATE events; Supabase Realtime as Layer-2 fallback; TanStack 60s polling as Layer-3. |
| House signing | Turnkey HSM — signs reveal/settle/refund/close ixs only |
| Hosting | Vercel kaboomweb3-6280 account, project `playkaboom` |
| Auto-deploy | **GH Actions, gated on CI success** (`.github/workflows/vercel-deploy.yml`) — triggers via `workflow_run` after CI completes with conclusion=success. Red CI = no deploy. |
| DB | Supabase project `vrxeqgynejlnmwsifvml` |
| Sensitive secrets | Vercel-only encrypted env (TURNKEY_*, SUPABASE_SERVICE_ROLE_KEY, PRIVY_APP_SECRET, SESSION_ENC_KEY, HELIUS_WEBHOOK_AUTH, CRON_SECRET). Local `.env.local` is public values only. |

## Testing posture (NEW as of 2026-05-11)

- **Math invariants (CI gate):** `cargo test -p kaboom --lib` runs Rust `multiplier_tests` against the 675-cell fixture. `npm run test` runs 690 vitest cases including the TS-side fixture parity test.
- **Anchor integration:** `tests/anchor/` is a real workspace (`@playkaboom/anchor-tests`) with five tests against a local validator started by `anchor test`: happy path, double-start blocked, cashout-no-reveals, settle-wrong-layout, refund-too-early. Triggered by Anchor.toml's `[scripts] test` calling `tsx tests/anchor/runner.ts`. CI step is `continue-on-error: true` for first runs; remove once validator startup is reliable on the GH runner.
- **DB invariants (nightly):** `.github/workflows/invariants.yml` runs `scripts/check-invariants.mjs` at 03:00 UTC. Asserts `multiplier_bps == calcMultiplier(safe_reveals, mine_count, 200)`, `popcount(mine_layout) == mine_count`, and SHA-256 commitment match for every settled row. Allow-list at `scripts/known-corruption-allow.txt` exempts the 17 legacy 2026-05-11-corrupted rows.
- **Chain-only verifier CLI:** `node scripts/verify-sig.mjs <sig>` reproduces fairness proof from chain RPC alone. Use as authoritative source if `/verify/[sig]` ever disagrees.

## Indexer reliability

- INSERT-first dedupe in `ingestTransactions` (close TOCTOU of two concurrent Helius deliveries).
- On apply-loop throw, DELETE the `processed_events` claim before rethrowing so cron retry can re-attempt.
- All RMW counters (Lp*, ReferralAccrued/Claimed, StatsUpdated) go through atomic SQL functions (`idx_apply_*`) — no read-then-write race.
- `idx_apply_game_settled` returns row count. Handler throws on 0 → claim is released → cron retries once cashout row exists (handles Helius out-of-order event delivery).
- `uniq_games_unsettled_per_pda` partial unique index forbids two unsettled rows for the same PDA at the same slot.
- Slot-monotonic guards on `player_stats`, `referrals`, `lp_positions` (`last_event_slot` column).

## Recent shipped — 2026-05-12 / 2026-05-11

(Newest first, all in `origin/main`. The CI/deploy gate landed in batch 3 — every commit after that REQUIRED CI green to deploy.)

| Commit | What |
|---|---|
| `7b02e4c` | **chain-truth gate on /api/reveal + /api/settle.** Fixes the 500-on-tile-click report: stale `gameToken` (from a closed PDA, or a tile-click landing before `start_game` propagated) no longer bubbles `AccountNotInitialized` as a 500. New `requireActiveGame()` probes the GameSession PDA at `confirmed` with 3×250 ms retry — absorbs the propagation race, deletes the server-side session and returns `409 { needsCleanup: true }` when the PDA is truly absent. `sendHouseTx` catches `SendTransactionError` and classifies the Anchor framework error (code 3012) as a typed `OnChainError` for TOCTOU safety. Client `revealTile` and `cashOut` now wire 409+`needsCleanup` into the existing `cleanupStuck` flow. SDK: `extractAnchorFrameworkError` + `isAccountNotInitializedError` decode both the structured AnchorError log line and the bare `custom program error: 0xbc4` fallback; 11 new unit tests cover real RPC log shapes. No UI changes. |
| `f907d93` | auto-bundle `set_referrer` into the player's first `start_game` (single Privy signing prompt, atomic) |
| `e6cf831` | `/install` route deep-linking to Solana dApp Store |
| `8a5965f` | realtime relay broadcasts INSERT+UPDATE (was INSERT-only); applyIncoming merges in-place |
| `9668104` | strip 13 debug console.log/warn from game flow |
| `c73fdb7` | settle handler retries on no-match (out-of-order Helius delivery); backfill of `52mySrDaDM…` |
| `c37c2bd` | anchor-tests workspace fix (excluded from turbo test; tsx for ESM bridge) |
| `89e41e1` | real Anchor integration tests + workspace + CI wiring |
| `b7761ff` | SSG hotfix: move `useToast` out of `PrivyAuthBridge` |
| `d3e99ed` | vercel CLI unpin (v39 broke env-var auth) |
| `7221a34` | auth 401/429 handlers + safe JSON parsing |
| `8a8788a` | 675-cell TS↔Rust `calc_multiplier` fixture parity + `cargo test` in CI |
| `15315b2` | realtime numReplicas=1, dyn priority fee, Helius payload cap, update_vault zero-key reject (source-only) |
| `4a66f18` | DB hardening: slot guards, FORCE rls on 8 tables, unique-unsettled-per-PDA, idempotent reset migration |
| `c2ee6ac` | **CI/deploy gate ENABLED.** Vercel deploy now requires CI green. CODEOWNERS, npm ci, vercel CLI pin, turbo secret-cache fix |
| `802ed22` | sync-ref double-click guards on cashout / LP / Withdraw modal |
| `e412f84` | indexer regression fix, /api/verify PDA cross-check, /api/ref/* chain verify + ratelimit, SDK error names, legacy-row cleanup migration |
| `0a428ad` | hotfix: ratelimit fail-open when Upstash env missing (morning regression) |

## Pending / queued for next session

**On-chain (each is a Squads 2/2 vote):**
1. **`update_vault`: max_payout_bps 5000 → 100.** Still the biggest survival risk. 50% drain on a single max-bet 12-mine win, P ≈ 0.055%/attempt. Industry std is 0.5–1%.
2. **`update_v2_config`: min_health_bps 1000 → 2000.** Auto-pause earlier when stressed.
3. **Program upgrade** to activate the source-only `update_vault` zero-key guard (`require!(auth != Pubkey::default())` added 2026-05-11 in lib.rs:933-941; not on chain yet).

**Operational (no code):**
- **GitHub branch protection rule:** Settings → Branches → `main` → enable "Require status checks (CI) to pass" + "Require review from Code Owners". CODEOWNERS file is committed but advisory until you toggle.
- **Turnkey console policy:** pin `programId=Kaboom` + ix discriminator allow-list. Belt-and-suspenders; current on-chain account constraints already block non-game ixs.
- **Provision Upstash Redis** (Vercel Marketplace) if HTTP-layer rate limiting is wanted. Code activates immediately once `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` appear in Vercel env — no redeploy needed.
- **Logger transport:** pick Axiom / Better Stack / Logflare, wire `pino-*-send`. Currently stdout-only (24h Vercel log retention).
- **Anchor test `continue-on-error`**: remove the flag from `.github/workflows/ci.yml` once first runs prove the validator+toolchain works on the GH runner.

**Code (lower priority):**
- Move `gameToken` from localStorage to sessionStorage (defense-in-depth: XSS-readable mine layout for the active session).
- WinModal payout derived client-side from `calcMultiplier` — fragile if package versions ever fork. Pull from server response.
- `/api/rpc/[cluster]` tighten `getSignaturesForAddress`/`getMultipleAccounts`/`sendTransaction` limits.
- `/api/verify/[signature]` regex `{64,128}` too loose; should be `{86,90}`.
- Replace runner's PDA-derivation smoke tests with full integration test count (currently 5; the audit listed 10 high-priority cases).

## How to deploy

**Auto:** push to main → CI runs → on success, Vercel Deploy auto-fires via `workflow_run` trigger. **No deploy if CI fails.** Concurrency group cancels in-flight runs on newer pushes.

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
supabase db push --linked
```

**One-shot indexer rescue** (now requires confirm-prefix matching current cursor):
```bash
# Read current cursor first
gh workflow run index-events.yml --repo penguinpecker/playkaboom \
  --ref main -f confirm=<first-8-chars-of-cron_indexer_state.last_signature>
```

**Run integration tests locally:**
```bash
cd ~/Projects/playkaboom && anchor test
```

## Critical lessons (carried forward)

1. **Squads V4 Tx Builder Raw data field expects base58, NOT hex.** (Saved as feedback memory.)
2. **Vercel Sensitive env vars are non-decryptable by API or `vercel env pull`.**
3. **GitHub Actions secret-masking breaks `--token=${{ secrets.X }}` inline.** Use `env:` block.
4. **`gh secret set X --body -` sets the value to literal "-".** Omit `--body`.
5. **`vercel build --prebuilt` fails for Next routes that need runtime ctx.** Use `vercel deploy --prod`.
6. **Don't bundle untracked local files into commits even on "push the rest".** (Saved as feedback memory.)
7. **No secret fragments in committed docs** — even truncated forms leak identity. (Saved as feedback memory.)
8. **Operator-first deploy, multisig handoff at the literal end.** (Saved as feedback memory.)
9. **Audit scope must include indexer + UI, not just the program.** (NEW 2026-05-11; saved as feedback memory.) Solana audit firms default to scoping the Anchor program only. The display layer matters too — a self-consistent SHA-256 verification of WRONG game data still passes math but lies to the user.
10. **Verify env vars + critical paths BEFORE shipping fail-closed changes.** (NEW 2026-05-11; saved as feedback memory.) Env-var names in memory ≠ configured. Check the live env with `vercel env ls` and hit the endpoint before pushing to a live-auto-deploy main.
11. **PDA reuse + non-unique indexer matching → cross-instance bleed.** (Internalized 2026-05-11.) Whenever an indexer's UPDATE keys on a reusable PDA, ensure at most one row can match: partial unique index, slot guard, or single-row subquery (most-recent slot ≤ event_slot).
12. **Helius can deliver events out of order.** Settle handlers must self-heal when the cashout row isn't yet present — throw on no-match, release the dedupe claim, let the cron's next pass retry.

## Repo layout (for orientation)

```
playkaboom/
├── apps/web/                  Next.js 15 app + API routes
│   ├── src/app/api/cron/      index-events, vault-health
│   ├── src/app/api/admin/     backfill-points, release-stuck-obligations
│   ├── src/server/            indexer.ts, inline-ingest.ts, points.ts,
│   │                          turnkey-signer.ts, auth.ts, ratelimit.ts,
│   │                          logger.ts (wide redact list)
│   └── src/components/        Navbar, Footer, modals, game/, ui/,
│                              providers/{web3,auth-toast-bridge,toast}
├── apps/realtime/             Railway WS relay (INSERT+UPDATE on `games`)
├── programs/kaboom/src/lib.rs Anchor program + #[cfg(test)] multiplier_tests
├── packages/sdk/              TS ix builders, account/event decoders,
│                              errors.ts (all ~42 on-chain variants)
├── packages/shared/           Zod schemas + multiplier math + constants
├── supabase/migrations/       Postgres migrations (atomic idx_apply_*,
│                              FORCE rls, idempotent guards)
├── tests/
│   ├── anchor/                Real integration tests (workspace pkg)
│   ├── sdk/                   Vitest (690 cases incl. fixture parity)
│   └── fixtures/              multiplier.json (TS↔Rust drift oracle)
├── scripts/                   check-invariants.mjs, verify-sig.mjs,
│                              audit-multipliers.mjs, ops scripts
├── .github/
│   ├── CODEOWNERS             advisory until branch-protection toggled
│   └── workflows/             ci.yml (gates deploy via workflow_run),
│                              vercel-deploy.yml (workflow_run-triggered),
│                              invariants.yml (nightly DB assert),
│                              codeql.yml, vault-health.yml,
│                              index-events.yml (?confirm guard),
│                              release-stuck-obligations.yml (confirm-input)
├── records.txt                full session log (≈3500 lines)
└── HANDOFF.md                 this file
```

## Quick verification commands

```bash
# Live health
curl -sS https://www.playkaboom.gg/api/health | python3 -m json.tool

# Live verifier on a specific cashout sig
curl -sS "https://www.playkaboom.gg/api/verify?sig=<sig>" | python3 -m json.tool

# Chain-only fairness check (no DB)
node scripts/verify-sig.mjs <sig>

# DB invariants (with anon key)
SUPABASE_URL=https://vrxeqgynejlnmwsifvml.supabase.co \
SUPABASE_ANON_KEY=<anon-from-env> \
ALLOWED_MISMATCH_SIGNATURES_PATH=scripts/known-corruption-allow.txt \
node scripts/check-invariants.mjs

# Vault state on-chain
solana account 9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK \
  --url https://api.mainnet-beta.solana.com

# Latest deploy + CI status
gh run list --repo penguinpecker/playkaboom --limit 5

# Math tests
cargo test -p kaboom --lib                 # 5 Rust cases
npm run test --workspace=@playkaboom/sdk-tests   # 690 TS cases
```
