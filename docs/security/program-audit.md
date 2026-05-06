# Program audit notes

Self-review of `programs/kaboom/src/lib.rs`. Treat this as a peer-review pass,
not a substitute for an independent audit. Last reviewed: 2026-05-07
(commit pre-deploy of obligation double-decrement fix).

## Critical-path math

### `calc_multiplier_bps` (lib.rs:1366)

Computes the hypergeometric mines multiplier in basis points:

```
mult_bps = (∏(grid - i) / ∏(safe - i)) × (BPS - house_edge_bps) / BPS
       for i ∈ [0, safe_reveals)
```

| Check | Verdict |
|---|---|
| Edge-zero: `safe_reveals == 0` returns BPS (1×) | ✓ correct, matches "no risk = no payout multiplier" |
| Bound: `mine_count + safe_reveals ≤ GRID_SIZE` | ✓ enforced via `require!` |
| Iteration: `safe_remaining = total - mines - i`, `require!(safe_remaining > 0)` | ✓ catches division-by-zero |
| Overflow: every multiply uses `checked_mul` with u128 | ✓ — at GRID_SIZE=16, max product is 16! / 4! ≈ 1.05e10, comfortably inside u128 |
| Edge factor: `(BPS - house_edge_bps)` cast to u64 | ✓ safe since house_edge_bps ≤ MAX_HOUSE_EDGE_BPS (1000) and BPS = 10_000 |
| Final cast: u128 → u64 via `try_from` | ✓ catches the (theoretical) case where mult_bps overflows u64 |

**Maximum possible multiplier** (12 mines, reveal all 4 safe tiles):
- Hypergeometric: (16/4) × (15/3) × (14/2) × (13/1) = 4 × 5 × 7 × 13 = **1820**
- After 2% edge: 1820 × 0.98 = **1783.6×**

So at the protocol cap (max 12 mines, bet 1 SOL), the worst-case payout is
~1784 SOL. The `start_game` capacity check prevents this from exceeding
`available × max_payout_bps × health_bps`.

### `calc_health_bps` (lib.rs ~2000)

```
pending_value = units_to_assets(total_pending_units, vault_assets, total_units)
obligations   = total_outstanding_max_payout + pending_value
free          = vault_assets - obligations  (saturating)
health_bps    = free × BPS / vault_assets   (clamped to [0, BPS])
```

| Check | Verdict |
|---|---|
| Empty-vault: `vault_assets_now == 0` returns 0 | ✓ correct |
| Pending value uses current NAV | ✓ — pending units are claims on assets at the current ratio |
| Saturating subtract on `free = available - obligations` | ✓ correct (clamps to 0 instead of underflowing) |
| Clamped output: `min(h, BPS)` after the division | ✓ guards against precision-driven overflow |

### `worst_case_payout` (lib.rs:1422)

```
worst_safe = GRID_SIZE - mine_count
worst_multiplier = calc_multiplier(worst_safe, mine_count, edge)
return floor(bet × worst_multiplier / BPS)
```

| Check | Verdict |
|---|---|
| Saturating sub: `GRID_SIZE.saturating_sub(mine_count)` | ✓ — gives 0 if mine_count > GRID_SIZE, which `require!` would have already rejected |
| Floor rounding via `mul_div_floor` | ✓ — vault-favorable rounding (player gets ≤ exact share) |

### `start_game` capacity gate (lib.rs:218-246)

```
available = vault_lamports - rent
pre_health = calc_health_bps(v2, available)
effective_max_bet_bps    = vault.max_bet_bps    × pre_health / BPS
effective_max_payout_bps = vault.max_payout_bps × pre_health / BPS
max_bet     = available × effective_max_bet_bps    / BPS
max_payout  = available × effective_max_payout_bps / BPS
worst_payout = worst_case_payout(bet, mine_count, edge)
require!(bet ≤ max_bet)
require!(worst_payout ≤ max_payout)
```

This is the multi-layer gate that prevents the vault from ever owing more
than it can pay. Verified mirrored exactly in
`apps/web/src/hooks/useContracts.tsx::useVaultCapacity` (added
2026-05-07) so the client never lets a player submit a bet that would
fail this check.

| Check | Verdict |
|---|---|
| `available = vault_lamports - rent`, saturating | ✓ |
| Pre-health computed from current vault, before bet's obligation is added | ✓ correct ordering — we judge whether the new obligation can fit |
| Both caps scale linearly with health | ✓ — at 0% health, both go to zero, no new bets |
| `worst_payout ≤ max_payout` is the primary safety — covers worst-case-everyone-wins | ✓ |

### `cash_out` payout (lib.rs:385)

```
payout = floor(bet × multiplier_bps / BPS)
require!(payout ≤ available)
vault.lamports -= payout
player.lamports += payout
status = Won
```

| Check | Verdict |
|---|---|
| Floor rounding | ✓ — vault-favorable |
| Direct lamport mutation (instead of system_program::transfer) | ✓ — vault is a PDA so this is the correct mechanism |
| Re-check `payout ≤ available` even though start_game also checked | ✓ defense-in-depth — between start and cash-out, other obligations could have changed available |
| ~~Decrements `total_outstanding_max_payout`~~ | **REMOVED 2026-05-07** — was a double-decrement bug (settle_game also decrements). Now only settle/refund_expired/close_unsettled_game release. |

