# F4 (MONEY-3): LP withdrawal timing — design

Status: design only. No code has been changed. Targets: `kaboom-p/src/ix/v2_lp.rs` (`complete_withdraw`,
`user_lp_checks`), `consts.rs`, `error.rs`.

## 1. The hole

`complete_withdraw` pays `pending_units * vault_assets / total_units`. Two things make that exploitable:

- **The option never expires.** Once `pending_unlock_slot` has passed, the LP can complete at any slot, for
  ever. `cancel_withdraw` has no time check either.
- **The price ignores open games.** `vault_assets` counts every open bet as house money and carries no
  liability for any open game.

An LP who can see game state therefore holds a free, perpetual put. Game state is public: the ER RPC shows
delegated VRF games, and L1 shows legacy games. The LP waits until a large payout is certain or likely, then
exits at the pre-payout NAV, and the remaining LPs absorb that LP's share of the payout. There are three ways
to know a payout is coming:

1. **A VRF game is resolved WON but not settled.** The game is WON on the ER. `settle_and_undelegate_vrf`
   commits it, it lands on L1, and then the client or cron calls `settle_vrf`, which is permissionless. That
   is several seconds, and with `settle_vrf` permissionless the LP can make it atomic:
   `[complete_withdraw, settle_vrf]`. This is the repro.
2. **A legacy game is `cash_out` WON** and waiting for the house to call `settle_game`.
3. **A game is in play at a high multiplier.** The player can cash out at `bet * mult_k` at any moment, so the
   expected liability is about `bet * mult_k`. This lasts minutes and is visible on the ER.

Repro: `difftest/tests/audit_money.rs::audit_matured_pending_withdraw_front_runs_known_vrf_win`. An LP with
2 SOL in a 52 SOL vault takes **182,826,923 lamports** (its share of a 4.752 SOL full-clear win) by ordering
`[complete_withdraw, settle_vrf]` instead of `[settle_vrf, complete_withdraw]`. The yearly scale, assuming a
10% LP and one cap-size (5 SOL) win per day: 0.1 × 5 × 365 ≈ **182 SOL a year** shifted onto the other LPs.

## 2. Options

The numbers below use the harness world: 50 SOL vault, edge 1%, max_bet 1%, max_payout 10%, min_health 10%,
cooldown C = 648,000 slots (about 3 days).

A per-game reservation (`worst_case_payout`) is far larger than the game's expected liability (about the
bet):

| Game | Reservation |
|---|---|
| 1 mine | 15.84 × bet |
| 2 mines | 118.8 × bet |
| 5 mines | 4,324 × bet. A **0.001 SOL** 5-mine game reserves **4.32 SOL**, which is 8.6% of the vault |

