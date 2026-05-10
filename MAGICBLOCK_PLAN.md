# PlayKaboom → Magicblock Ephemeral Rollup Migration Plan

**Status**: Proposed (no code changes yet)
**Pivot anchor**: commit `cb4a963f20895080c7fa51e5e1c4a74bb8a5b4a9` on `main` — *do not delete or alter until Magicblock proves out in Phase 5.*
**Owner**: kaboomweb3@gmail.com
**Drafted**: 2026-05-11

---

## 1. Why this exists

Cut **per-game cost ~17x** ($1.70 → $0.10) and **per-tile latency ~10x** (~1s → ~100ms) by moving the in-game reveal loop from Turnkey HSM signing on Solana L1 to a Magicblock Ephemeral Rollup (ER). L1 commitments stay; only the reveal-loop execution moves.

## 2. Architecture decision: additive, not destructive

The migration is **additive**. We add ER-aware instructions and a feature-flagged ER routing layer *alongside* the existing Turnkey-on-L1 path. The current path keeps working at every phase. No Turnkey code is deleted until Phase 5 explicitly green-lights it.

```
┌──────────────┐        ┌─────────────────────────────┐
│ Player click │───────▶│ Backend (Next.js API route) │
└──────────────┘        └────────────┬────────────────┘
                                     │  feature flag
                          ┌──────────┴──────────┐
                          ▼                     ▼
                  ┌───────────────┐   ┌──────────────────┐
                  │ Turnkey + L1  │   │ Turnkey + ER     │
                  │ (today,       │   │ (new path,       │
                  │  fallback)    │   │  gradual rollout)│
                  └───────────────┘   └──────────────────┘
```

## 3. Critical security constraint (red-team result)

**Grid preimage must never enter ER state.** The validator can read its own memory; if the full grid lives in a delegated account, the operator gains a plaintext information advantage and Mines fairness is broken.

