# F2 (MONEY-1): abandoned legacy games strand the reservation and freeze play. Design

Status: design only. No code has been changed. Target: `pinocchio/kaboom-p/src/ix/legacy_game.rs` and `ix/mod.rs`, plus `kaboom-p/tests/abi.rs` and a new `difftest/tests/fix_f2.rs`.

## 1. The hole

`start_game` adds `worst_case_payout` to `v2.total_outstanding_max_payout`. Only three instructions ever release it:

| Release path | Who can call it | Why a griefer's game never reaches it |
|---|---|---|
| `settle_game` | house | It needs the commitment preimage. A garbage commitment has none (6015), and the game must be Won or Lost (6003). |
| `refund_expired` | **player signature** | The griefer never signs it. |
| `close_unsettled_game` | **player signature** | It needs Won or Lost status, and only house `reveal_tile` (or `cash_out`, which needs a house reveal first) ever leaves Playing. |

`reveal_tile` is closed after `start_slot + 300` (6013). So an abandoned Playing game holds its reservation forever. Repro: `difftest/tests/audit_money.rs::audit_legacy_abandoned_games_strand_reservation_and_freeze_play`. Measured on 2026-11-04: 45 garbage games cost 0.19 SOL (bets plus rent, all of it recoverable by the griefer), reserved 45.04 SOL of a 50.05 SOL vault, and honest `start_game` then failed with 6034.

Facts the design relies on, all checked in the source:
- After `slot > start_slot + GAME_EXPIRY_SLOTS` a Playing game has exactly two exits, both owned by the player: `cash_out` (needs `safe_reveals > 0`, pays `bet*mult/BPS`, and has no expiry check, a parity quirk) and `refund_expired` (pays `min(bet, vault_assets)`). No more reveals are possible. Which exit is better is therefore fully decided by on-chain state.
- `multiplier_bps < BPS` with `safe_reveals > 0` happens only for 1 mine with 1 safe reveal when `house_edge_bps > 625` (`16/15 * (1 - edge)`; MAX_HOUSE_EDGE_BPS is 1000). In every other case the cash-out value is at least the bet.
- The web relay reveals only for sessions whose commitment matches the chain (`apps/web/src/app/api/reveal/route.ts:102`). So any game with `safe_reveals > 0` has its preimage in `game_sessions`, and the house can always `settle_game` it.

## 2. Options

| | A. Drop the signer requirement on `refund_expired` and `cash_out` after expiry | **B. New permissionless `expire_game`** | C. Like B, but only the house can call it |
|---|---|---|---|
| Change | In both handlers, `check_signer(player)` becomes "signed, or the game is expired and this exit is the player's best one". | One new instruction with the same 4 accounts as `refund_expired` and no signer. It pays the better of the two exits. | B plus `vault` house_authority check and a house signer (trailing account). |
| Existing instructions | Behaviour changes. `legacy-game.rs::rf_player_not_signer_3010` diverges (unsigned at +301 now succeeds). | **Unchanged byte-for-byte.** All 684 parity tests stay as they are. | Unchanged |
| Crank logic | The crank must pick `refund_expired` or `cash_out` itself. A wrong pick returns 3010. | **The program picks.** The crank sends one instruction for every expired game. | Same as B |
| Depends on the house | Only to settle the cash branch | Only to settle the cash branch | For every release |
| Honest-player loss | none | none | none |
| SDK | builder variants with `isSigner: false` | one new builder | one new builder |

Option C is rejected because the payout is deterministic and goes only to `game.player`. A stranger calling it cannot hurt anyone, and gating it on the house only adds a dependency on the house being up.
Option A is rejected because it turns two audited instructions into two-mode handlers keyed on `is_signer`. That makes the parity story weaker for no gain.

Other ideas considered and dropped:
- **Opening `close_unsettled_game` to anyone** is not needed. Won and Lost are reachable only after a house reveal, so the house holds the preimage and can settle. Opening it would let griefers pre-empt the house's settle once 38 slots (about 15 s) have passed, which wipes the referral cut, the stats and the fairness proof for honest cash-outs. It stays as it is.
- **A house "void" for 0-reveal games before expiry** would shorten the window for garbage games, but it gives the house a new power and does not help against real-commitment griefing (see section 7). Skipped.

**Pick: B.**

## 3. Exact spec

### 3.1 New instruction `expire_game`