| | **A. Claim window + crank-callable completion** (pick) | B. Price exits net of `total_outstanding_max_payout` | C. Block `complete_withdraw` in a tx that also settles (Instructions sysvar) |
|---|---|---|---|
| Mechanism | A matured withdrawal can be completed only in `[unlock, unlock + W]`, with W = 9,000 slots (about 1 h). `complete_withdraw` no longer needs the user's signature: the funds can only go to `position.user`. The house relay completes matured withdrawals on its existing cron. | `assets_out = units * (vault_assets - outstanding) / total_units`. If the optional trailing `min_lamports_out` is absent, the call requires `outstanding == 0` (the Anchor price). | Introspect the Instructions sysvar and fail if `settle_vrf` or `settle_game` is in the same tx. |
| Closes path 1 (atomic) | bounded (see residual) | **fully** | the atomic form only |
| Closes paths 1 (non-atomic), 2, 3 | bounded | fully | **no**. The attacker sends `complete_withdraw` in its own tx during the seconds-to-minutes window. |
| Residual extraction | An attacker's capital can be "armed" for at most W/(C+W) of the time. Sybils do not help, because each wallet re-arms only once per cooldown. Worst case, keeper down: **1.37%** of today's take. Keeper up (60 s ticks, about 150 slots): about **0.03%**. Repro scale: 182 SOL/yr → about 2.5 SOL/yr worst case, about 0.05 SOL/yr typical. | about 0 (only the exiter's share of the treasury and referral cut of open games, ≤ share × 1.2% × bet) | about the same as today |
| Honest LP cost in lamports | **0.** Every completion is priced exactly as under Anchor. | `share × outstanding` at completion if the LP opts in with `min_lamports_out`. Otherwise 0, but the LP must wait for a moment when no game is open. See the table below. | 0 |
| Honest LP cost in time and UX | If the keeper is down and the LP is offline for the whole hour after unlock, the request lapses. The LP then runs `[cancel, request]` and waits one more cooldown. No funds are lost. A matured request can no longer sit open: it auto-completes. | Exit is blocked or haircut while any game is open. | none |
| New griefing | none. The price does not depend on anything a third party can inflate. | **Yes, and cheap.** One 0.001 SOL 5-mine game kept open (EV cost about 1e-5 SOL plus fees per game) blocks every no-haircut exit, or forces an 8.6% haircut. The haircut goes to the remaining LPs, so a griefer who is also an LP profits. This breaks the bounded-griefing constraint, and it gets worse if F2/F3 reservations stick. | none |
| ABI impact | Signer relaxed on one account (allowed). One error appended. One constant. | Optional trailing arg (old clients get strict mode). One error appended. | **Breaking.** Requires a new account: if mandatory, every client breaks; if optional, the attacker leaves it out. |
| Off-chain | House cron pass (about 40 lines in apps), plus a UI state for "expired". | UI quote, `min_lamports_out`, retry | n/a |
| On-chain diff | about 6 lines | about 6 lines | about 30 lines |

Honest LP haircut under B if the LP opts in to complete while games are open (52 SOL vault):

| Open reservations | 2 SOL position | 5 SOL position |
|---|---|---|
| none | 0 | 0 |
| one 0.05 SOL 1-mine game (0.79 SOL) | 0.030 SOL (1.5%) | 0.076 SOL (1.5%) |
| one game at the 10% cap (any multi-mine game; even 0.001 SOL × 5 mines) | 0.192 SOL (9.6%) | 0.481 SOL (9.6%) |
| busy, 15 SOL reserved | 0.577 SOL (28.8%) | 1.442 SOL (28.8%) |

B is the only option that fully closes the hole on chain. It does so by pricing every open game at its worst
case, and worst cases run about 100–4,000 times the bet. That cost lands on honest exiters, and the strict
mode can be blocked by anyone for almost nothing. A charges honest LPs nothing, adds no griefing surface, and
cuts the extractable value by a factor of about 73 (on-chain bound) to about 4,000 (with the keeper). C does
not close the hole.

Rejected in one line each:
- **Net only of games that are resolved but not settled.** L1 cannot see a delegated game resolve.
  `process_undelegation` carries no `v2_state`, and path 3 has no "resolved" moment at all.
- **Fixed exit fee.** It stops only wins larger than fee × vault, and honest LPs pay it on every exit.
- **Forbid cancel in the last hour before unlock.** This would remove the deferral half of A's residual. It
  is skipped because the bound already holds without it. Add it if monitoring shows request/cancel cycling
  near unlock.

**Pick: A.**

## 3. Exact spec (option A)

### 3.1 Constant (`consts.rs`, after `MIN_WITHDRAW_COOLDOWN_SLOTS`)
```rust
/// F4 (MONEY-3): a matured user LP withdrawal can be completed for this many slots after
/// `pending_unlock_slot` (about 1 h at 400 ms), then it lapses (cancel + re-request).
pub const WITHDRAW_CLAIM_WINDOW_SLOTS: u64 = 9_000;
```
This is not configurable, which is deliberate. The bound W/(C+W) assumes C ≫ W. The owner can lower
`withdraw_cooldown_slots` to 150. See §6.

### 3.2 Error (`error.rs`), appended
`WithdrawWindowExpired`, appended after `WrongVrfValidator` (6054). Its code is **6055** if F4 lands alone;
otherwise it is the next free code in the order the lead merges F1–F6. `kaboom-p/tests/abi.rs::
errors_match_idl` asserts `idl.len() == ALL.len()`. The lead relaxes that once for all appended codes: the
IDL must be a prefix, and the appended names are listed.

### 3.3 `user_lp_checks` (v2_lp.rs:186) gets a signer flag
```rust
fn user_lp_checks(vault: &AccountView, v2s: &AccountView, position: &AccountView, user: &AccountView,
                  user_signs: bool) -> ProgramResult {
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    load(position, &lp::TYPE)?;
    if user_signs {
        check_signer(user)?;
    }
    // ... unchanged: vault/v2 seeds+mut, position seeds(stored bump)/mut/user == user @6007, user mut
}
```
`request_withdraw` and `cancel_withdraw` pass `true` (unchanged, byte-identical to Anchor). `complete_withdraw`
passes `false`.

Why relaxing the signer is safe:
- Lamports leave only from vault to `user`.
- `user` is bound to the position by the PDA seeds `[LP_SEED, user]` plus `position.user == user` (6007).
- The amount is fixed by state the LP created with a signed `request_withdraw`.

A third party can only do earlier what the LP already asked for, at the same price function. A client that
still signs keeps working.

### 3.4 `complete_withdraw` (v2_lp.rs:254)
Same discriminator (`ac818d115ffdfb62`), no args (trailing bytes still ignored), same accounts
`vault(W), v2_state(W), position(W), user(W[S])`. `user` becomes optional-signer.

```rust
    user_lp_checks(vault, v2s, position, user, false)?; // F4: crank-callable
    ...
        let now = clock()?.slot;
        let unlock = rd_u64(&pd, lp::PENDING_UNLOCK_SLOT);
        require(now >= unlock, K::CooldownNotElapsed)?;
        ... // unchanged: assets_pre, assets_out, 6039, the writes, total_after
        // F4 (MONEY-3): the matured option lasts WITHDRAW_CLAIM_WINDOW_SLOTS, not for ever. Checked last so
        // every Anchor error path (6036/6037/6008/6039) keeps its code; the failing tx reverts the writes.
        require(now <= unlock.saturating_add(WITHDRAW_CLAIM_WINDOW_SLOTS), K::WithdrawWindowExpired)?;
        (units, assets_pre, assets_out, total_after, now)
```
Notes:
- The window is inclusive: `now == unlock + W` is OK, and `unlock + W + 1` fails.
- `saturating_add` keeps the `unlock = u64::MAX` case (cooldown saturated) failing with 6037 first, as today.
- A lapsed request keeps its `pending_units`. They still count in `total_pending_units`, in health, and in
  P&L, exactly as a matured-but-uncompleted request does under Anchor. Recovery is `cancel_withdraw`, which
  is user-signed and has no time check (unchanged), then `request_withdraw`. Both can go in one tx.
- Event `LpWithdrawCompleted`: layout and values are unchanged.

### 3.5 Everything else: none
- No new instructions, no state fields, no reserved bytes.
- `lp_deposit`, `request_withdraw`, `cancel_withdraw` and `close_lp_position` are unchanged.
- `house_complete_withdraw` is unchanged (owner/Squads, trusted; see §6).
- CU: one u64 read and one compare are added. The unsigned path saves the signer check.
- Docs: add an "F4 deviation" note to `spec/v2-lp.md` §6 and `v2-lp.impl.md`. It should cover the window, the
  relaxed signer, and the new error.

## 4. Tests

The new file is `difftest/tests/fix_f4.rs`. It copies the `world`, `lp_world`, `pending_world`, `req`,
`cancel`, `complete` and `pos` helpers from `v2-lp.rs`, and `settle_vrf_ix` and `vrf_reveal` from
`audit_money.rs`.

- Helper `complete_unsigned(u)`: `complete(u)` with `accounts[3].is_signer = false`, sent with
  `p.run_as(keeper, ..)`.
- After a divergent tx, read the port side with `p.port.get_account(&k)` and inspect `d.port`, as in
  design-F6. `W = 9_000`; `ERR` is the appended code.

| # | Test | Asserts | Kills mutant |
|---|---|---|---|
| T1 | `f4_window_inclusive_upper_bound`: pending_world, `unlock = pos.pending_unlock_slot`. Pair 1: warp `unlock + W`, `complete(u)`. Pair 2: warp `unlock + W + 1`, `complete(u)`. | Pair 1: `assert_ok` (still identical to Anchor; the user gets exactly 0.5 SOL as in `complete_happy_and_cooldown_boundary`). Pair 2: `d.anchor.ok()`, port code `ERR`. Port position `pending_units`/`unlock` unchanged, user and vault lamports unchanged. | no window check; `<` instead of `<=` |
| T2 | `f4_lapsed_request_restarts`: continue T1 pair 2 with `[cancel(u), req(u, units)]` in one tx, warp to the new unlock, `complete(u)` | Port OK at each step. The new port unlock is `slot + 648_000`. The user is credited `units * assets / total_units` from port state. | recovery path broken |
| T3 | `f4_keeper_completes_without_user_signature`: pending_world, warp unlock, `complete_unsigned(u)` from keeper `p.user("keeper")` | Anchor 3010; port OK. Port user +0.5 SOL exactly. The keeper loses only the fee. Port position pending 0. Print the CU. Also on the port: unsigned before unlock → 6037; unsigned at `unlock + W + 1` → `ERR`. | signer check kept |
| T4 | `f4_signer_still_required_for_request_and_cancel`: unsigned `req` / `cancel` | `assert_err(3010)` on both | relaxing the shared helper for all three |
| T5 | `f4_unsigned_cannot_redirect`: matured a; unsigned complete with `position = lp(a), user = bob`; then with `user = keeper` | `assert_err(2006)` on both | dropping the seed / `position.user` binding |
| T6 | `f4_repro_option_dies_after_window` (the audit repro, flipped): as in the audit repro, but warp `unlock + W + 1` before the winner clears the board, then `run_as(lp, [complete, settle_vrf])` | Port tx fails with `ERR`, and the whole tx reverts, so the game is still WON and unsettled. Port `[settle_vrf]` OK. Port LP position value (`units_to_assets(pending, assets, total)`) fell by `pending/total × (payout + treasury_cut)` ±1, meaning the LP bore its share. Anchor's same tx succeeds (documents the deviation). | no window check |
| T7 | `f4_keeper_completion_precedes_win`: LP requests, warp unlock, keeper `complete_unsigned` (port), then the winner plays and `settle_vrf` | The port LP is paid the pre-game NAV, and the later win cannot touch it. This is the intended steady state: the keeper empties every matured request before any game can be timed. | — |
| T8 | Existing `audit_money.rs::audit_matured_pending_withdraw_front_runs_known_vrf_win` | Unchanged and still green on both builds: it warps `unlock + 1`, inside the window. Update only its doc comment: "bounded residual: only inside the W-slot window; the keeper normally completes first (fix_f4 T6/T7)". | — |
| T9 | Existing tests that must change (nothing else in the 684-test suite does). (a) `v2-lp.rs::complete_account_attacks`: `user_lp_action_attacks` gets a `complete: bool`. For complete, the `is_signer = false` row expects Anchor 3010 and port 6037 (pending_world is not matured). (b) `v2-lp.rs::complete_user_is_vault_alias`: the fixture `position_bytes(.., 0)` uses unlock `0`, so the port fails with `ERR`; set unlock = `START_SLOT`. (c) `kaboom-p/tests/abi.rs::errors_match_idl` (§3.2). | `cd difftest && ./build.sh && cargo test -- --test-threads=2` green | — |

The corrupted-state error tests in `complete_errors` (unlock 0, expected 6039 or 6008) keep parity, because
the window check runs last.

Mutation check (on request): apply each mutant from the "Kills mutant" column to a scratch build and confirm
that the listed test fails.

## 5. Client impact

**Required for correctness: none.** The disc, args and accounts are unchanged, and the web client still signs
as `user`. Required for UX (apps/sdk, owner-side; this design does not edit them):

1. **SDK** `buildCompleteWithdraw`: add `userSigns?: boolean` (default `true`). When it is `false`, emit
   `writable(user, false)`.
2. **House crank.** Add a third pass to `apps/web/src/app/api/cron/vrf-settle/route.ts`, placed after the
   settle pass, so terminal VRF games are paid before LPs leave:
   - `getProgramAccounts(LpPosition disc, dataSize 121)`.
   - Decode `pending_units` (u128 @56) and `pending_unlock_slot` (u64 @72).
   - For `pending > 0 && unlock <= slot <= unlock + 9_000`, call `sendHouseTx` with up to 8 unsigned
     `buildCompleteWithdraw`s per tx (one complete is about 4 keys and a few thousand CU, under 200k).
   - Log any position seen after `unlock + 9_000`.
   - The cron must tick well inside the 1 h window. The memory note says the Railway tickler that drove the
     60 s cron was down before. If the crank stops, LPs lapse (time cost only).
3. **UI** `lp-panel.tsx`:
   - Ready state: "completes automatically within a minute", with a manual COMPLETE button kept.
   - New expired state (`slot > unlock + 9_000`): a RESTART WITHDRAWAL button that sends
     `[cancel, request(same units)]`.
   - Today the cancel button is hidden once `cooldownReady`. That stays, except in the expired state.
4. **Indexer:** none. A keeper completion emits the same `LpWithdrawCompleted`.

## 6. Trade-offs and residual risk

- **Honest LPs lose no lamports compared with Anchor.** Every completion uses the Anchor price. What they lose
  is the ability to keep a matured request open and pick their exit moment later. That ability is the
  exploit. A request now completes about 1 minute after unlock (keeper), or lapses after 1 h if nobody
  completes it. A lapse costs one more cooldown and nothing else.
- **Residual: the hole is bounded, not closed.** The LP chooses the request time 3 days ahead and can cancel
  before unlock. So each wallet gets one "exit now or defer" decision per cooldown, made with live game info,
  plus a choice of slot inside the window.
  - Armed capital is at most W/(C+W) of the time: 1.37% if the keeper is down, about 0.03% with the keeper.
    Sybils do not raise this.
  - Fully closing it on chain means pricing every open game at worst case (option B), which turns honest exits
    into haircuts and a cheap griefing target. We judged that a worse trade.
- **This depends on the owner config.** If the owner lowers `withdraw_cooldown_slots` toward W, the bound
  weakens (C = 150 makes W/(C+W) = 98%). Operating rule: keep C ≥ 50 × W (the default 648,000 is 72 × W, which
  gives the 1.37% bound). The F4 bound should be mentioned wherever the cooldown is configured.
- **Keeper is load-bearing for the typical-case bound only.** The on-chain bound (1.37%) holds without it.
- **Not in scope:**
  - Gross NAV still counts open bets as house money. Every exit, honest or not, is overpaid by about
    `share × Σ open bets`. That overpayment is symmetric and small.
  - `house_complete_withdraw` (owner/Squads) still exits at gross NAV at a time the owner chooses. This is
    owner-trusted, as before.
- **Interaction with other fixes:** none required.
  - A does not read `total_outstanding_max_payout`, so F2/F3 reservation behaviour cannot move LP exit
    prices.
  - Appending error codes needs the shared `errors_match_idl` relaxation (§3.2).
- **Parity:**
  - `complete_withdraw` now diverges from Anchor only for (a) a call made more than W slots after unlock (the
    port fails) and (b) an unsigned `user` (Anchor 3010, the port proceeds).
  - Every signed call inside the window is byte-identical to Anchor.
