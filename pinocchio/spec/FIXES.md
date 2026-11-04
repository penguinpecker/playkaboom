# FIXES: final spec for the six audit findings (F1-F6)

Status: implemented in `kaboom-p` (see `kaboom-p/STATUS.md`), revised after the skeptic round in section 12. Target: `kaboom-p` (the Pinocchio port). Anchor (`programs/`) is the
reference and is never edited. Full reasoning per fix is in `design-F2.md`, `design-F3.md`, `design-F4.md`, `design-F6.md`; this
file is the binding merge of those four designs with the decided F1/F5 and the cross-fix review. Where this file and a design
disagree, this file wins.

## 0. Summary of decisions

| # | Finding | Fix | ABI surface | New error | New constant |
|---|---|---|---|---|---|
| F1 | initialize_vault front-run | only `DEPLOYER` may sign `initialize_vault` | none | `NotDeployer` 6055 | `DEPLOYER` |
| F2 | abandoned legacy games freeze play | new permissionless `expire_game` | +1 instruction | none | none |
| F3 | idle delegated VRF games freeze play | new house-only ER `force_undelegate_vrf`, status `VRF_VOID`, `refund_stalled_vrf` accepts VOID; `settle_and_undelegate_vrf` ends a PLAYING game the same way (section 12) | +1 instruction | none | `VRF_VOID = 3` |
| F4 | matured LP withdraw is a perpetual option | 9,000-slot claim window; `complete_withdraw` no longer needs the user's signature. Closes the open-ended option on other players' wins only; an LP that times its own win into its exit is NOT closed (section 12) | signer relaxed | `WithdrawWindowExpired` 6056 | `WITHDRAW_CLAIM_WINDOW_SLOTS = 9_000` |
| F5 | settle_vrf can skip the referrer's cut | referral account required when `player_stats.referrer` is Some | none (existing optional account becomes conditionally required) | none (reuses 6022) | none |
| F6 | admin release orphans the VrfGame | `start_game_vrf` reuses an orphan game PDA | none | none | none |

Global numbers after all six:
- Instructions: 42 (Anchor IDL) + 2 appended in this order: `ExpireGame`, then `ForceUndelegateVrf`. `INSTRUCTIONS.len() == 44`.
- Errors: 6000-6054 unchanged; appended in finding order: 6055 `NotDeployer` (F1), 6056 `WithdrawWindowExpired` (F4).
- Reserved bytes: **no fix uses any.** No account size or offset changes. No new events.
- Changed existing instructions (each in one narrow state only): `initialize_vault` (F1), `complete_withdraw` (F4),
  `settle_vrf` (F5), `refund_stalled_vrf` (F3), `settle_and_undelegate_vrf` (F3, PLAYING games only), `start_game_vrf` (F6). Discriminators, args and account order unchanged for all.

## 1. Cross-fix review (what was checked, what changed vs the designs)

Interactions checked:
- **F3 + F6 (shared VRF release path).** F3's force takes no claim and closes no claim, so F6's invariant ("only
  `admin_release_vrf_claim` closes a claim without its game") still holds. F6's reuse ignores status, so a VOID/WON/LOST orphan
  that F3 brought back is reused on the next start. F6's contract for F3 (claim-independent house undelegate, no claim close
  while L1 state is redeemable) is met by F3 as designed. A VOID game with a live claim is refunded normally (claim + game closed),
  so it never becomes an orphan.
- **F2 / F3 / F4 on `total_outstanding_max_payout` and `vault_assets`.** F4 (option A) never reads outstanding, so F2/F3 release
  timing cannot move LP exit prices. F2 and F3 each release a game's reservation exactly once (F2 refund branch in
  `expire_game`; F2 cash branch and F3 WON/LOST in the existing settle; F3 VOID in `refund_stalled_vrf`). `expire_game` and
  `force_undelegate_vrf` create new "payout is imminent" moments, but they are no wider than a player's own `cash_out` /
  `cash_out_vrf`; the F4 window bounds LP timing against all of them equally.
- **F5 + F2/F3 relay.** The VRF settle routes (`/api/vrf/settle`, `/api/cron/vrf-settle`) already pass the referral PDA. F5 is
  **not** extended to legacy `settle_game` (see section 6), so the F2 cash-branch `[expire_game, settle_game]` and
  `release-stuck-obligations` cannot be blocked by it.