- Name / log line: `expire_game` / `Program log: Instruction: ExpireGame`
- Discriminator: `sha256("global:expire_game")[..8]` = `d0155783f22bfc90` = `[0xd0, 0x15, 0x57, 0x83, 0xf2, 0x2b, 0xfc, 0x90]`. It does not collide with any of the 42 existing discriminators.
- Args: none. Trailing bytes are ignored, the same as `refund_expired`.
- Accounts, in this order:

| # | Account | Writable | Signer | Checks (in this order) |
|---|---|---|---|---|
| 0 | vault | yes | no | `load(Vault)`; seeds/bump (2006); mut (2000) |
| 1 | v2_state | yes | no | `load(VaultV2State)`; seeds (2006); mut (2000) |
| 2 | game | yes | no | `load(GameSession)`; seeds `[GAME_SEED, game.player]` with the stored bump (2006); mut (2000) |
| 3 | player | yes | **no** | `game.player == player` (6007 Unauthorized); mut (2000) |

Fewer than 4 accounts gives 3005. The fee payer can be anyone and does not appear in the account list. The full check order is: the three loads, then `check_vault_v2_mut`, then `check_game_owned(game, player)`, then `check_mut(player)`. These are the same helpers `refund_expired` uses, minus `check_signer`.

Handler:

```rust
/// `expire_game` (F2 fix, not in Anchor). Permissionless exit for an EXPIRED Playing game. Pays the
/// player exactly what the better of their own two exits would pay (refund_expired or cash_out).
/// Accounts: vault(W), v2_state(W), game(W), player(W). No signer.
#[inline(never)]
pub fn expire_game(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, v2s, game, player, ..] = accounts else { return Err(NOT_ENOUGH_KEYS.into()) };
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    load(game, &gs::TYPE)?;
    check_vault_v2_mut(vault, v2s)?;
    check_game_owned(game, player)?;
    check_mut(player)?;

    let gk = *game.address().as_array();
    let clock = clock()?;
    let (gp, bet, mult, safe, max_payout) = {
        let d = game.try_borrow()?;
        require(d[gs::STATUS] == STATUS_PLAYING, K::GameNotPlaying)?;                       // 6003
        require(clock.slot > rd_u64(&d, gs::START_SLOT).saturating_add(GAME_EXPIRY_SLOTS),
            K::GameNotExpired)?;                                                            // 6014
        (*rd_pk(&d, gs::PLAYER), rd_u64(&d, gs::BET), rd_u64(&d, gs::MULTIPLIER_BPS),
         d[gs::SAFE_REVEALS], rd_u64(&d, gs::MAX_PAYOUT))
    };
    let available = vault_assets(vault, &rent()?)?;
    if safe == 0 || mult < BPS {
        // refund_expired branch. Unlike refund_expired it never pays a partial refund.
        require(bet <= available, K::VaultInsufficientFunds)?;                              // 6006
        move_lamports(vault, player, bet)?;
        game.try_borrow_mut()?[gs::STATUS] = STATUS_EXPIRED;
        release_outstanding(v2s, max_payout)?;
        emit(&events::game_refunded(&gp, &gk, bet, bet, clock.slot));
    } else {
        // cash_out branch: identical effects to cash_out. Reservation is released by settle_game.
        let payout = mul_div_floor(bet, mult, BPS)?;
        require(payout <= available, K::VaultInsufficientFunds)?;                           // 6006
        move_lamports(vault, player, payout)?;
        game.try_borrow_mut()?[gs::STATUS] = STATUS_WON;
        {
            let mut d = vault.try_borrow_mut()?;
            let tp = rd_u64(&d, vt::TOTAL_PAYOUTS).saturating_add(payout);
            wr_u64(&mut d, vt::TOTAL_PAYOUTS, tp);
        }
        emit(&events::game_won(&gp, &gk, bet, payout, mult, safe, clock.slot));
    }
    Ok(())
}
```

Notes for the implementer:
- `safe == 0` implies `mult == BPS`, because `start_game` writes BPS. The `safe == 0` test is kept anyway so the 0-reveal case does not depend on that.
- **Ties** (`mult == BPS`, `safe > 0`) take the cash branch. That keeps the house settle, the referral cut and the stats for the player.
- **Do not release the reservation in the cash branch.** `settle_game` releases it unconditionally, so releasing here as well would bring back the double-decrement bug fixed on 2026-05-07.
- The paused flag is not checked, matching `refund_expired` and `cash_out`.
- The game PDA is **not closed**. Expired or Won games keep their rent for the player's `close_game` / `close_unsettled_game`, the same as today.
- The `player` lamport credit is always at least 1,000,000, which exceeds the 0-data rent minimum (890,880). A closed or empty player wallet still receives it.