### `settle_game` commitment verification (lib.rs:455)

```
hasher.update(mine_layout LE bytes)
hasher.update([mine_count])
hasher.update(salt)
require!(computed == game.commitment)
require!(actual_mine_count == game.mine_count)  // popcount of layout matches
require!(revealed_safe_mask & mine_layout == 0)  // revealed-safe didn't hit a mine
require!((revealed_mine_mask & mine_layout) == revealed_mine_mask)  // revealed-mine actually was a mine
```

| Check | Verdict |
|---|---|
| Hash input order: layout-bytes / count / salt | ✓ matches client commit (server's `createGameSession`) |
| popcount check prevents commitment trickery via layout with wrong mine count | ✓ |
| revealed-safe-vs-actual-mines checks: enforce that the player's reveal history is consistent with the now-revealed layout | ✓ — protects against server selectively committing different layouts |

Independent verification path: `/api/verify/<sig>` (apps/web/src/app/api/verify/[signature]/route.ts) re-derives the SHA-256 from the `GameSettled` event log and returns `{ verified: true/false, computed, commitment }`. Any third party can run the same hash and confirm.

### Referral payout (lib.rs:553)

```
cut = floor(bet × tier_bps / BPS)
actual_cut = min(cut, vault_available)
vault.lamports -= actual_cut
referral_account.lamports += actual_cut
ra.accrued += actual_cut
ra.total_earned += actual_cut
ra.referred_volume += bet           // even on loss
```

| Check | Verdict |
|---|---|
| `actual_cut = min(cut, vault_available)` saturating clamp | ✓ — never overdraws vault |
| Vault.lamports mutation pattern | ✓ — same pattern as cash_out |
| Tier bump check after credit, not before | ✓ — current bet contributes to next tier |
| Self-referral blocked at `set_referrer` | ✓ |
| `ReferrerAlreadySet` blocks double-set | ✓ — referrer is one-time per player |

## Lifecycle: which path releases obligations

After the 2026-05-07 fix, every game-end path decrements
`total_outstanding_max_payout` exactly once:

| Path | Sequence | Releases at |
|---|---|---|
| Win via cash_out | start (+) → reveal_safe* → cash_out (Won) → settle_game | settle_game |
| Win via auto-Won | start (+) → reveal_safe (last one auto-Wins) → settle_game | settle_game |
| Loss | start (+) → reveal_mine (Lost) → settle_game | settle_game |
| Server-failed Won | start (+) → cash_out (Won) → close_unsettled_game | close_unsettled_game |
| Server-failed Lost | start (+) → reveal_mine (Lost) → close_unsettled_game | close_unsettled_game |
| Player-abandoned | start (+) → … (no reveal) → refund_expired (Expired) | refund_expired |
| All paths converge to | close_game (cleanup, no obligation effect) | n/a — already released |

**Property: at any point in time, `total_outstanding_max_payout = sum of game.max_payout for all on-chain games with status ∈ {Playing, Won, Lost} AND !settled`**.

This invariant was *broken* by the old code (cash_out + settle both decremented). It's restored by the fix.

## Threats & whether we mitigate them

| Threat | Mitigation in code | Verdict |
|---|---|---|
| Server picks layout AFTER reveals | SHA-256 commitment locked at start_game, layout reveal verified at settle | ✓ |
| Server replays a settle | `game.settled` flag + `require!(!game.settled)` | ✓ |
| Player double-cash-out | `require!(status == Playing)` in cash_out, sets to Won | ✓ |
| Player cash-out without revealing | `require!(safe_reveals > 0)` | ✓ |
| Player reveals same tile twice | `require!(revealed_mask & tile_bit == 0)` | ✓ |
| Tile index out of bounds | `require!(tile_index < GRID_SIZE)` | ✓ |
| Math overflow | Every multiply uses `checked_*` or u128 | ✓ |
| Reentrancy via CPI | Solana's account-locking model + we don't make external CPIs that touch our own state | ✓ |
| Vault drained via withdraw_to_treasury | Allowlisted destinations only; max one withdraw destination changeable per ix | ✓ |
| Owner key compromise | Two-step ownership transfer; current owner is Squads multisig PDA | ✓ |
| Program upgrade compromise | (PENDING) currently single deployer key; transfer script ready | ✗ until run |

## Findings — none currently open

The obligation double-decrement was the only material bug found in this
review. Fixed in the same commit as this document.

## Out-of-scope for this self-review

A real audit should additionally cover:

- Differential testing against an independent Python/TS implementation of `calc_multiplier_bps` for every (mine_count, safe_reveals, edge) combination.
- Fuzzing the LP units math (`deposit_to_units`, `units_to_assets`) for rounding-attack vectors.
- Verifying that the Anchor account-resize semantics in `withdraw_allowlist` updates can't be used to corrupt adjacent fields.
- Stress-testing `total_outstanding_max_payout` accounting under high-concurrency game start/settle (this self-review walked the finite state machine on paper; no on-chain stress test).
- A full review of the BPF Upgradeable Loader interaction once the Squads handoff is complete — Squads vault transactions must wrap the upgrade ix correctly.