- **F1 + the differential harness.** A hard-coded deployer would break every test that initializes a vault with
  `key("owner")`. The harness runs with sigverify off, so it simply uses `DEPLOYER` as the owner (section 2.3). Placing the
  deployer check after Pass C keeps every existing `initialize_vault` error row on its Anchor code.
- **Error numbering.** Only F1 and F4 add codes; F2/F3/F5/F6 reuse existing ones. `errors_match_idl` is relaxed once (section 8).
- **No fix reopens another.** F4's unsigned `complete_withdraw` only does early what the LP signed for, at the Anchor price.
  F2's `expire_game` pays only `game.player`. F3's force is house-only and EV-neutral. F6's reuse runs only after the claim
  `init` succeeded (no live claim) and only on a program-owned, VrfGame-disc'd PDA.

Simplifications vs the designs:
- **No new harness helper.** F3 proposed `Pair::run_port`. Not needed: `Pair::run`/`run_as` already run both sides; tests on new
  instructions assert `d.anchor.code() == Some(101)` and inspect `d.port`, and read state with `p.port.get_account(&k)` (or
  `p.get_both(&k).1`). After a divergence never call `p.get`/`p.read`/`p.ok` or the `Pair::start_game*` helpers (they assert
  both sides agree); build instructions and use `p.run`.
- F2's crank cadence and F3's relay timings stay off-chain (no new on-chain timeout constants).
- Everything else in the four designs is already minimal; kept as designed.

## 2. F1: initialize_vault only by the deployer

### 2.1 Program
- `consts.rs`: `pub const DEPLOYER: Address = a("qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG");`
  Why: the vault PDA is a singleton on a fresh program id; whoever initializes it first owns it for good.
- `error.rs`: append `NotDeployer` (6055) after `WrongVrfValidator`.
- `vault_admin.rs::initialize_vault`: immediately after `check_mut(owner)?;` (end of Pass C), before the `InvalidConfig` checks:
  ```rust
  require(owner.address() == &DEPLOYER, K::NotDeployer)?; // F1: AUTH-1/MONEY-4/PINO-1
  ```
  Placed last among the account checks so every Anchor error path (102, 3005, 3010, 3008, 2006, the CreateAccount failures,
  4101, 2000) keeps its code; a non-deployer tx that gets this far reverts the vault creation. Account list unchanged.

### 2.2 Tests (new `difftest/tests/fix_f1.rs`)
- `f1_stranger_cannot_initialize`: a non-deployer signs init: Anchor ok, port 6055, port vault PDA absent.
- `f1_deployer_initializes_after_failed_frontrun`: stranger init (port 6055), then deployer init: port ok, port vault owner ==
  `DEPLOYER`; the attacker's later `allowlist_add` / `withdraw_to_treasury` fail on the port.
- `f1_deployer_not_signer_3010`: deployer key unsigned gives 3010 on both (signer check still first).
- Host: `kaboom-p/tests/abi.rs::pdas_and_ids` asserts `DEPLOYER` decodes to the base58 above.

### 2.3 Harness and existing tests
- Mechanical (not a deviation): add `pub const DEPLOYER` to `difftest/src/lib.rs` and `Pair::deployer(&mut self) -> Address`
  (funds `DEPLOYER` with 100 SOL, returns it). `Pair::init_vault` uses `owner: self.deployer()`. Replace the 11
  `p.user("owner")` call sites in `tests/*.rs` with `p.deployer()`. `referral.rs:1243` (`key("owner")`, expects 3012) is unaffected.
- **Intended deviations (flip to "Anchor ok / port 6055", then deployer init ok on the port):**
  `audit_auth.rs::auth_initialize_vault_frontrun_finding`, `audit_pinocchio.rs::audit_init_vault_frontrun_inherited`,
  `audit_money.rs::audit_initialize_vault_front_run_on_fresh_id`.
- `vault-admin.rs::initialize_vault_account_attacks` rows with a different owner (`poor`, `dataful`, owner = vault) still fail at
  `CreateAccount` before the new check, so they stay `assert_same`.

### 2.4 Owner actions
- The mainnet `initialize_vault` must be signed by `qouUo...9WG` as `owner` (fee payer may be anything). Ownership then moves to
  Squads through `propose_owner` / `accept_ownership` as planned.

## 3. F2: `expire_game` (permissionless exit for expired legacy games)

