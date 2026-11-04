# v2-lp implementation checklist

File: `pinocchio/kaboom-p/src/ix/v2_lp.rs`. Line numbers refer to that file.

## Shared (spec 0.x)

| spec step | line |
|---|---|
| 0.1.1 Instruction log line | `ix/mod.rs` route table (`InitializeV2`, `UpdateV2Config`, `LpDeposit`, `RequestWithdraw`, `CancelWithdraw`, `CompleteWithdraw`, `CloseLpPosition`), logged by `lib.rs` `process_instruction` before the handler |
| 0.1.2 args first, 102, trailing ignored | 64-72, 127, 215 (`helpers::Args`) |
| 0.1.3 missing account 3005 | 19-21, 74-76, 128-130, 216-218, 240-242, 261-263, 302-304 |
| 0.1.7 exit writes, vault unchanged | written in place; vault data never written |
| 0.2 events, one slice | 57, 119, 187, 233, 254, 288-295, 321 |
| 0.6 init / init_if_needed | 28 (`init_pda`), 138-139 (`init_if_needed_pda`) |
| 0.7 close = user | 323 (`close_to`) |
| UserLpAction accounts (4/5/6) | 195-210 (`user_lp_checks`) |

## 1. initialize_v2

| spec step | line |
|---|---|
| Pass A vault load | 23 |
| Pass A owner signer | 24 |
| Pass A system program | 25 |
| init v2_state, canonical bump, payer owner, 2006/4101/2000/2005 | 27-28 |
| vault seeds stored bump 2006 | 30 |
| vault.owner == owner 6007 | 31 |
| owner mut 2000 | 32 |
| H1 vault_assets | 34 |
| H2 assets >= 1e9 else 6039 | 35 |
| H3 seed / house / total | 36-38 |
| H4 full image (disc, bump, every field; vrf_* and reserved left 0) | 39-56 |
| H5 V2Initialized | 57 |

## 2. update_v2_config

| spec step | line |
|---|---|
| args, 8 Options in arg order, 102 | 64-72 |
| Pass A vault, v2 load, owner signer | 78-80 |
| vault seeds 2006 | 82 |
| vault.owner == owner 6007 | 83 |
| v2 seeds 2006, mut 2000 | 84-85 |
| H1 vrf_mode_enabled | 89-91 |
| H2 vrf_validator | 92-94 |
| H3 vrf_max_payout_bps <= 10000 6010 | 95-98 |
| H4 min_house_share_bps <= 10000 6010 | 99-102 |
| H5 max_user_position_bps <= 10000 6010 | 103-106 |
| H6 min_health_bps in [100, 10000] 6010 | 107-110 |
| H7 withdraw_cooldown_slots >= 150 6010 | 111-114 |
| H8 min_lp_deposit unvalidated | 115-117 |
| H9 V2ConfigUpdated (always) | 119 |

## 3. lp_deposit

| spec step | line |
|---|---|
| args amount u64 | 127 |
| Pass A vault, v2 load; user signer; system program | 132-135 |
| init_if_needed position (find 2006, create or pre-funded, typed load, 2019/2004/2005/2000/2005) | 137-139 |
| vault seeds, mut | 141-142 |
| v2 seeds, mut | 143-144 |
| user mut | 145 |
| H1 v2_min | 147-150 |
| H2 paused 6012 | 151 |
| H3 amount >= min 6031 | 152 |
| H4 assets_pre | 153 |
| H5 total_units_pre | 149 |
| H6 deposit_to_units | 154 |
| H7 units_minted > 0 6008 | 155 |
| H8 system Transfer user -> vault | 157 |
| H9 assets_after saturating | 159 |
| H10 total_units checked_add, write | 162-163 |
| H11 reinit guard: user, bump, created_slot | 168-173 |
| H12 position.units checked_add | 174-175 |
| H13 user_units_total | 177 |
| H14 enforce_house_floor 6033 | 178 |
| H15 position_units checked_add | 179 |
| H16 position_value | 180 |
| H17 calc_health_bps | 181 |
| H18 enforce_user_position_cap 6032 | 182 |
| H19 min health 6034 (reuses h) | 184-185 |
| H20 LpDeposited | 187 |
| H21 position disc stamped | 167 |

## 4. request_withdraw

| spec step | line |
|---|---|
| args units u128 | 215 |
| accounts | 219 |
| H1 pending == 0 6035 | 222 |
| H2 units > 0 6009 | 223 |
| H3 units <= position.units 6038 | 224-225 |
| H4 position.units checked_sub | 226 |
| H5 pending_units = units | 227 |
| H6 unlock saturating, write | 228-230 |
| H7 total_pending_units checked_add | 231-232 |
| H8 LpWithdrawRequested | 233 |

## 5. cancel_withdraw

| spec step | line |
|---|---|
| accounts | 243 |
| H1 pending > 0 6036 | 246-247 |
| H2 units = pending | 246 |
| H3 position.units checked_add | 248-249 |
| H4 pending = 0, unlock = 0 | 250-251 |
| H5 total_pending_units checked_sub | 252-253 |
| H6 LpWithdrawCancelled | 254 |

## 6. complete_withdraw

| spec step | line |
|---|---|
| accounts | 264 |
| H1 pending > 0 6036 | 268-269 |
| H2 now >= unlock 6037 | 270-271 |
| H3 units | 268 |
| H4 assets_pre | 272 |
| H5 units_to_assets with pre-burn total_units | 273-274 |
| H6 assets_out <= assets_pre 6039 | 275 |
| H7 pending = 0, unlock = 0 | 276-277 |
| H8 total_pending_units checked_sub | 278-279 |
| H9 total_units checked_sub | 280-281 |
| H10 direct lamports vault -> user, 6008, no CPI, no borrow held | 284-286 |
| H11 assets_after saturating | 287 |
| H12 LpWithdrawCompleted (post-burn total) | 288-295 |

## 7. close_lp_position

| spec step | line |
|---|---|
| Pass A position load, user signer | 306-307 |
| position seeds stored bump 2006 | 312 |
| position mut 2000 | 313 |
| position.user == user 6007 | 314 |
| close self-target 2011 | 317 |
| user mut 2000 | 318 |
| H1 units == 0 && pending == 0 6040 | 315, 320 |
| H2 LpPositionClosed before close | 321 |
| H3 close to user | 323 |

## Deviations

| item | detail |
|---|---|
| lp_deposit H19 | `enforce_min_health` is not called; `h` from H17 is reused (spec 3 step 19 allows it; same inputs) |
| lp_deposit H21 | disc written on every deposit, same bytes when the account already exists |
| close_lp_position H1 | emptiness read during Pass C while the borrow is open, checked after Pass C; error order unchanged |
| update_v2_config, initialize_v2 | Clock fetched only at the emit, matching the source |
| close overflow | `close_to` returns ArithmeticOverflow where Anchor panics; unreachable |
| source vs spec | no disagreement found |

## F-fix deviations (2026-11-04, binding spec `FIXES.md`)

- F4: `complete_withdraw` no longer checks the user's signature (`user_lp_checks(.., user_signs = false)`; request/cancel unchanged) and, as the last check before the lamport move, requires `slot <= pending_unlock_slot + 9_000` (`WITHDRAW_CLAIM_WINDOW_SLOTS`), else 6056 `WithdrawWindowExpired`. A lapsed request is restarted with `[cancel_withdraw, request_withdraw]`.
