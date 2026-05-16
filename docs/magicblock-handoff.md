# Magicblock ER Integration — Handoff

**Status:** DEFERRED. Code ready, external blocker open.
**Owner:** kaboomweb3@gmail.com
**Last touched:** 2026-05-17
**Pickup file:** start here. Cross-references `script.txt` (today's session log) and `MAGICBLOCK_PLAN.md` (the older 302-line phased plan on the spike branch).

---

## What this is

Migrate PlayKaboom's per-tile signing from Turnkey-on-Solana-L1 to a Magicblock Ephemeral Rollup. Goal: cut Turnkey HSM dependence on the reveal hot path (~17 sigs/game → 2 sigs/game = delegate + final settle), cut per-tile latency, cut per-game cost.

---

## Where the work is

| Item | Location |
|---|---|
| Full ER program code (Anchor) | `origin/magicblock-bundle-2` branch, HEAD `b64d838` |
| Web app ER-aware code | Already on `main` (gated, dormant) — `apps/web/src/server/{er-instructions,magicblock,session-keys}.ts`, `if (useMagicblock())` branches in commit/reveal/settle routes |
| Original phased plan doc | `git show magicblock-bundle-2:MAGICBLOCK_PLAN.md` (302 lines, drafted 2026-05-11) |
| Pivot anchor (rollback target) | git tag `pre-magicblock-pivot` at commit `cb4a963` (local + origin) |
| Force-undelegate question draft | `docs/magicblock-force-undelegate-issue-draft.md` (now filed publicly) |

---

## Hard blocker — wait on this before anything else

**[`magicblock-labs/delegation-program#182`](https://github.com/magicblock-labs/delegation-program/issues/182)** — "Documenting the force-undelegate / validator-stall recovery path for the program owner"

As of 2026-05-17: **OPEN, 0 comments, no Magicblock response.**

We are NOT shipping ER to mainnet until this has a written answer. Reason: if a Magicblock validator goes silent mid-game with a player's session delegated, there's no documented recourse for the program owner to reclaim that account. Player session stuck → player funds locked → bad ending for a real-money product.

### Nudging options (in escalation order)

1. **Andy Weng — DevRel** — [@fauxfire_](https://x.com/fauxfire_) — first ping. Politely link the issue.
2. **Gabriele Picco — CTO** — [@PiccoGabriele](https://x.com/PiccoGabriele) — architectural answer.
3. **Andrea Fortugno — CEO** — [@supermarioblock](https://x.com/supermarioblock) — escalation.
4. **Company account** — [@magicblock](https://x.com/magicblock) — public quote-tweet of the issue. Sometimes accelerates internal routing.

Sample DM:

> @fauxfire_ — filed magicblock-labs/delegation-program#182 about the program-owner force-undelegate path when a validator stalls. Real-money Solana app, need a documented recovery story before flipping ER on. Any chance you or @PiccoGabriele can weigh in? Happy to take it off-chain.

---

## Other Magicblock-side concerns (track but not strictly blocking)

| Item | Status |
|---|---|
| Validator bug `#1152` (commit+undelegate ≥11 accts fails) | Open, assigned `taco-paco`, no movement |
| Validator bug `#1124` (delegated PDA leak after base close) | Open, assigned `snawaz`, no movement |
| SDK churn `0.13.0` → `0.14.1` (Solana 3.0 dep bump) | Pin to 0.13.0 for now. 0.14.x is untested vs Anchor 0.31.1 in any public real-money product. |
| Status page / SLA | None published. No incident history available. |
| Magicnet Phase 3 (permissionless validators + slashing) | Roadmapped, not live. Phase 2 (permissioned operators, no slashing) is what's actually shipped. |

Real-money gaming customers running on Magicblock today: Zeebit only (no published volumes). Loofta Pay uses ER for payments, not gaming. Single-vendor risk is real.

---

## What's on the spike branch — concretely

`origin/magicblock-bundle-2` adds (on top of current main):

**Anchor program (`programs/kaboom/src/lib.rs`, +1021 LOC):**
- `ephemeral-rollups-sdk = "0.13.0"` dep in Cargo.toml
- `#[ephemeral]` attribute on the program module
- 4 new ixs:
  - `start_game_er` — like start_game but writes to `GameSessionV2` and records the per-game session key pubkey
  - `delegate_game` — Turnkey-signed; flips GameSessionV2 PDA into ER-delegated state via the delegation-program CPI
  - `reveal_tile_er` — session-key signed (not Turnkey); runs inside ER
  - `settle_game_er` — Turnkey-signed; commits state + undelegates atomically via `#[commit]` macro
- `GameSessionV2` account at seed `game_v2` (separate from the legacy `GameSession` seed `kaboom_game`)
- On-chain `er_enabled: bool` field in VaultV2State (1 byte from `_reserved`), defaults false. Kill-switch.
- `update_v2_config` accepts `er_enabled: Option<bool>` to flip the kill-switch
- Error variants: `SessionKeyMissing`, `ErRoutingDisabled`

**SDK / web (already on main, dormant):**
- `apps/web/src/server/er-instructions.ts` — TS builders for the 4 new ixs
- `apps/web/src/server/magicblock.ts` — Solana Connection to ER endpoint + region-aware validator pubkey lookup
- `apps/web/src/server/session-keys.ts` — per-game ephemeral keypair + AES-256-GCM encrypted Supabase storage + `claimDelegationSlot` for atomic first-reveal delegation
- `apps/web/src/server/env.ts` — `useMagicblock()`, `magicblockErUrl()`, `magicblockErWsUrl()`
- Feature-flag branches in `/api/commit`, `/api/reveal`, `/api/settle` (all gated `if (useMagicblock())`)
- Supabase migration `20260516000000_game_session_keys.sql` (already applied to production DB — dormant table)
- Supabase migration `20260516000001_game_session_keys_delegated_at.sql` (already applied — dormant column)

---

## Architecture decisions already baked in

1. **Variant B (session keys), not Variant A** — Per-tile reveals signed by an ephemeral per-game keypair, NOT Turnkey. Turnkey signs only `delegate_game` (start) and `settle_game_er` (end). Drops Turnkey load from ~17 sigs/game to 2 sigs/game.

2. **Preimage stays out of ER state** — `GameSessionV2` only stores the commitment hash, not the mine layout / salt. The validator can read its own memory; preimage there = operator gains information advantage = Mines fairness broken. Settle reveals preimage atomically with commit+undelegate so it lands back on L1, not on ER.

3. **Kill switch on `vault.er_enabled`** — Owner can flip off without redeploying. Only gates `start_game_er` (the entry point). In-flight ER games continue to settle.

4. **Lazy delegate** — `/api/reveal` checks `isDelegated(gamePda)` on the first reveal call; if not, runs `delegate_game` via Turnkey (L1), then proceeds with the reveal on ER. Atomic per-game claim via Supabase `UPDATE...WHERE delegated_at IS NULL` to prevent concurrent first-reveals from double-firing.

5. **Hybrid permanent, not full migration** — Plan §5 calls for keeping the L1 + Turnkey path as fallback indefinitely. Auto-rollback triggers wired to flip routing back to L1 within 60s if ER misbehaves.

---

## Cost to actually ship (once #182 unblocks)

| Item | SOL |
|---|---|
| Buffer rent upload (refunded after upgrade) | ~6.4 SOL temporary |
| ProgramData extend (~240KB additional, permanent) | ~1.8 SOL permanent |
| Vercel env additions (zero cost) | — |
| Squads votes (member 2 cooperation) | gas only |
| **Net permanent cost to ship the binary** | **~1.8 SOL** |

These are the same numbers from the 2026-05-16 audit. The slim path we shipped today already extended ProgramData by 25KB to fit 678,832 bytes; the full Magicblock binary needs ~917,864 bytes, so another ~258KB extend would be needed at ship time. The extend math from earlier:
- Current capacity: 684,216 bytes
- Full Magicblock binary: 917,864 bytes
- Additional needed: ~233,648 bytes
- Extend rent at ~6960 lamports/byte = ~1.63 SOL permanent

Approximately. The exact figure depends on whether the binary stays the same size when we eventually rebase + re-test.

---

## Required steps to resume (when #182 has a written answer)

### Phase 0 — verify the answer

1. Read Magicblock's response on issue #182.
2. Confirm there's a documented force-undelegate path or auto-expiry. If their answer is "trust the validator network," that's NOT good enough for real-money. Escalate.
3. If acceptable, screenshot the answer + archive the issue URL in `script.txt` so future-you has the evidence.

### Phase 1 — rebase + bring spike up to date

The spike branch hasn't been touched since the slim merge. `main` has moved (slim bundle, vault config changes, timer change). Rebase the spike onto current main:

```bash
cd ~/Projects/playkaboom
git fetch origin
git checkout magicblock-bundle-2
git rebase origin/main
# Likely conflicts in: lib.rs (settle_game treasury split logic in both
# branches), update_v2_config (er_enabled in spike, removed in slim).
# Resolve by KEEPING the slim path's vault.treasury_split_bps logic AND
# re-adding the spike's er_enabled field + ix branch.
```

Expected conflict surface: ~3 files, ~50 LOC of manual reconciliation. Same conflict class as the original 2026-05-16 rebase.

### Phase 2 — re-verify external state

```bash
# Confirm SDK pin is still safe — re-check 0.13.0 vs latest
npm view @magicblock-labs/ephemeral-rollups-sdk versions --json
# Re-check open validator bugs
gh issue list --repo magicblock-labs/magicblock-validator --state open --limit 20
```

If SDK has bumped to 0.15.x or beyond AND a public Anchor 0.31.1 project has shipped on the newer SDK in production, consider re-evaluating the 0.13.0 pin.

### Phase 3 — build

```bash
cd ~/Projects/playkaboom
cargo check -p kaboom    # confirm clean
anchor build              # produces target/deploy/kaboom.so
shasum -a 256 target/deploy/kaboom.so
```

Record the sha256 in records.txt + the Squads upgrade proposal.

### Phase 4 — fund CLI wallet for upload

Send ~7 SOL from EchyZ → DbR1a1Cu (the CLI wallet at `DbR1a1CuqwjrdKU9DD6GMqghAXDypD9FLzHNvLabXpRH`). The 6.4 SOL buffer rent refunds after the upgrade lands.

### Phase 5 — upload buffer

```bash
solana program write-buffer target/deploy/kaboom.so \
  --url https://api.mainnet-beta.solana.com \
  --with-compute-unit-price 5000
# Records the Buffer: <address>

solana program set-buffer-authority <buffer-address> \
  --new-buffer-authority 464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5 \
  --url https://api.mainnet-beta.solana.com
```

### Phase 6 — Squads votes (in this order)

1. **Temp-authority transfer** (so CLI can run `extend_program`):
   - Squads → Developers → Programs → kaboom → Change Authority
   - New authority: `DbR1a1CuqwjrdKU9DD6GMqghAXDypD9FLzHNvLabXpRH`
   - Skip new-authority signer check: ✅
2. **Extend** (CLI, after temp authority lands):
   ```bash
   solana program extend 9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh 260000
   ```
   (260,000 = ~233K shortfall + ~27K slack for future small changes)
3. **Hand authority back** (CLI):
   ```bash
   solana program set-upgrade-authority \
     9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh \
     --new-upgrade-authority 464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5 \
     --skip-new-upgrade-authority-signer-check
   ```
4. **Program Upgrade** via Squads "+ Add Upgrade" UI on the kaboom program page:
   - Buffer Address: from Phase 5
   - Buffer Refund: `DbR1a1Cu…`
   - Submit, member 2 votes, executes.

### Phase 7 — Vercel env

Set `MAGICBLOCK_ENABLED` env var on Vercel production. Keep it **`false`** initially:

```
MAGICBLOCK_ENABLED=false
```

Per-region validator pubkeys (one or more, depending on which regions are needed):
```
MAGICBLOCK_VALIDATOR_AS=MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57
MAGICBLOCK_VALIDATOR_US=MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd
MAGICBLOCK_VALIDATOR_EU=MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e
```

(These are the public mainnet validators per `docs.magicblock.gg` as of 2026-05-16. Verify they haven't changed.)

### Phase 8 — Squads vote: flip `er_enabled = true`

`update_v2_config(er_enabled = true)`. Only AFTER the program upgrade and env setup land. This is what actually lets `start_game_er` execute on chain.

**Note**: the slim binary doesn't have the `er_enabled` field on VaultV2State. Once the full Magicblock binary is upgraded, the field exists but is `false` (because the underlying `_reserved` bytes are all zero from the slim-binary era). Voting to set it `true` will work.

### Phase 9 — Canary on mainnet (no devnet, per project rule)

Per `feedback_no_devnet_detours_mainnet_only.md`, V1-V9 validation runs on mainnet, NOT devnet. Plan:

1. **Per-wallet feature flag in web app**: only your test wallets see `MAGICBLOCK_ENABLED=true` initially. Everyone else stays on the L1 path.
2. **Tight bet cap on the canary flow**: enforce ≤0.01 SOL per game for ER-routed games at the web layer until variance is proven. Hard cap, not user-adjustable.
3. **Auto-rollback armed** before flip-on: monitor ER tx error rate, delegate-stuck PDAs, ER endpoint health. Per MAGICBLOCK_PLAN.md §6 thresholds.
4. **First 100 games observed in real time** by you. Don't open the gate to other wallets until ≥99% success rate and zero stranded funds.
5. **Then graduated rollout**: 5% → 25% → 50% → 100% over ~4 weeks (per the §5 plan).

If any of V1-V9 surfaces a problem at any stage, flip `er_enabled = false` via Squads (single vote, ~minutes to execute). All in-flight ER games settle normally; no new ER games start.

### Phase 10 — Decision point (per §5 of MAGICBLOCK_PLAN.md)

After 4 weeks at 100%, choose:
- **Hybrid permanent** (recommended): L1+Turnkey stays as the high-stakes path (e.g., bets above some threshold), ER handles the volume tier
- **Full migration**: retire L1 from production, keep code as break-glass for one cycle
- **Roll back**: `git revert` the merge, flip `er_enabled = false`, set `MAGICBLOCK_ENABLED=false`. Magicblock spike returns to a branch for future revisit.

---

## V1-V9 verification checklist (mainnet-adapted)

The original `MAGICBLOCK_PLAN.md §4` had a devnet-based V1-V7 list. Mainnet-only constraint adds two items and rewrites the rest as observable on a small-bet canary:

| # | Question | Mainnet evidence |
|---|---|---|
| V1 | Does `commit_frequency_ms` auto-expiry actually unlock a stuck delegated PDA? | Per Magicblock's #182 answer. If they say yes, observe one stuck case in the canary; if no, this is a launch blocker. |
| V2 | Is there a force-undelegate path the program owner can invoke? | Per #182 answer. |
| V3 | What's the worst-case wait for a stuck PDA? | Per #182 answer + canary observation. |
| V4 | Does Turnkey HSM latency dominate the ER speed-up? | Benchmark in canary: click → response p50/p95/p99. Compare against L1 baseline (~1.1s p50, ~2s p99 from the audit). |
| V5 | Payout sequencing — can settle_game_er pay the player atomically? | Verify on canary: first ER game's `settle_game_er` tx should include both undelegate + payout. |
| V6 | Indexer impact: do Supabase webhooks fire on ER state changes? | Subscribe to both; compare event timelines for canary games. The cron tickler should pick up the L1 commit-back automatically. |
| V7 | Anchor 0.31.1 + ephemeral-rollups-sdk SDK clean build? | Already verified locally on the spike branch. Re-verify at Phase 3 above. |
| V8 (NEW) | Magicblock has a written answer to force-undelegate? | This whole document is gated on this. |
| V9 (NEW) | Leak monitor for validator bug #1124 wired up? | Cron job that scans for delegated PDAs whose base game row has been closed but ER still holds the account. Alert if any found. Implement before Phase 9 canary. |

---

## Rollback path

If the canary surfaces problems:

| Severity | Action | Time to land |
|---|---|---|
| ER tx error rate spikes | `update_v2_config(er_enabled = false)` via Squads | minutes (member 2 + execute) |
| Stranded player funds | Same as above + manual `force_undelegate` per Magicblock's documented procedure | depends on #182 answer |
| Full abandonment | `git revert <merge sha>`, push, redeploy. `update_v2_config(er_enabled = false)`. | one Squads vote + one Vercel redeploy |

The pivot tag `pre-magicblock-pivot` at commit `cb4a963` on origin marks the ORIGINAL pre-Magicblock state (before today's session even started). Both `magicblock-bundle-2` (full) and `slim-bundle-2` (no ER) branched off of/onto this lineage; the slim branch is on `main`.

For complete rollback of TODAY'S work + ER, that tag is the anchor.

---

## What to watch on a passive timeline

If you'd rather not actively chase, here are the signals that say "good time to revisit":

1. **Issue #182 gets any reply** (✅ revisit immediately to grade the answer)
2. **Magicblock publishes a docs page on validator stall recovery / force-undelegate** (✅ revisit)
3. **A public real-money gaming product ships on ER** (e.g., Zeebit publishes volume + uptime numbers, or a new product launches) (🟡 reconsider risk model)
4. **Magicblock validator bug #1152 OR #1124 closes** (🟡 worth a re-read but not a green light alone)
5. **Magicnet Phase 3 (permissionless validators + slashing) launches** (✅ this is the real maturity gate; revisit seriously)
6. **SDK ships a 1.0.0 with stable APIs** (🟡 indicates production-readiness signal)
7. **Magicblock raises a Series A or announces large customers** (🟡 commercial signal; reduces "company risk" tail)

Set a calendar reminder to check #182 + Magicblock blog quarterly. If nothing changes in 6 months, the strategic question shifts from "when do we ship ER?" to "should we abandon ER entirely?"

---

## What if you abandon Magicblock entirely

If after some time you decide you don't want ER:

```bash
# Strip web dead code
git checkout main
git rm apps/web/src/server/er-instructions.ts
git rm apps/web/src/server/magicblock.ts
git rm apps/web/src/server/session-keys.ts
# Edit env.ts: remove useMagicblock(), magicblockErUrl(), magicblockErWsUrl()
# Edit commit/reveal/settle routes: remove if (useMagicblock()) branches
# Remove the dormant supabase migrations (or leave them — they're harmless)

# Delete the spike branches
git branch -D magicblock-spike magicblock-bundle-2 magicblock-spike-pre-rebase
git push origin --delete magicblock-spike magicblock-bundle-2 magicblock-spike-pre-rebase

# Close PR #3 if still open
gh pr close 3 --comment "Abandoning Magicblock spike — see docs/magicblock-handoff.md for context"
```

That clears ~2000 LOC of dormant code from `main` and removes the dead branches. Net cost of the choice: ~$300 in operator time already spent + zero on-chain cost (nothing was deployed).

The pivot tag and `MAGICBLOCK_PLAN.md` (on the deleted branch's git history) remain accessible via reflog if you ever want to look back.

---

## Quick-reference: keys + addresses

| Item | Value |
|---|---|
| Program ID (mainnet) | `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh` |
| Vault PDA | `9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK` |
| V2 State PDA | `6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb` |
| Squads multisig (owner + treasury) | `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5` |
| Squads member 2 | `EchyZCoLtfDjcpY7dWEAurmzyGqSHKGMeE2sKfpcg4MG` |
| CLI wallet (operator) | `DbR1a1CuqwjrdKU9DD6GMqghAXDypD9FLzHNvLabXpRH` |
| Magicblock validator AS | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |
| Magicblock validator US | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| Magicblock validator EU | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |

| Magicblock contact | Handle |
|---|---|
| Andy Weng (DevRel) | [@fauxfire_](https://x.com/fauxfire_) |
| Gabriele Picco (CTO) | [@PiccoGabriele](https://x.com/PiccoGabriele) |
| Andrea Fortugno (CEO) | [@supermarioblock](https://x.com/supermarioblock) |
| Company | [@magicblock](https://x.com/magicblock) |
| Edwin Paco (engineer, owns #1152) | GitHub [taco-paco](https://github.com/taco-paco) |

END OF HANDOFF.