### 3.2 Registration
`ix/mod.rs`: append `(EXPIRE_GAME, [0xd0, 0x15, 0x57, 0x83, 0xf2, 0x2b, 0xfc, 0x90], "ExpireGame", legacy_game::expire_game),` and change the "42 instructions" doc comment to 43.

`kaboom-p/tests/abi.rs::instructions_match_idl`: keep `list.len() == 42` for the Anchor IDL. Change `ix::INSTRUCTIONS.len()` to 43, and assert that the one extra entry is `("ExpireGame", sha8("global:expire_game"))` and that it routes.

### 3.3 Everything else: none
- State: no new fields and no reserved bytes used.
- Errors: none new. It uses 6003, 6006, 6007 and 6014.
- Events: none new. It reuses `GameRefunded` and `GameWon`, so the indexer already parses them. In the refund branch `refund == bet` always.
- Constants: none new. It reuses `GAME_EXPIRY_SLOTS = 300` (about 2 min).
- `refund_expired`, `cash_out`, `close_unsettled_game` and `settle_game` are unchanged.

## 4. Tests

New file `difftest/tests/fix_f2.rs`. Anchor has no `expire_game`, so every `expire_game` transaction is expected to give `d.anchor.code() == Some(101)` and `d.port.ok()`. After that the sides diverge, so tests read the port side with `p.get_both(k).1`, not `p.get`. Build the instruction by hand: data = DISC, metas `[vault W, v2 W, game W, player W non-signer]`, sent with `p.run_as(stranger, ..)` where `stranger = p.user("cranker")`.

| Test | Proves |
|---|---|
| `f2_garbage_games_cleared_by_stranger` | Re-runs the audit setup (greedy garbage games until 6034), warps +301, and the stranger expires every game. Port: each griefer gains exactly `bet`, `total_outstanding_max_payout` goes back to its pre-attack value (0), and a fresh honest `start_game` (1 mine, 0.01 SOL) succeeds. **The hole is closed.** |
| `f2_expiry_boundary` | At `start_slot + 300` it fails with 6014 and nothing changes. At +301 it succeeds. |
| `f2_zero_reveals_refund_branch` | Pays `bet`, status Expired, reservation released, the `GameRefunded{refund: bet}` event is logged, and the player's later `close_game` (signed) returns the rent. |
| `f2_cash_branch_pays_cash_value_then_house_settles` | With 2 safe reveals: the player gains exactly `bet*mult/BPS`, status Won, `settled == 0`, `vault.total_payouts += payout`, `GameWon` logged, and the reservation is **still held**. Then the house sends `[expire_game, settle_game(layout, salt)]` in one tx on a second game. It succeeds, the reservation is released exactly once, port CU is under 200,000 (measured parts: cash_out 3.4k, settle 7.9k to 10.4k), and the stats and referral cut are applied. |
| `f2_mult_below_one_takes_refund_branch` | `update_vault` edge 1000, 1 mine, 1 safe reveal (mult 9600): pays `bet` (more than the cash value), status Expired, released. |
| `f2_no_partial_refund_6006` | Vault lamports set so `vault_assets < bet`: expire fails with 6006 and the game is untouched. The signed `refund_expired` still pays the partial amount on both sides (parity unchanged). |
| `f2_cash_branch_vault_short_6006` | `payout > available`: 6006, no state change. |
| `f2_wrong_player_6007` | `player` set to the stranger's key: 6007. Funds cannot be redirected. |
| `f2_player_readonly_2000`, `f2_vault_not_mut_2000`, `f2_fake_v2_2006`, `f2_v2_as_vault_3002`, `f2_not_enough_keys_3005` | The account checks mirror `refund_expired`. |
| `f2_not_playing_6003` | On Won, Lost, Expired and a second call after a successful expire: 6003. No double payment. |
| `f2_signed_paths_untouched` | After expiry the player's own `cash_out` still works (the no-expiry quirk) on both sides with identical results. Then expire gives 6003. The same holds for the player's own `refund_expired`. |
| `f2_batch_crank_cu` | 10 expires in one tx stay under 200,000 CU and the 1232-byte size limit. |

Regression requirements: the full existing difftest suite passes unchanged, including `audit_money.rs` (it records Anchor behaviour) and `legacy-game.rs::rf_player_not_signer_3010` / `co_player_not_signer_3010`. `cargo test` in `kaboom-p` (abi) also passes.