### 3.1 Program (verbatim from design-F2 section 3.1)
- New instruction `expire_game`, disc `[0xd0,0x15,0x57,0x83,0xf2,0x2b,0xfc,0x90]` (= sha256("global:expire_game")[..8], checked),
  log `Instruction: ExpireGame`, no args, accounts `vault(W), v2_state(W), game(W), player(W, not signer)`; < 4 accounts: 3005.
- Checks: `load` Vault, VaultV2State, GameSession; `check_vault_v2_mut`; `check_game_owned(game, player)` (2006/2000/6007);
  `check_mut(player)`.
- Handler: `status == Playing` (6003); `clock.slot > start_slot + GAME_EXPIRY_SLOTS` (6014); `available = vault_assets`.
  - Refund branch if `safe_reveals == 0 || multiplier_bps < BPS`: `bet <= available` (6006, never partial), move `bet` to
    player, status Expired, `release_outstanding(max_payout)`, emit `GameRefunded{refund: bet}`.
  - Else cash branch (ties land here): `payout = bet*mult/BPS` floor, `payout <= available` (6006), move to player, status Won,
    `vault.total_payouts += payout`, emit `GameWon`. **Do not release here**; `settle_game` releases (no double decrement).
  - Game PDA not closed (rent stays for the player's `close_game` / `close_unsettled_game`). Paused flag not checked.
- `ix/mod.rs`: append `(EXPIRE_GAME, [0xd0,0x15,0x57,0x83,0xf2,0x2b,0xfc,0x90], "ExpireGame", legacy_game::expire_game)`.
- `refund_expired`, `cash_out`, `close_unsettled_game`, `settle_game`: unchanged byte for byte.

### 3.2 Tests (new `difftest/tests/fix_f2.rs`)
As design-F2 section 4: `f2_garbage_games_cleared_by_stranger` (the repro, flipped: outstanding back to 0 and an honest
`start_game` succeeds), `f2_expiry_boundary` (+300 gives 6014, +301 ok), `f2_zero_reveals_refund_branch`,
`f2_cash_branch_pays_cash_value_then_house_settles` (`[expire_game, settle_game]` in one house tx, released once, < 200k CU),
`f2_mult_below_one_takes_refund_branch`, `f2_no_partial_refund_6006`, `f2_cash_branch_vault_short_6006`, `f2_wrong_player_6007`,
the account mirrors (2000, 2006, 3002, 3005), `f2_not_playing_6003` (second expire pays nothing), `f2_signed_paths_untouched`,
`f2_batch_crank_cu` (10 per tx under 200k CU and 1232 bytes).

Existing tests: **none change expectation.** `audit_money.rs::audit_legacy_abandoned_games_strand_reservation_and_freeze_play`
keeps recording Anchor behaviour for the existing instructions; add a doc line pointing to `fix_f2.rs`.

### 3.3 Honest-player trade-off
None in value: after expiry `reveal_tile` is closed, so the player's only exits are `cash_out` / `refund_expired`, and
`expire_game` pays the larger. Edge cases: no partial refund via the crank (the signed `refund_expired` still pays it); the
refund branch pays no referral cut (same as the player's own refund); LPs lose the windfall of abandoned bets and wins.

## 4. F3: `force_undelegate_vrf` + `VRF_VOID`

### 4.1 Program (verbatim from design-F3 sections 4.1-4.3)
- `consts.rs`: `pub const VRF_VOID: u8 = 3;` Why: a zero-progress game closed for inactivity must be refundable but never
  re-delegable, revealable, cash-outable or settleable, so the attacker cannot re-delegate between undelegation and refund.
- New instruction `force_undelegate_vrf`, disc `[0xda,0x30,0xa3,0xda,0x54,0xf8,0xe4,0x65]` (checked), log
  `Instruction: ForceUndelegateVrf`, no args, accounts `[house WS, game W, magic_program, magic_context W, vault]`; < 5: 3005.
- Check order: `check_signer(house)` 3010; `load(game, VrfGame)` (on L1 the game is DLP-owned: 3007, which keeps it ER-only);
  `check_program(magic_program)` 3008; `load(vault, Vault)`; `check_mut(house)`; `check_game_seeds(game)` 2006; `check_mut(game)`;
  `check_mut(magic_context)`; `check_address(magic_context, MAGIC_CONTEXT_ID)` 2012; `check_vault_seeds(vault)` 2006;
  `house == vault.house_authority` 6007.
- Handler: if `status == VRF_PLAYING` then require `pending == 0` (6044) and set `status = if safe_reveals > 0 { VRF_WON } else
  { VRF_VOID }`; other statuses unchanged. Then `schedule_undelegate(house, magic_context, game, magic_program)`.
- Extract `schedule_undelegate` from the last lines of `settle_and_undelegate_vrf` (same metas `[payer WS, ctx W, game W]`, same
  `SCHEDULE_CAU_GAME`); `settle_and_undelegate_vrf`'s CPI bytes must not change.
- `refund_stalled_vrf` (vrf.rs, the status line): `require(d[vg::STATUS] == VRF_PLAYING || d[vg::STATUS] == VRF_VOID,
  K::GameAlreadyResolved)?;`. Nothing else; the house branch's `safe == 0 && pending == 0` holds for VOID by construction.
- Relied on, unchanged: `delegate_vrf` rejects VOID (6050), `cash_out_vrf`/`reveal_request_vrf` (6003), `settle_vrf` replay
  (6003), `reveal_callback_vrf` needs `pending != 0` (6045), so a stale callback cannot touch a forced game.
- `ix/mod.rs`: append after `EXPIRE_GAME`.
- `settle_and_undelegate_vrf` (section 12, round-2 fix): before the CPI it runs the same mapping as the force
  (`end_playing`, shared): PLAYING + pending gives 6044; PLAYING with progress becomes WON; PLAYING without
  progress becomes VOID; terminal states unchanged. CPI bytes unchanged.
- If force ever ran on a program-owned, never-delegated game on L1 (it cannot, the magic CPI fails outside the ER), the result
  would equal the house refund branch that already exists; no risk.

### 4.2 Tests (new `difftest/tests/fix_f3.rs`)
As design-F3 section 7, using `p.run` + `p.port.get_account` (no `run_port`): zero-progress VOID then refund (bet + rents back,
outstanding 0; delegate 6050, cash-out/settle 6003); progress gives WON at `calc_multiplier` and the payout equals a cash-out
control world; LOST and full-clear unchanged then booked; pending 6044 then ok after callback; auth/account errors (6007 for
stranger/player/session, 3010, 2000, 2012, 3008, 2006 fake vault and fake game, 3002, 3007 DLP-owned, 3005, house_authority
rotation); force twice idempotent; player refunds own VOID; `f3_mb1_cleared` (the repro, flipped); CU < 200k and within +3k of
`settle_and_undelegate_vrf`. Add `f3_refund_void_status_diverges`: patch status 3 on both sides, Anchor 6050, port ok.

Existing tests: **none change expectation** (no existing test refunds status 3). `sau_*` `assert_cpi_same` proves the helper
extraction. `mb1_*` / `mb2_*` keep asserting inherited behaviour of existing instructions; add a pointer to `fix_f3.rs`.

Owner-run mainnet check before announcing (min bet, cannot be shown in LiteSVM): the ER accepts the 5-account tx and serves the
vault clone, the house key pays ER fees, the commit carries the status written in the same instruction, the VOID refund lands.

### 4.3 Honest-player trade-off (explicit)
- An idle player with progress (no tap for 5 min, or game older than 30 min) is cashed out at the current multiplier. This is
  EV-neutral (`calc_multiplier` applies the edge once, so continuing has EV = current multiplier, < 1 bps rounding). **The
  player loses the option to keep playing (variance), not value.** A forced result is never LOST; a pending reveal blocks it.
- Idle with zero reveals: VOID and full bet + rents back (faster than Anchor's 24 h sweep).
- Self-undelegate (round 2): a player who undelegates a PLAYING game is cashed out (progress, WON at the current
  multiplier, EV-neutral) or gets a VOID refund (no progress). Lost vs Anchor: pausing a game on L1 and
  re-delegating it later (the web client never does this: it undelegates only terminal, just-cashed-out or
  zero-progress games, then settles or refunds). A pending reveal blocks the self-undelegate (6044): if the
  oracle is down, the game waits on the ER for the oracle or, if the oracle never answers, the 24 h admin release.
- New trust: the house key can end any delegated game at any time. It gains nothing (EV-neutral, no information edge).
- Runbook change: while the ER is up, the owner should not use `admin_release_vrf_claim` on a delegated game; the house forces it
  and the normal settle/refund closes claim and game together. Admin release stays the fallback for a dead validator.

## 5. F4: 9,000-slot claim window, crank-callable `complete_withdraw`

### 5.1 Program (verbatim from design-F4 section 3)
- `consts.rs` (after `MIN_WITHDRAW_COOLDOWN_SLOTS`): `pub const WITHDRAW_CLAIM_WINDOW_SLOTS: u64 = 9_000;`
  Why: about 1 h at 400 ms. It ends the open-ended option of waiting for some other player's big win. It does
  **not** bound an LP that schedules its own win into its exit (section 12, F4-0); the `W/(C+W)` = 1.37% /
  0.03% numbers in design-F4 assume wins independent of the LP and are withdrawn. Not configurable on purpose.
- `error.rs`: append `WithdrawWindowExpired` (6056) after `NotDeployer`.
- `v2_lp.rs::user_lp_checks` gets `user_signs: bool`; `check_signer(user)` runs only if true. `request_withdraw` and
  `cancel_withdraw` pass `true` (unchanged); `complete_withdraw` passes `false`. Every other check is unchanged (vault/v2
  seeds and mut, position seeds with stored bump, mut, `position.user == user` 6007, user mut), so funds can only reach
  `position.user`.
- `complete_withdraw`: read `unlock` once, keep `require(now >= unlock, CooldownNotElapsed)`; as the **last** check of the block,
  before the lamport move: `require(now <= unlock.saturating_add(WITHDRAW_CLAIM_WINDOW_SLOTS), K::WithdrawWindowExpired)?;`
  (inclusive; checked last so 6036/6037/6008/6039 keep their codes; the failing tx reverts the writes). A lapsed request keeps
  its pending units; recovery is the existing signed `[cancel_withdraw, request_withdraw]` in one tx.
- Unchanged: event, `lp_deposit`, `close_lp_position`, `house_complete_withdraw` (owner-trusted).

### 5.2 Tests (new `difftest/tests/fix_f4.rs`)
As design-F4 section 4 with `ERR = 6056`: T1 inclusive bound (unlock+W identical to Anchor; unlock+W+1 Anchor ok, port 6056,
state unchanged), T2 lapsed request restarts, T3 keeper completes unsigned (Anchor 3010, port pays exactly the Anchor amount;
unsigned before unlock 6037, after window 6056), T4 unsigned request/cancel still 3010 on both, T5 unsigned cannot redirect
(2006 on both), T6 the repro flipped (`[complete, settle_vrf]` at unlock+W+1 reverts on the port; LP bears its share), T7
keeper completion precedes a win.

**Intended deviations in existing tests:**
- `v2-lp.rs::user_lp_action_attacks` gains a `complete: bool` flag; for `complete_account_attacks` the `is_signer = false` row
  becomes Anchor 3010 / port 6037. `request_withdraw` / `cancel_withdraw` callers keep 3010 on both.
- `v2-lp.rs::complete_user_is_vault_alias`: fixture unlock `0` becomes `START_SLOT` (otherwise the port hits 6056; parity kept).
- `audit_money.rs::audit_matured_pending_withdraw_front_runs_known_vrf_win` stays green on both (warps unlock+1, inside the
  window); only its doc comment changes to "bounded residual, see fix_f4 T6/T7".
- Any other suite failure with code 6056 is a bug unless that test completes more than 9,000 slots after unlock.

### 5.3 Trade-off
LPs lose 0 lamports vs Anchor (every completion uses the Anchor price). They lose the ability to keep a matured request open and
pick the exit moment (that is the exploit), and a keeper may complete a matured request before the LP changes its mind (the LP
still gets exactly what it asked for). Lapse costs one more cooldown, no funds. **Owner rule: keep `withdraw_cooldown_slots >=
450,000` (50 x W)**; at the minimum 150 the bound is 98%.

## 6. F5: referral account required in `settle_vrf`

### 6.1 Program
`vrf.rs::settle_vrf`, the referral branch becomes:
```rust
if let Some(referrer) = update_stats(stats, bet, payout, lost, mult, now)? {
    // F5 (AUTH-2): a referred game cannot be settled without the referrer's PDA.
    let referral = rem.first_mut().ok_or(ProgramError::from(K::ReferralMismatch))?;
    pay_referral(vault, referral, &referrer, bet, &rent)?;
}
```
Same accounts, args and disc. A wrong account already fails 6022 / 3012 / 3007 / 3002 in `pay_referral`; now a missing one fails
6022 too. Liveness is safe: `set_referrer` always creates the referral PDA (`init_if_needed`) and nothing closes it, and on a
fresh program id its `referrer` field is always written, so a correct settle always exists and anyone can send it.

**Legacy `settle_game`: not changed (decision).** It is house-gated (`house == vault.house_authority`), so no third party can
skip the cut; the house is trusted to pass the account. Requiring it would let an app bug block `settle_game`, which is the
only release path for F2's cash branch, and `release-stuck-obligations` currently omits it. That route is fixed in the app
instead (section 9).

### 6.2 Tests (new `difftest/tests/fix_f5.rs`)
- `f5_referred_settle_without_referral_6022`: Anchor ok, port 6022, port claim/game/vault unchanged; then the same settle with the
  referral PDA succeeds on the port and the referrer accrues the cut.
- `f5_referred_loss_requires_referral`: as above for a LOST game.
- `f5_unreferred_settle_unchanged`: no referrer, no remaining account: identical on both.
- `f5_legacy_settle_game_still_optional`: referred legacy game settled by the house without the account: identical on both.

**Intended deviations in existing tests:** `vrf.rs::sv_referral_loss_and_missing_remaining` (second half: port 6022) and
`audit_auth.rs::auth_settle_vrf_skip_referral_finding` (the "skipped" run now fails on the port; assert that instead of
`accrued == 0`).

## 7. F6: `start_game_vrf` reuses an orphan game

### 7.1 Program (verbatim from design-F6 section 3.1)
Replace the game `init_pda` line in `start_game_vrf` Pass B with
`match reuse_orphan_game(game, &pk)? { Some(b) => b, None => init_pda(...)? }` and add:
```rust
#[inline(never)]
fn reuse_orphan_game(game: &AccountView, pk: &[u8; 32]) -> Result<Option<u8>, ProgramError> {
    if !game.owned_by(&ID) || game.try_borrow()?.get(..8) != Some(&vg::DISC[..]) {
        return Ok(None);
    }
    let bump = check_pda_find(game, &[VRF_GAME_SEED, pk])?; // 2006, before any write
    check_mut(game)?; // 2000
    game.try_borrow_mut()?.fill(0);
    Ok(Some(bump))
}
```
The claim `init` stays first (proves no live claim). Reuse ignores status, so VOID/WON/LOST/PLAYING orphans all heal. Old game
rent carries into the new game and returns when it closes.

### 7.2 Tests (new `difftest/tests/fix_f6.rs`)
T1-T5 of design-F6 section 4 (reuse after release, wiped after ER return incl. `[start, delegate]` in one tx, still-delegated
orphan not reused, cannot take another wallet's orphan 2006, read-only game 2000). Add `f6_reuses_void_orphan_from_f3`: start,
delegate, warp past `ABANDON_SLOTS`, admin release while delegated, house force (VOID), undelegate, then start ok on the port.
T6 existing tests stay `assert_same`: `audit_refund_then_restart_same_tx`, `audit_zero_closed_game_recredited_same_tx`,
`sgv_second_start_fails`, `sgv_init_pda_owned_elsewhere`, `sgv_wrong_pdas`, `sgv_prefunded_claim_game_stats`.

**Intended deviation:** `audit_magicblock.rs::mb6_admin_release_orphans_game_and_locks_wallet`, final start: Anchor fails, port ok.

Trade-off: a released game's last L1 result is overwritten on restart (money already settled by the release). Residual: a
still-delegated orphan stays locked until the house forces it (F3) or, if the ER is dead, as under Anchor.

## 8. Host ABI test (`kaboom-p/tests/abi.rs`), once for all fixes
- `instructions_match_idl`: keep `list.len() == 42`; `ix::INSTRUCTIONS.len() == 44`; the last two entries are
  `("ExpireGame", sha8("global:expire_game"))` and `("ForceUndelegateVrf", sha8("global:force_undelegate_vrf"))` and both route.
- `errors_match_idl`: IDL errors are a prefix of `KaboomError::ALL` (codes and names as today), and
  `NAMES[55..] == ["NotDeployer", "WithdrawWindowExpired"]` with codes 6055, 6056.
- Update the "42 instructions" doc comment in `ix/mod.rs`.

## 9. Owner / relay / app changes (apps/web, packages; list only, not edited here)
1. **Deploy:** sign `initialize_vault` with the deployer key `qouUo...9WG` (F1).
2. **SDK** (`packages/sdk`): `buildExpireGame` (F2), `buildForceUndelegateVrf` (F3), `VrfStatus` gains `"Void"` = 3 (F3; today
   index 3 falls back to "Playing"), `buildCompleteWithdraw({userSigns?})` (F4), error names 6055/6056, IDL additions for the
   two new instructions.
3. **One house cron** (house key as fee payer; cadence 60 s preferred, must stay well under 1 h for F4), passes in this order:
   - a. existing VRF settle pass (already passes the referral PDA; F5 makes that mandatory).
   - b. F3 force pass on the **ER**: claims whose game is DLP-owned; force when WON/LOST/VOID and claim >= 150 slots old, or
     PLAYING, not pending, and 300 s since last ER activity or claim >= 4,500 slots old. Needs a server ER `Connection` and
     house signing of ER txs.
   - c. F3 refund pass: program-owned VrfGame with raw status 3 gets `refund_stalled_vrf` signed by the house immediately.
   - d. F2 legacy pass: `getProgramAccounts(dataSize 180, memcmp @41 = 0)`, keep `slot > start_slot + 300`; refund branch
     (`safe@87 == 0 || mult@88 < 10000`) sends `expire_game` x10 per tx; cash branch sends `[expire_game, settle_game(layout,
     salt, referrer)]` and deletes the session row only after confirmation.
   - e. `release-stuck-obligations` on the same schedule, **fixed to pass the referrer** (today it skips the cut).
   - c'. (round 2) also refund, house-signed, a program-owned VrfGame with raw status 0, `safe@77 == 0`, `pending@79 == 0`
     whose claim is >= 150 slots old: a game started and never delegated (the existing house refund branch; Anchor too).
     After the round-2 fix this is the only PLAYING state a game can have on L1.
   - f. F4 LP pass: LpPosition (`dataSize 121`), `pending@56 > 0` and `unlock@72 <= slot <= unlock + 9,000`: **one unsigned
     `complete_withdraw` per tx** (or simulate a batch and drop failing instructions before sending). Never batch blindly:
     a completion paying less than the 0-byte rent minimum (890,880 lamports) into a 0-lamport wallet fails the runtime
     rent check and would sink every completion batched with it for the whole window (section 12, F4-1). Skip such
     positions up front; log positions seen after the window.
4. **F5 relay hardening:** `fetchPlayerReferrer` swallows RPC errors and caches `null` for 60 s; under F5 that makes a referred
   settle fail 6022 until the cache expires. On a 6022 from `settle_vrf`, bust the cache and retry; do not cache errors as "no
   referrer".
5. **UI:** `use-vrf-game` / `GameRecoveryBanner`: `Void` is terminal ("closed for inactivity, bet refunded"); a session-key reveal
   after a force fails 6003, so re-read the game. `lp-panel.tsx`: "completes automatically" in the ready state, and an expired
   state (`slot > unlock + 9,000`) with RESTART WITHDRAWAL = `[cancel, request(same units)]`. Optional (F6): in the start catch
   path require the claim to exist before treating a DLP-owned game as started; in the cron skip VrfGames with no claim.
6. **Config rules:** keep `withdraw_cooldown_slots >= 450,000` (F4). Lower `vrf_max_payout_bps` / `max_payout_bps` reduce the
   cost-free cycling below.

## 10. Residual risk needing an owner decision (not fixed here)
- **Rolling re-creation (legacy) and cycling (VRF).** Each abandoned game is now cleared automatically (legacy at about
  +301 slots plus one cron tick; VRF in about 15-20 min), but a bot that keeps restarting dust games can hold health near the
  floor for as long as it runs, paying only tx fees (about 0.3 SOL/day for ~45 wallets). This exists in Anchor without the
  bugs (through self-refund) and meets the "short and auto-cleared" bar only per game, not continuously. The only real-cost
  levers are reservation pricing: a non-refundable fee on zero-reveal refunds (changes `refund_expired` /
  `refund_stalled_vrf` and charges honest abandoners), a shorter expiry for zero-reveal games, or a lower per-game cap. Owner
  picks one or accepts the residual.
- F3 depends on the pinned ER validator being up; the fallback is today's 24 h admin release.
- F2 cash branch releases only when the house settles; a lost preimage leaves it to the player's `close_unsettled_game`.
- F4 is not closed for an LP that also plays (section 12, F4-0): it can time its own win just before its known unlock,
  hold the WON game unsettled for a few slots and exit at the pre-payout NAV, taking `s x P` (its LP share times its own
  payout) from the other LPs, every cooldown. Measured: 0.183 SOL on a 2 SOL position with one cleared 1-mine board.
  No fix fits the binding constraints: the WON state lives on the ER, which `complete_withdraw` cannot see, and the
  only on-chain-safe price (`vault_assets - total_outstanding_max_payout`) takes up to `s x outstanding` from every
  honest exit. Owner options: (a) accept, and lower `max_user_position_bps` (bounds `s`) and `vrf_max_payout_bps`
  (bounds `P`); (b) a new design: exit at the conservative price with the held-back part paid by a second completion
  after open games settle (new instruction + LpPosition reserved bytes); (c) house-sequenced completion: an optional
  trailing house signer may complete at unlock after the relay has forced and settled every WON game, the LP's own
  completion opens only K slots later (changes the honest LP experience).

## 11. Implementation order and verification
1. F1 (+ harness `DEPLOYER`), 2. F5, 3. F6, 4. F4, 5. F2, 6. F3 (helper extraction last, guarded by `sau_*`).
After each step: `export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"`,
`/Users/pp/Projects/playkaboom/pinocchio/difftest/build.sh`, then from inside `difftest`: `cargo test -- --test-threads=2`
(foreground, one cargo process), and `cargo test` in `kaboom-p` for the ABI test. Done = all existing tests green except the
intended deviations listed in sections 2.3, 5.2, 6.2, 7.2 (each rewritten to assert the new port behaviour), plus all new
`fix_f*.rs` tests green. Add "F-fix deviation" notes to `spec/vault-admin.md`, `legacy-game.md`, `vrf.md`, `v2-lp.md` and their
`.impl.md` files.

## 12. Skeptic round 2 (2026-11-04): verdicts

| id | claim | verdict | action |
|---|---|---|---|
| F3-0 | `[reveal_request_vrf, settle_and_undelegate_vrf]` in one ER tx brings the game to L1 PLAYING + pending, out of every crank's reach until the 24 h admin release | **confirmed** (inherited; `settle_and_undelegate_vrf` had no status/pending check) | fixed: `settle_and_undelegate_vrf` runs `end_playing` (pending gives 6044, the tx reverts, the game stays on the ER for the force crank). The reversed order `[settle_and_undelegate_vrf, reveal_request_vrf]` fails 6003 because the game is VOID first, so the fix does not depend on how the ER treats writes after a scheduled undelegate. `challenge_F3_0.rs` now asserts this (23 attackers, all cleared on the port, honest start succeeds) |
| F3-1 | same, plus: one safe reveal then a self-undelegate leaves `safe > 0` PLAYING on L1 (no house path) | **confirmed** | fixed by the same change: progress is committed WON, so the permissionless settle pays `bet x mult(k)` and releases the reservation; the free full-bet refund is gone. `challenge_F3_1.rs` asserts both variants. A game can still be PLAYING on L1 only if it was never delegated (zero progress, no pending: reveals need the ER oracle queue, which is DLP-owned on L1, read 2026-11-04), which the existing house refund branch clears; relay pass 9.3.c' added |
| F4-0 | an LP that also plays schedules its own win just before its unlock and exits at unlock + 0 at the pre-payout NAV; the window never bites, the keeper pays the same price | **confirmed** (inherited) | **not fixed on-chain** (no option within the binding constraints, see section 10); the 1.37% / 0.03% bound is withdrawn in sections 0, 5.1 and 10. `challenge_F4_0.rs` stays as a passing record of the residual (identical on both programs) |
| F4-1 | a 0-lamport wallet with a dust request poisons a batched keeper tx for the whole window, lapsing honest batch-mates | **confirmed** (runtime rent rule; on-chain code sound) | fixed in the keeper spec: one completion per tx or simulate-and-drop (9.3.f). No program change. `challenge_F4_1.rs` shows the batched failure and that the single-completion tx succeeds |

Tests changed by the round-2 F3 fix (`INTENDED: F3`): `vrf.rs::sau_happy` (PLAYING undelegate: Anchor commits PLAYING, port
VOID, CPI identical), `life_two_games_streak_and_refund_after_undelegate` (port VOID, house refund pays on both, sides
re-converge), `life_redelegate_after_undelegate` (port WON, re-delegate 6050, settle pays the cash-out), `fix_f3.rs::f3_force_cu` (its
setup undelegates a PLAYING game).
