# PlayKaboom Vault LP — design plan

Goal: turn the existing `Vault` PDA from a single-owner house bankroll into a permissionless yield vault. Anyone can deposit SOL → receive a `units` position that earns the casino's net P&L. Withdrawals queue for **3 days**, units keep earning during cooldown, **50% of every settle's house profit** boosts unit value (rest goes to Squads treasury). Owner + treasury rotate to **2-of-2 Squads**; `house_authority` already on Turnkey.

The house keeps a **minimum-share-floor** position (`min_house_share_bps`, configurable, defaults 50%) inside the same vault — invisible in user-facing UX, fully visible on-chain. The house bears the same 3-day cooldown as everyone else.

A **health factor** computed from outstanding game payouts and pending withdrawals dynamically tightens every cap (max bet, max payout, max user deposit) so the vault is always solvent enough to pay every committed obligation.

**Two program upgrades total** — Phase 1 adds two-step ownership transfer; Phase 2 adds the LP vault and health-factor machinery. Goal: never touch the program again for these features.

Status: design draft, answers locked 2026-05-06; not yet implemented.

---

## 1. Locked design choices

Vocabulary: **`units`** = each LP's claim on the vault (was "shares"; renamed for clarity since users never see this word in UX). Math is identical: `unit_value = vault_assets / total_units`.

| # | Choice | Why this and not the alternatives |
|---|---|---|
| 1 | **Floating-value `units` model** (deposit X SOL → mint `X / unit_value` units; unit_value = `vault_assets / total_units`) | Same model as Drift IF, JitoSOL, GLP, ERC-4626. P&L automatically distributed pro-rata via unit_value; no per-user accrual bookkeeping. UX hides the term — users see "deposited X SOL → current value Y SOL". |
| 2 | **Units stay live during the 3-day cooldown** — they continue to share P&L, withdraw value = unit_value at `complete_withdraw` time, not at `request_withdraw` | Matches your spec. Drift IF actually freezes earnings during cooldown — we are deliberately not doing that. Continued P&L sharing also means cooldown-LPs share losses, which closes the "queue unstake before house loses, re-deposit before house wins" exploit. |
| 3 | **One pending withdrawal per LP** (re-requesting cancels & restarts the 3-day clock). Applies to **house position too** — house also has 3-day cooldown to prevent rugs. | Drift IF rule. Avoids per-user queue, simpler PDA. |
| 4 | **Per-user `LpPosition` PDA** at `[kaboom_lp, user]` storing `units`, `pending_units`, `pending_unlock_slot`. No SPL mint in v1. | No transferability, no DEX listing, smaller audit surface. Can wrap in a mint later via a separate program. |
| 5 | **Anti-inflation seed**: protocol seeds `1 SOL` to a locked PDA at v2 init, contributes to `total_units` but cannot be withdrawn. | Standard 4626 inflation-attack mitigation. ~$200 to forfeit. |
| 6 | **House minimum share floor** (`min_house_share_bps`, default `5000` = 50%). Stored as `vault.house_units` (separate from regular `LpPosition`s). Owner can raise OR lower the floor via `update_vault`. Floor enforced as `house_units / (house_units + sum(user units + user pending_units)) ≥ min_house_share_bps / 10_000`. **Seed excluded from this denominator** — seed is a locked cushion, not part of the active LP base. | Skin-in-the-game without making house subsidize the locked seed. House and users share P&L identically; only the floor differs. |
| 7 | **House position invisible in user-facing UX** — `/api/vault/state` reports only aggregate `total_assets`, `total_units`, `unit_value`, APY. The on-chain `vault.house_units` is publicly readable by anyone querying the program (no on-chain hiding), but the official UI doesn't break it out. | Lets the protocol present "100% community-owned" framing while preserving on-chain transparency for anyone who looks. Disclose in long-form docs to avoid future surprise. |
| 8 | **Settle-time revenue split** stays as today's `treasury_split_bps` (default `5000` = 50/50). Vault's half stays in the PDA → unit_value ticks up (house and all users get pro-rata share, by virtue of being LPs). Treasury's half is `transfer`'d to `vault.treasury` on the same ix (Squads vault address). | No new "distribute" call. P&L is real-time, no claim flow. |
| 9 | **Bet caps multiplied by `health_factor`** (see §3.2). Static maxima are stored in `vault.max_bet_bps`, `vault.max_payout_bps`, `vault.max_user_position_bps`; effective caps = `static × health / 10_000`. | Self-tightening under stress, self-recovering when obligations clear. |
| 10 | **No reserve carve-out for pending withdrawals** — pending units share liquidity with active bets, but health factor accounts for them as obligations. | Health-factor approach is more accurate than a static reserve and doesn't create gaming surface. |
| 11 | **Two-step ownership transfer** (`propose_owner` → `accept_ownership`). | Industry standard (Compound, Aave). Squads multisig signs the accept, proves it can sign as owner. |
| 12 | **Pause behaviour**: `vault.paused` blocks all bet-creating + LP-deposit ixs but **not** `request_withdraw`, `cancel_withdraw`, `complete_withdraw`, `accept_ownership`. Withdrawals can never be trapped. | Owner can halt new exposure if something is wrong, never freeze users' funds. |
| 13 | Cooldown = **3 days** (~648,000 slots @ 400ms/slot; stored as `withdraw_cooldown_slots`, `update_vault`-configurable) | Per spec. Configurable so we can shorten if user feedback demands. |
| 14 | First deposit when `total_units == 0` mints `1 lamport = 1 unit` | Standard "decimals = asset decimals" convention. |
| 15 | "50% of revenue" = 50% of **net house profit per settle** (existing `treasury_split_bps`). Not 50% of gross volume. | Locked per your confirmation. |
| 16 | Anyone can deposit (permissionless). No KYC gate, no allowlist for LPs. | Matches the rest of PlayKaboom (no geo-block). |
| 17 | `min_house_share_bps` lower bound is `0` (full user-owned target state allowed). Owner can move it in either direction via `update_vault`. | Per your confirmation. |