Current architecture already satisfies this:
- Grid + salt live server-side in the backend (held in Turnkey's session-bound state)
- On-chain state stores only the SHA-256 *commitment hash* (set at `start_game` on L1)
- `reveal_tile` ix records only the per-tile outcome (safe/mine), signed by Turnkey
- `settle_game` reveals full grid+salt; program verifies `SHA256(preimage) == committed_hash`

**Preserved in the migration**: `start_game` and the `committed_hash` field stay on L1 (never delegated). Only the *game outcome* state PDA gets delegated to ER. `settle_game` runs inside ER but the `commit_and_undelegate` lifecycle ensures the verified-final state lands back on L1 atomically.

## 4. Hard verifications required before mainnet (P0)

These must be answered on devnet before *any* real-money traffic:

| # | Question | How we verify |
|---|----------|---------------|
| V1 | Does `commit_frequency_ms` auto-expiry actually unlock a delegated PDA if the validator stalls? | Delegate, never settle, never commit. Wait. Confirm PDA returns to our program ownership. |
| V2 | Is there *any* user/house path to force-undelegate without the validator's cooperation? | Read SDK source + Discord with Magicblock team. Documented or undocumented. |
| V3 | What's the worst-case wait for a stuck delegated account? | Simulate by routing to a non-responsive validator. |
| V4 | Does Turnkey HSM signing latency dominate over the ER speed-up? | Benchmark end-to-end: click → response. If HSM adds 200-300ms anyway, the 10x latency claim is overstated. |
| V5 | Payout sequencing: can `settle_game` pay the player inside ER, or must it be a separate L1 ix post-undelegation? (Vault PDA is NOT delegated.) | Build both paths on devnet; measure UX. |
| V6 | Indexer impact: do Supabase webhooks fire on ER state changes, or only on L1 commits? | Subscribe to both, compare event timelines. |
| V7 | Anchor 0.31.1 compatibility with `ephemeral-rollups-sdk` 0.13.0 — clean `cargo build`? | Local build with both features. |

If V1 or V2 returns "no" without an acceptable workaround, this plan needs revision. Player funds being stranded is unacceptable for a real-money product.

## 5. Phased rollout

### Phase 0 — Safety net (Day 0, ~1 hour)

1. Create local git tag `pre-magicblock-pivot` pointing at `cb4a963`. *(Suggested command, user to run: `git tag pre-magicblock-pivot cb4a963`)*
2. Create branch `magicblock-spike` off main. All Phase 1 work happens here.
3. Append a "Magicblock pivot" entry to `records.txt` with the commit hash and date.
4. Confirm Turnkey path is fully green — run a fresh production game and verify normal completion.

**Gate to Phase 1**: tag created, branch created, Turnkey-on-mainnet path verified working.

### Phase 1 — Devnet integration (Days 1–9)

Anchor program changes (additive — keep existing instructions intact):

| Change | File | LOC | Notes |
|---|---|---|---|
| Add `ephemeral-rollups-sdk = "0.13.0"` dep | `programs/kaboom/Cargo.toml` | +1 | Features: `["anchor", "disable-realloc"]` |
| Add `#[ephemeral]` on program module | `programs/kaboom/src/lib.rs` | +1 | |
| Add `delegate_game(ctx)` ix (post-start_game, house signs) | `programs/kaboom/src/lib.rs` | ~30 | Uses `#[delegate]` macro; `commit_frequency_ms` configurable |
| Add `settle_game_er(ctx, preimage)` ix that commits+undelegates | `programs/kaboom/src/lib.rs` | ~40 | Existing `settle_game` stays untouched as fallback |
| `reveal_tile` body — **unchanged**, but signer constraint still checks `house_authority` | `programs/kaboom/src/lib.rs:1949-1950` | 0 | Just runs in ER now |

Backend changes:

| Change | File | Approach |
|---|---|---|
| Install `@magicblock-labs/ephemeral-rollups-sdk@0.13.0` | `apps/web/package.json` | New dep |
| Add ER connection helper | `apps/web/src/server/magicblock.ts` (new) | Dual `Connection`: L1 + ER, with region selection |
| Add ER signing path to `sendHouseTx` | `apps/web/src/server/solana.ts:27-52` | New arg `target: 'l1' \| 'er'`; default `'l1'` keeps current behavior |
| Feature flag for ER routing | `apps/web/src/server/env.ts` | `MAGICBLOCK_ENABLED` env var (default `false`); per-game routing decision in API routes |
| Reveal route: branch on flag | `apps/web/src/app/api/reveal/route.ts:72-102` | If `MAGICBLOCK_ENABLED && game.delegated`, send to ER; else current path |
| Settle route: branch on flag | (wherever `settle_game` is called) | Same pattern |

Devnet test plan:
1. Deploy modified program to a fresh devnet program ID (not the mainnet ID).
2. Run V1–V7 from §4 systematically.
3. Run a full game loop 100x: start → delegate → 5–15 reveals → settle → assert L1 final state and player payout.
4. Run abandonment 20x: start → delegate → walk away. Confirm recovery path (auto-expiry or refund).
5. Run failure injection: kill the ER connection mid-game. Confirm fallback or recovery.
6. Benchmark: measure click→response latency vs current Turnkey-on-L1. Compare against the 10x claim.

**Gate to Phase 2**:
- All V1–V7 answered and documented
- Devnet success rate ≥ 99% over 100+ games
- Measured latency improvement ≥ 5x (relaxed from 10x claim)
- Cost per game on devnet matches the $0.10 model (within 20%)
- Magicblock team contact established for incident escalation

### Phase 2 — Mainnet shadow mode (Weeks 2–3)

- Deploy program v2 with additive instructions to **mainnet** (Squads 2/2 multisig — coordinate with member 2).
- `MAGICBLOCK_ENABLED=false` in production env. **No real player traffic touches ER yet.**
- For every real game, run a parallel "shadow" simulation: same inputs replayed through ER in a sidecar service. Compare commits, latencies, error rates.
- Build observability:
  - Dashboard: L1 vs shadow-ER latency p50/p95/p99
  - Alert: any shadow-ER divergence in committed state
  - Alert: shadow-ER outage detected
- Establish auto-rollback triggers (see §6) and test them in shadow.

**Gate to Phase 3**:
- 7+ days of shadow with zero state divergences
- Shadow-ER uptime ≥ 99.5%
- All auto-rollback triggers manually fire-tested
- Operational runbook written and reviewed
- Magicblock status page now actually monitored (or a self-hosted health check on the ER endpoint is live)

### Phase 3 — 1% canary, micro-stakes only (Week 4)

- `MAGICBLOCK_ENABLED=true` but gated by:
  - Per-wallet feature flag: 1% of wallets
  - Bet cap: ≤ 0.01 SOL per game
  - Single region (closest to majority of players)
- Auto-rollback wired live.
- Operational vigilance: human on-call during canary hours.

**Gate to Phase 4**:
- 7 days, ≥ 500 ER-routed games, zero stranded funds, error rate < 0.5%
- p95 latency improvement holds in production
- No security incidents

### Phase 4 — Gradual rollout (Weeks 5–8)

| Week | % traffic | Stake cap | Regions |
|---|---|---|---|
| 5 | 5% | ≤ 0.05 SOL | 2 regions |
| 6 | 25% | ≤ 0.1 SOL | All regions |
| 7 | 50% | ≤ 0.5 SOL | All regions |
| 8 | 100% | All stakes | All regions |

Any auto-rollback trigger fires → freeze rollout, return to previous step, investigate.

**Gate to Phase 5**:
- 4 weeks at 100% with no P0/P1 incidents
- Cost savings realized as modeled
- Magicblock Phase 3 (permissionless + slashing) roadmap clarity from their team

### Phase 5 — Decision point (Week 9+)

Three options, chosen by the user:

**Option A: Keep hybrid permanently** *(recommended)*
- Turnkey-on-L1 stays as the high-stakes path (e.g. games above some threshold) and as kill-switch fallback
- ER handles the volume tier
- Turnkey code stays in the repo

**Option B: Full migration**
- Retire Turnkey-on-L1 from the production path
- Keep code in repo (don't delete) for one more month as a break-glass restore
- Document the rollback procedure
- Only after Magicblock Phase 3 is live + audited should we consider deleting Turnkey

**Option C: Roll back**
- Revert to `cb4a963` (the pivot anchor)
- Document what we learned about ER for future revisit

## 6. Auto-rollback triggers (live from Phase 3 onward)

Any one of these flips routing back to Turnkey-on-L1 within 60 seconds:

| Trigger | Threshold |
|---|---|
| ER `commit_state` or `undelegate` p95 latency | > 5s sustained 60s |
| ER tx error rate | > 1% over 60s |
| Consecutive `CommitFinalizeAndUndelegate` failures | > 3 across distinct sessions |
| Per-game undelegation latency | > 30s |
| ER endpoint HTTP/TCP health | > 20% failure over 30s |
| State divergence between ER-committed and L1-finalized | any non-zero |
| Stuck delegation (no commit within `commit_frequency_ms` × 3) | per game |
| Magicblock status page | non-green for > 5min |

When triggered: route new games to Turnkey path, drain in-flight ER games via normal settle, page on-call.

## 7. What gets DELETED — and when

**Never in Phases 0–4.** Every Phase 0–4 change is additive: new files, new ix variants, new feature flag, parallel routing logic. Existing Turnkey HSM signer (`turnkey-signer.ts`), `sendHouseTx` defaults, the existing `reveal_tile` and `settle_game` instruction bodies — all stay intact and reachable.

**Earliest deletion: Phase 5 + 4 weeks of stable 100%.** Even then:
- Anchor program: deprecate (don't remove) old instructions for one mainnet upgrade cycle
- Turnkey signer code: stays as a comment-tagged module for one more month after the deprecation cycle
- Env vars `TURNKEY_*` remain in Vercel encrypted env for rollback

Only after Magicblock ships Phase 3 (permissionless validators + slashing) *and* it's audit-reviewed do we consider full Turnkey removal. Realistic timeline: 6+ months from today.

## 8. Effort + cost

| Phase | Calendar | Eng days | Other cost |
|---|---|---|---|
| 0 — Safety net | 1 day | 0.5 | — |
| 1 — Devnet integration | 2 weeks | ~9 | Devnet fees negligible |
| 2 — Mainnet shadow | 2 weeks | ~5 | Mainnet redeploy (Squads coord, ~0.1 SOL gas) |
| 3 — 1% canary | 1 week | ~2 | On-call coverage |
| 4 — Gradual rollout | 4 weeks | ~3 | — |
| 5 — Decision | ongoing | varies | — |
| **Total to 100%** | ~9 weeks | ~20 days | < 0.5 SOL gas total |

Cost savings at scale (assuming 1k games/day): ~$48k/month, payback in days once at full traffic.

## 9. Open questions for the user (no answers needed to start Phase 0)

1. Which Squads member 2 to coordinate with for mainnet program redeploys? (Same as Phase H?)
2. Acceptable max bet cap for the Phase 3 canary? (Plan suggests 0.01 SOL; ok or different?)
3. Public messaging: do we announce "now powered by Magicblock" at any phase, or stay silent until 100%?
4. Magicblock support contract — do we want to formally engage with their team and ask for an SLA before mainnet shadow?

## 10. Risks not mitigated by this plan

- **Magicblock company risk**: validator infra is a single-vendor dependency. If Magicblock the company stops operating, Phase 3+ becomes operationally unstable. Mitigation: keep Turnkey path warm; budget for a 1-week rollback drill quarterly.
- **SDK churn**: Magicblock SDK has shipped 5 minor versions in 4 months. We pin to a specific tag, no auto-upgrade. Mitigation: explicit upgrade PR + regression suite.
- **Unknown unknowns**: Phase 2 ER infrastructure has live P1 bugs in commit/undelegate paths (per validator repo issues). Mitigation: aggressive auto-rollback triggers + small bet caps in early phases.

---

## Appendix A — Files touched (final tally, expected)

| Path | Phase 0 | Phase 1 (additive) | Phase 5+ (deletion candidate) |
|---|---|---|---|
| `programs/kaboom/Cargo.toml` | — | +1 dep | — |
| `programs/kaboom/src/lib.rs` | — | +`delegate_game`, +`settle_game_er`, +`#[ephemeral]` | Maybe deprecate old `reveal_tile`/`settle_game` |
| `apps/web/package.json` | — | +1 dep | — |
| `apps/web/src/server/magicblock.ts` | — | new file | — |
| `apps/web/src/server/solana.ts` | — | +`target` arg in `sendHouseTx` | Simplify if ER becomes default |
| `apps/web/src/server/env.ts` | — | +`MAGICBLOCK_ENABLED` | Remove `TURNKEY_*` only in Phase 5+ |
| `apps/web/src/server/turnkey-signer.ts` | — | unchanged | Deletion candidate at Phase 5+ |
| `apps/web/src/app/api/reveal/route.ts` | — | +feature-flag branch | Simplify in Phase 5+ |
| `apps/web/src/hooks/use-game-actions.ts` | — | optional spinner tuning | — |

## Appendix B — Handoff state (paused 2026-05-11)

Resume here in a future session.

### Where we are
- **Branch**: `magicblock-spike` (off `main` at the pivot `cb4a963`, tagged `pre-magicblock-pivot`).
- **Phase**: 0 complete + Phase 1 code-complete on the spike branch. Nothing deployed on-chain yet. `MAGICBLOCK_ENABLED=false` everywhere.
- **Status of `main`**: untouched at `cb4a963`. Production behavior unchanged.

### What's implemented (additive, all behind `MAGICBLOCK_ENABLED=false`)
- **Anchor** (`programs/kaboom/src/lib.rs`, `Cargo.toml`): added `ephemeral-rollups-sdk@0.13.0`, `#[ephemeral]` on module, new `GameSessionV2` account at seed `game_v2`, four new instructions — `start_game_er`, `delegate_game`, `reveal_tile_er`, `settle_game_er`. `cargo check -p kaboom` clean.
- **Backend** (`apps/web/`): added `@magicblock-labs/ephemeral-rollups-sdk@^0.13.0`. New files: `server/magicblock.ts`, `server/session-keys.ts`, `server/er-instructions.ts`, `server/migrations/<timestamp>_game_session_keys.sql`. Modified `server/env.ts` (flag + ER URLs + validator lookup), `server/solana.ts` (added `target: 'l1'|'er'` to `sendHouseTx`). Three API routes (`commit`, `reveal`, `settle`) have additive `useMagicblock()` branches. `tsc --noEmit` clean.
- **Integration fixes applied**: settle_game_er wire format aligned to `(mine_layout: u16, salt: [u8;32])` (matches legacy settle_game); all ER routes correctly derive V2 PDA at seed `game_v2`.

### Decisions locked
- **Hybrid additive** migration — Turnkey stays primary, ER is feature-flagged routing layer.
- **delegate_game trigger pattern: B (lazy)** — server confirms start tx + delegates inside the first reveal call. Not yet wired in code (Agent B left a TODO comment in `commit/route.ts:48-58`).
- **No Squads coordination yet** — user prefers to defer the mainnet program redeploy.

### Decision still pending on resume
**Program deploy path** — three options on the table:
1. **Devnet-first** *(no Squads)*: deploy to devnet as a fresh program, run V1–V7 there. Adds ~1 week; produces real evidence to take to Squads later. **Recommended.**
2. **Mainnet via Squads**: get member 2 to co-sign a fully additive redeploy. The new binary is 872 KB; net gas after buffer-rent refund is ~$0.20–$300 (worst case requires program data resize).
3. **New mainnet program ID**: deploy a fresh v2 program, no Squads needed. Much bigger product change (split liquidity, migration story). **Not recommended.**

### Env vars to set in Vercel (sensitive, encrypted scope, prod + preview)
- `MAGICBLOCK_ENABLED` = `false`  *(MUST stay false until redeploy + V1–V7 pass)*
- `MAGICBLOCK_ER_URL` = `https://as.magicblock.app/`
- `MAGICBLOCK_ER_WS_URL` = `wss://as.magicblock.app/`
- `MAGICBLOCK_VALIDATOR_AS` = `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`
- `MAGICBLOCK_VALIDATOR_US` / `MAGICBLOCK_VALIDATOR_EU` = blank for now
- **DO NOT** delete any existing TURNKEY_*, HOUSE_AUTHORITY_KEY, USE_TURNKEY, SESSION_ENC_KEY — they're the rollback path.

### Concrete next steps when work resumes
1. Pick deploy path (option 1, 2, or 3 above).
2. Wire the lazy-delegate (`delegate_game`) inside the first `/api/reveal` call — Agent B left a placeholder; needs ~30 lines (confirm start tx → build delegate_game ix via `buildDelegateGame` → `sendHouseTx([ix], { target: 'l1' })` → mark game as delegated server-side → proceed with reveal).
3. Deploy the program changes via the chosen path.
4. Run V1–V7 verifications (see §4 of this plan).
5. Set Vercel env vars per the table above.
6. Flip `MAGICBLOCK_ENABLED=true` for our own test wallets only (one-wallet feature flag).
7. Proceed to Phase 2 of the rollout plan (mainnet shadow).

### Sanity checks before resuming any work
- `git log -1 --format='%H %s'` on `main` should still be `cb4a963 fix(cashOut): await settle_game confirm before /api/cleanup`.
- `git tag -l pre-magicblock-pivot` should print `pre-magicblock-pivot`.
- `git branch --show-current` on a fresh checkout: switch to `magicblock-spike` to see the migration work.

## Appendix C — Sources

- Magicblock SDK: <https://github.com/magicblock-labs/ephemeral-rollups-sdk>
- Magicblock validator: <https://github.com/magicblock-labs/magicblock-validator>
- Delegation program: <https://github.com/magicblock-labs/delegation-program>
- Magicblock docs: <https://docs.magicblock.gg/>
- Pricing: <https://docs.magicblock.gg/pages/overview/additional-information/pricing>
- $BLOCK tokenomics: <https://www.magicblock.xyz/blog/block-tokenomics>
- Magicnet roadmap (Phase 2/3): <https://www.magicblock.xyz/blog/introducing-magicnet>