## 5. Interactions

- **The cash_out no-expiry quirk:** kept. The player's own `cash_out` / `refund_expired` are untouched. `expire_game` only runs after expiry, when the player's choice set is exactly {cash_out, refund}, and it pays the larger of the two.
- **Outstanding accounting:** the refund branch releases `max_payout` once (the same as `refund_expired`). The cash branch defers the release to `settle_game` (the same as `cash_out`). Each game is still decremented exactly once.
- **F4 (pending LP withdraw):** legacy pays at the moment the outcome is decided (in `cash_out` and in both `expire_game` branches), so no "resolved but unpaid" window is added. Live Playing games with accrued multipliers are still not in NAV, but that lag already exists. The F4 designer does not need to account for `expire_game`.
- **F5 (referral required):** do **not** extend "referral account required" to legacy `settle_game`. `apps/web/src/app/api/admin/release-stuck-obligations/route.ts` builds `settle_game` without the referrer, so a required account would make that route fail and strand cash-branch reservations. `settle_game` is house-gated, so the house is trusted to pass it. The route's missing referrer is an existing bug that should be fixed in the app (see section 6).

## 6. Client impact (apps/packages, not edited here)

1. **SDK** `packages/sdk/src/instructions.ts`: add `buildExpireGame({ ctx, player })` with keys `[vault W, v2 W, game W, player W isSigner:false]` and data = the 8-byte discriminator.
2. **Relay cron** (house key as fee payer, every 60 s):
   - Run `getProgramAccounts` with filters `dataSize 180` and `memcmp {offset: 41, bytes: base58([0])}` (Playing), then keep the games where `currentSlot > start_slot + 300`.
   - Branch with the program's own predicate: `safe_reveals(@87) == 0 || multiplier_bps(@88) < 10000` means refund, otherwise cash.
   - Refund: send `expire_game`, batching up to 10 per tx, then delete the session row if one exists.
   - Cash: send `[expire_game, settle_game(layout, salt, referrer)]` from the stored session, then delete the session only after the transaction is confirmed.
3. **Schedule `release-stuck-obligations`** on the same cron. It settles Won/Lost games left unsettled, for example when a player cashes out directly and never calls `/api/settle`. Also fix it to pass `referrer`.
4. **Web:** no change is required. `/api/cleanup` and `GameRecoveryBanner` already handle the states the crank leaves behind: Expired leads to `close_game`, Won unsettled leads to settle or `close_unsettled`. The existing web flows use only the signed instructions, which are unchanged.

## 7. Trade-offs and residual risk

- **Honest players lose nothing.** After expiry they receive the larger of their two exits, which is at least what Anchor would have let them take. Two small differences:
  1. They can no longer leave an expired game open indefinitely, which had no value to them.
  2. In the refund branch, `expire_game` refuses to pay a partial refund. The player keeps the signed partial-refund path.
- **LPs** lose the windfall from abandoned games (forgotten bets and unclaimed wins used to stay in the vault for good). That money belonged to the players.
- **Permanent stranding is closed.** An abandoned Playing game now holds its reservation for at most 301 slots plus the crank period (about 2.5 to 3 min) in the refund branch. In the cash branch it is held until the house settle, which runs in the same tx when the house cranks.
- **Residual risk: rolling re-creation.** This is not an F2 regression; Anchor has it too, through self-refund and with server-issued commitments.
  - How it works: a bet of 0.001 SOL, refundable, still reserves up to the effective max-payout cap for 300 slots. An attacker who restarts about 45 wallets every ~310 slots can keep play frozen continuously.
  - What it costs: about 10 to 15k lamports per wallet-cycle in fees, roughly 0.3 SOL/day. Bets and rent come back.
  - Why `expire_game` cannot fix it: a sophisticated attacker self-refunds at +301 before the crank ever runs.
  - What would fix it is reservation pricing, not a release path. Options are a non-refundable expiry fee on 0-reveal refunds in **both** refund paths (this changes `refund_expired` and costs honest abandoners that fee), a shorter expiry for 0-reveal games, or a lower worst-case cap per game. **This needs an owner decision.** It is flagged here and not included in this fix.
- **House preimage loss** (a session row deleted before the settle is confirmed) leaves a Won/Lost game reserved until the player calls `close_unsettled_game`. An attacker cannot cause this; it is an operational issue. If it ever matters, add a house-signed path to `close_unsettled_game` later.