---

## 2. Reference protocols I'm cribbing from

| Protocol | What we borrow | What we deliberately do differently |
|---|---|---|
| **Drift Insurance Fund** ([docs](https://docs.drift.trade/insurance-fund/insurance-fund-staking)) | One pending unstake per user; share token math; staker is true counterparty (eats losses) | Drift freezes earning during cooldown — **we don't**, per your spec. Drift was also drained for ~$285M in April 2026 via admin-key compromise (single authority); we're using 2-of-2 Squads + Turnkey HSM precisely to avoid that class of bug. |
| **GMX GLP** ([docs](https://gmx.io/)) | "GLP is the house" mental model — LPs are counterparty to traders; 70% of fees flow to LP | GLP pays separately in ETH/AVAX (claim-based). We compound into share price (auto-claim) — simpler UX, no extra claim tx. |
| **ERC-4626 Tokenized Vault** ([eip](https://eips.ethereum.org/EIPS/eip-4626)) | Share/asset math; convertToShares/convertToAssets pattern; inflation-attack mitigation (virtual shares OR seed) | We use a per-user PDA, not an SPL token mint, in v1. Equivalent to "shares that don't transfer." |
| **ERC-7540 Async Vault** ([eip discussion](https://ethereum-magicians.org/t/eip-7540-asynchronous-erc-4626-tokenized-vaults/16153)) | Request → Pending → Claim lifecycle; pull-based settlement (user calls `complete_withdraw`, no bot-triggered push) | Direct port — our ix names map 1:1 to ERC-7540's `requestRedeem` / `redeem`. |
| **Solana liquid staking (JitoSOL, mSOL)** | Rebasing share price; deposits/withdraws permissionless | JitoSOL has near-instant unstake via secondary liquidity pool. We don't — 3-day mandatory cooldown is the bank-run defense. |

---

## 3. New on-chain primitives (program changes)

### 3.1 Account additions

**Modify `Vault`** (existing PDA at `[kaboom_vault]`):

```rust
pub struct Vault {
    // ... existing fields preserved ...

    // Two-step ownership
    pub pending_owner: Option<Pubkey>,

    // LP accounting
    pub total_units: u128,                  // seed + house_units + sum(user units + pending)
    pub house_units: u128,                  // house's LP position; also obeys cooldown
    pub house_pending_units: u128,          // house's queued withdrawal
    pub house_pending_unlock_slot: u64,
    pub seed_position: Pubkey,              // PDA holding the locked 1-SOL anti-inflation seed
    pub seed_units: u128,                   // = first 1 SOL of total_units; never moves
    pub min_house_share_bps: u16,           // floor enforced on lp_deposit / house_withdraw
    pub max_user_position_bps: u16,         // per-user concentration cap (× health × vault)
    pub min_lp_deposit: u64,                // anti-dust floor; default 0.01 SOL
    pub withdraw_cooldown_slots: u64,       // default ~648_000 (3 days @ 400ms slots)

    // Health-factor counters (O(1) maintained)
    pub total_outstanding_max_payout: u64,  // sum of every active GameSession's max win
    pub total_pending_units: u128,          // sum of all user pending_units (not house's)
    pub min_health_bps: u16,                // floor; default 1000 = 10%
}
```

**New `LpPosition` PDA** at seeds `[kaboom_lp, user]`:

```rust
pub struct LpPosition {
    pub user: Pubkey,
    pub units: u128,                        // active, earning
    pub pending_units: u128,                // queued for withdrawal, also still earning
    pub pending_unlock_slot: u64,           // 0 if no pending request
    pub created_slot: u64,
    pub bump: u8,
}
```

`units + pending_units` is the user's total economic exposure. Both rebase identically; the split exists only to prevent re-spending pending units.

The house's position is **stored on the Vault, not in an LpPosition** — it's distinct because (a) it has the floor constraint, (b) the public API hides it, (c) it's funded/withdrawn by Squads-signed ixs distinct from regular `lp_deposit` / `request_withdraw`. Mathematically the house's `house_units` participates in `total_units` exactly like every user's units.

### 3.2 Health factor

A pure function of vault state, recomputed at the top of every ix that creates obligations. There is no "tick" on Solana; every ix that touches state implicitly updates health, and every ix that adds obligation re-checks the floor.

```
unit_value     = vault_assets / total_units                                   // SOL per unit
pending_value  = total_pending_units × unit_value                              // SOL owed to queued withdrawals
obligations    = total_outstanding_max_payout + pending_value
free_liquidity = max(0, vault_assets - obligations)
health_bps     = free_liquidity × 10_000 / vault_assets                        // 0..10_000
```

Caps multiply by `health_bps`:

```
effective_max_bet_bps      = vault.max_bet_bps      × health_bps / 10_000
effective_max_payout_bps   = vault.max_payout_bps   × health_bps / 10_000
effective_max_user_pos_bps = vault.max_user_position_bps × health_bps / 10_000
```

Solvency invariant after any obligation-creating ix:

```
post_obligations  = obligations + new_obligation_delta
require: vault_assets ≥ post_obligations                  // hard solvency
require: health_bps_after ≥ vault.min_health_bps          // configured buffer (default 1000 = 10%)
```

The two running counters that make this O(1):

| Counter | Incremented in | Decremented in |
|---|---|---|
| `total_outstanding_max_payout` | `start_game` (by `bet × max_payout_multiplier`) | `settle_game`, `cash_out`, `refund_expired` |
| `total_pending_units` | `request_withdraw` | `cancel_withdraw`, `complete_withdraw` |

Neither requires iteration. Health is always derivable from the two counters + `vault.lamports` + `total_units`.

### 3.3 New instructions

| Ix | Signer | Effect |
|---|---|---|
| `lp_deposit(amount: u64)` | user | Transfer `amount` lamports to vault PDA. Mint `units = amount × total_units / vault_assets_pre` (or `amount` if first deposit) to `LpPosition.units`. Enforce: `min_lp_deposit ≤ amount`; post-deposit `(units + pending) × unit_value ≤ effective_max_user_pos_bps × vault_assets / 10_000`; post-deposit health ≥ `min_health_bps`. Emit `LpDeposited`. |
| `request_withdraw(units: u128)` | user | Move `units` → `pending_units`. Set unlock slot. Increment `vault.total_pending_units`. Reverts if pending already non-zero. Emit `LpWithdrawRequested`. |
| `cancel_withdraw()` | user | Move all `pending_units` back. Decrement `vault.total_pending_units`. Emit `LpWithdrawCancelled`. |
| `complete_withdraw()` | user | Reverts if `now < pending_unlock_slot`. Compute `assets_out = pending_units × vault_assets / total_units` at *current* unit_value. Burn units (decrement `vault.total_units` and `vault.total_pending_units`), transfer SOL out, recheck health. Emit `LpWithdrawCompleted`. |
| `house_deposit(amount: u64)` | owner (Squads) | Transfer SOL into vault, increment `vault.house_units` by `amount × total_units / vault_assets_pre` (or `amount` if first non-seed deposit). Emit `HouseDeposited`. |
| `house_request_withdraw(units: u128)` | owner | Move `units` from `house_units` → `house_pending_units`. Set `house_pending_unlock_slot = now + withdraw_cooldown_slots`. Reverts if would breach the floor: `(house_units − units) × 10_000 < min_house_share_bps × (house_units − units + sum(user_units + user_pending_units))`. Emit `HouseWithdrawRequested`. |
| `house_cancel_withdraw()` | owner | Reverse pending. Emit `HouseWithdrawCancelled`. |
| `house_complete_withdraw()` | owner | Reverts if `now < house_pending_unlock_slot`. Re-check floor (in case state changed during cooldown — abort if would still breach). Transfer SOL out. Emit `HouseWithdrawCompleted`. |
| `propose_owner(new_owner)` | current owner | Set `vault.pending_owner`. Emit `OwnerProposed`. |
| `accept_ownership()` | proposed `new_owner` (Squads) | Set `vault.owner = pending_owner`. Clear pending. Emit `OwnerAccepted`. |
| `cancel_proposed_owner()` | current owner | Defensive — clears pending. |
| `close_lp_position()` | user | Rent reclaim once `units == 0 && pending_units == 0`. |

### 3.4 Modified instructions

- **`start_game`** — increment `vault.total_outstanding_max_payout` by `bet × max_payout_multiplier`. Recompute health. Reject if any cap exceeded after multiplying by `health_bps`. Reject if post-obligation health < `min_health_bps`.
- **`settle_game`** — decrement `vault.total_outstanding_max_payout` by the game's reserved amount. No change to the 50/50 revenue split (existing `treasury_split_bps`). Treasury's half is `transfer`'d to `vault.treasury` (Squads vault) on the same ix; vault's half is implicitly retained → unit_value ticks up. Emit `VaultUnitValueUpdated` event so indexers can compute APY without a snapshot pass.
- **`cash_out`**, **`refund_expired`** — decrement `total_outstanding_max_payout`.
- **`fund_vault`** — preserved; now also boosts unit_value for all LPs and house alike (free top-up).
- **`update_vault`** — accept `withdraw_cooldown_slots`, `min_lp_deposit`, `min_house_share_bps` (any direction), `max_user_position_bps`, `min_health_bps` in the `Option<…>` bag. Does NOT accept `new_owner` (use the two-step flow).

### 3.5 Math reference

```
vault_assets        = vault_pda.lamports − rent_minimum
total_units         = vault.total_units            // = seed + house + sum(user)
unit_value          = vault_assets / total_units   // for display; on-chain math is integer

# user lp_deposit
if total_units == 0:
    units_minted = amount                                                 // first deposit ever
else:
    units_minted = amount × total_units / vault_assets                    // floor-div, deposit-favorable

# user complete_withdraw  (executed at completion, not request)
assets_out = pending_units × vault_assets / total_units                   // floor-div, vault-favorable

# house floor check (excludes seed)
house_share_bps = house_units × 10_000 / (house_units + sum(user_units + user_pending_units))
require: house_share_bps ≥ min_house_share_bps                            // checked on lp_deposit and house_withdraw paths

# per-user concentration cap
max_position_value = max_user_position_bps × vault_assets × health_bps / 10_000²
require: (position.units + position.pending_units) × unit_value ≤ max_position_value
```

`u128` for `total_units` and arithmetic intermediates. `checked_mul` / `checked_div` on every step. Round in vault's favour on both deposit (under-mint by ≤1 unit) and withdraw (under-pay by ≤1 lamport).

### 3.6 Solvency invariants (statically checkable)

After every state-mutating ix:

1. `vault.lamports ≥ rent + total_outstanding_max_payout + total_pending_units × unit_value` — vault is always solvent for every committed obligation.
2. `house_units × 10_000 ≥ min_house_share_bps × (house_units + sum(user_units + user_pending_units))` — house meets its floor.
3. `seed_units > 0` and the `seed_position` PDA's units never decrement.
4. `total_units = seed_units + house_units + house_pending_units + sum(LpPosition.units + LpPosition.pending_units)` — units ledger balanced.
5. `vault.pending_owner ≠ vault.owner` — proposed owner must differ from current.
6. `health_bps ≥ min_health_bps` after any new obligation.
7. If `vault.paused`: only `request_withdraw`, `cancel_withdraw`, `complete_withdraw`, `house_request_withdraw`, `house_cancel_withdraw`, `house_complete_withdraw`, `accept_ownership`, `cancel_proposed_owner` are callable. All others abort.

---

## 4. Frontend / API / indexer changes

### 4.1 New API routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/vault/state` | none | Returns `total_assets`, `total_units` (combined; **does not break out house**), `unit_value`, `apy_30d`, `health_bps`, `effective_max_bet_sol`, `effective_max_payout_sol`, `effective_max_user_deposit_sol`, `community_tvl_displayed = total_assets` |
| `GET /api/vault/position/[wallet]` | none | Returns the wallet's `units`, `pending_units`, `unlock_slot`, current SOL value, deposit history, P&L since first deposit |
| `POST /api/vault/deposit` | Privy | Returns `lp_deposit` ix for client to sign. 400 if would exceed effective per-user cap or breach health floor. |
| `POST /api/vault/request-withdraw` | Privy | Returns `request_withdraw` ix |
| `POST /api/vault/cancel-withdraw` | Privy | Returns `cancel_withdraw` ix |
| `POST /api/vault/complete-withdraw` | Privy | Returns `complete_withdraw` ix |

All are read+ix-builder; no house signing. Players sign their own deposits/withdrawals — no Turnkey involvement on the LP path.

**House position is hidden in the API.** The on-chain `vault.house_units` is publicly readable by anyone querying the program directly, but neither `/api/vault/state` nor any frontend surface includes a "house: X SOL / Y%" line. This is a UX choice; on-chain transparency is unaffected. Document this honestly in the long-form site copy to avoid future surprise.

### 4.2 New frontend page: `/vault` (extension of existing)

- Top: unit_value chart, APY, displayed TVL = `total_assets`, "Vault health: 8,400 / 10,000" badge
- Effective caps shown live: "Max bet right now: 0.42 SOL", "Max payout: 1.0 SOL", "Max single position: 5.5 SOL"
- "Deposit SOL" form (with USD overlay via Pyth, like `/play`); button disabled with friendly message if cap reached
- "My position" panel: deposited (sum of historic deposits − historic withdraws), current value, P&L percent
- "Withdraw" panel: request flow, pending countdown ("unlocks in 2d 14h"), `Cancel` and (when ready) `Complete withdrawal`
- Education modal: "How does this work?" linking to docs

### 4.3 Indexer changes (Helius webhook)

New event handlers:

| Event | Effect |
|---|---|
| `LpDeposited` | upsert `lp_positions(user, units, last_action_at)`; insert `lp_actions(user, type=deposit, sol_in, units_minted, unit_value)` |
| `LpWithdrawRequested` | update `lp_positions.pending_units, pending_unlock_slot`; insert `lp_actions(type=request)` |
| `LpWithdrawCancelled` | reverse pending; insert `lp_actions(type=cancel)` |
| `LpWithdrawCompleted` | finalize position; insert `lp_actions(type=complete, sol_out, unit_value)` |
| `HouseDeposited` / `HouseWithdraw*` | record under a sentinel `lp_positions.user='__house__'` row — internal-only table, never queried by public API |
| `VaultUnitValueUpdated` | append to `vault_unit_value_history(slot, unit_value, health_bps)` |

New Supabase tables: `lp_positions`, `lp_actions`, `vault_unit_value_history`. APY = `(unit_value[now] / unit_value[now − 30d])^(365/30) − 1`.

### 4.4 Telemetry

Sentry breadcrumbs on every LP ix and on every `start_game` health-rejection. PagerDuty alert if any of these go live:

- `health_bps < min_health_bps × 0.5` (half the configured buffer) — vault under stress
- `vault_assets < total_outstanding_max_payout` — should be impossible per invariant 1; pages on-call immediately
- `house_share_bps < min_house_share_bps` — should be impossible per invariant 2
- More than N user `lp_deposit` rejections per minute due to cap — signals capacity exhausted; ops should consider lowering `min_house_share_bps` or having house deposit more

---

## 5. Risk model — what can go wrong, and what protects us

| Risk | Mitigation |
|---|---|
| **Bank run** — everyone requests withdrawal at once after a bad-luck streak | 3-day cooldown gives owner time to halt + investigate. Health-factor caps tighten automatically; new bets shrink. |
| **Insolvency** — vault committed to more in active games than it can pay | Invariant 1 forbids it. `start_game` is the only ix that creates obligation, and it rejects pre-commit if `vault_assets < post_obligations`. The `total_outstanding_max_payout` counter makes this O(1). |
| **Owner-key compromise** drains funds via `update_vault(treasury=attacker) + allowlist + withdraw` | Squads owner rotation. `propose_owner` 2-step prevents attacker from transferring ownership even if they get one Squads signature. |
| **House rugs LPs** by withdrawing all of `house_units` | Floor invariant 2 + the same 3-day cooldown on `house_request_withdraw`. House cannot reduce its position below `min_house_share_bps` of the active LP base. |
| **Inflation attack** (4626 first-depositor) — attacker mints 1 unit, donates 1M SOL, victim mints 0 units | 1-SOL anti-inflation seed at v2 init, locked in `seed_position`. Increases attack cost to ~1B SOL. |
| **Concentration** — single whale owns 90% of LP and gates the protocol's fate | `max_user_position_bps` enforces a per-wallet cap (default 10% of vault, multiplied by health). Sybil bypass possible (multiple wallets) but accidental dominance is prevented. |
| **MEV / sandwich on deposits** — bot front-runs a known winning settle | 3-day cooldown means they can't unwind quickly; per-settle profit is bounded by bet caps × house edge (≤ 2% × ~5% = 0.1% of vault per settle). Not economically meaningful. |
| **Toxic LP behaviour** — whale deposits, queues unstake immediately, rides yield free | Cooldown LPs share LOSSES too. They take real risk for the 3 days. Exit value = unit_value at claim, not at request. |
| **Math overflow** — 64-bit lamports × units | `u128` internally, cast to `u64` only at SOL transfer boundary, `checked_mul` / `checked_div` everywhere. |
| **Round-down error accumulation** | Standard 4626 trick: round in vault's favour. Accumulated dust boosts existing LPs proportionally. |
| **Pause griefing** — owner pauses to trap LP funds | Withdraw paths cannot be paused (invariant 7). |
| **Drift-style admin-key drain** (~$285M, April 2026) | Squads 2-of-2 + Turnkey HSM. Class of bug Drift had cannot exist when privileged ix signing requires two humans. |
| **Cooldown-skip via repeated deposit/cancel** | `cancel_withdraw` does NOT shorten the next request's clock. Each `request_withdraw` starts a fresh 3-day cooldown. |
| **Floor-raise causing user-deposit-DoS** — owner raises `min_house_share_bps` past current actual share | New `lp_deposit` calls reject (would push floor further off); existing positions are grandfathered. House must top up to restore deposits. Documented behaviour, not a bug. |

---

## 6. Implementation phases

Each phase ends in a green typecheck + tests + a deployable artifact. Order is chosen so each phase is independently shippable and reversible.

### Phase 0 — Squads multisig setup (you, today, ~10 min)

- Create 2-of-2 Squads vault on devnet at https://app.squads.so
- Send me the **Vault address** + the second signer's pubkey
- Fund the Squads vault with 0.01 SOL so it can sign txs without rent issues

### Phase 1 — Owner-transfer plumbing (program upgrade #1; backward-compatible)

- Add `pending_owner` field to `Vault` (zero-value default for existing vaults)
- Add `propose_owner` / `accept_ownership` / `cancel_proposed_owner` ixs
- SDK builders + decoders
- `scripts/rotate-owner.ts` (caller flow: owner runs `propose`; Squads UI runs `accept`)
- `anchor build && solana program deploy --program-id 4rPEGz... --upgrade-authority ~/.config/solana/id.json`
- `update_vault(new_treasury=<squads>) + allowlist_add(<squads>)` — done with current owner
- Run propose+accept → owner is now Squads. **All future privileged ops require 2 sigs.**

### Phase 2 — LP vault + health-factor primitives (program upgrade #2)

- Add to `Vault`: `total_units`, `house_units`, `house_pending_*`, `seed_position`, `seed_units`, `min_house_share_bps`, `max_user_position_bps`, `min_health_bps`, `min_lp_deposit`, `withdraw_cooldown_slots`, `total_outstanding_max_payout`, `total_pending_units`
- Add `LpPosition` account
- Add user ixs: `lp_deposit`, `request_withdraw`, `cancel_withdraw`, `complete_withdraw`, `close_lp_position`
- Add house ixs: `house_deposit`, `house_request_withdraw`, `house_cancel_withdraw`, `house_complete_withdraw`
- Modify `start_game` / `settle_game` / `cash_out` / `refund_expired` to maintain `total_outstanding_max_payout` and enforce health invariant
- Modify `update_vault` to accept new config knobs (`min_house_share_bps`, `max_user_position_bps`, `min_health_bps`, `withdraw_cooldown_slots`, `min_lp_deposit`)
- Emit `VaultUnitValueUpdated` on every settle
- 1-SOL seed deposit at upgrade time (Squads-signed) — pinned to `seed_position`
- House initial deposit (5+ SOL from current 5.5-SOL bankroll) → `vault.house_units`
- SDK builders + decoders + math helpers (`previewDeposit`, `previewWithdraw`, `effectiveCaps`, `healthBps`)
- Anchor flow tests covering: deposit, request, complete, cancel, P&L during cooldown, inflation-attack resistance, house floor enforcement on both `lp_deposit` and `house_request_withdraw`, health-factor cap tightening, concurrent-game obligation tracking
- `anchor build && solana program deploy ...`

### Phase 3 — Frontend + API + indexer

- New `/api/vault/*` routes (state, position, deposit, request-withdraw, cancel-withdraw, complete-withdraw)
- `/vault` page extensions: unit_value chart, APY, health badge, live effective caps, deposit form, my-position panel, withdraw flow with countdown
- Helius webhook handlers for new events
- Supabase migration: `lp_positions`, `lp_actions`, `vault_unit_value_history`
- APY computation + chart, health-factor display
- `__house__` sentinel in lp_positions for internal accounting; never returned by public API

### Phase 4 — Mainnet readiness gates (separate doc later)

- Audit (we accepted "skip before mainnet" — re-evaluate now that LP funds are at risk)
- Bug bounty bump
- Documented security model in `SECURITY.md`, including the "house position is hidden in UX but on-chain visible" disclosure
- Status page covering `/api/vault/state`

---

## 7. Open questions for you

All ⚠️ answers from previous round are now locked into §1. Remaining items needed to begin Phase 1:

1. **Squads vault address** — needed for Phase 1 (treasury rotation + ownership transfer target).
2. **Second Squads signer** — your co-signer's pubkey (so you don't get locked out if your key is lost).
3. **Anti-inflation seed source** — protocol pays the 1 SOL out of owner key (default, recommended), or fold it from the existing 5.5-SOL bankroll, or first-depositor-pays.
4. **`house_authority` tx fee source** — Turnkey wallet pays from its own SOL float (current; recommended) vs. fees come out of vault assets (slightly dilutes LPs). Today: separate float (5 SOL on devnet). Recommend keeping it that way.
5. **Min deposit** — `0.01 SOL` anti-dust default, OK?
6. **SPL token mint for units — v2 or never?** v1 uses per-user PDA. Mint adds composability (DEX listing) but bigger audit surface. Recommend NOT in v1.

When you give me #1 + #2, I'll start Phase 1.

---

## 8. Sources

- [Drift Insurance Fund Staking docs](https://docs.drift.trade/insurance-fund/insurance-fund-staking)
- [Drift admin-key compromise (Apr 2026)](https://github.com/NomosLabs-Security/poc-drift-trade-2026)
- [GMX docs](https://gmx.io/)
- [GMX GLP overview (chronicle.castlecapital.vc)](https://chronicle.castlecapital.vc/p/deciphering-gmx-v2-next-wave-decentralized-perps)
- [ERC-4626 EIP](https://eips.ethereum.org/EIPS/eip-4626)
- [ERC-7540 (async vault) EIP discussion](https://ethereum-magicians.org/t/eip-7540-asynchronous-erc-4626-tokenized-vaults/16153)
- [OpenZeppelin ERC-4626 implementation notes](https://docs.openzeppelin.com/contracts/5.x/erc4626)
