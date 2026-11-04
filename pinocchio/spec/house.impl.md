# house.impl.md

File: `pinocchio/kaboom-p/src/ix/house.rs`

## Shared context check (`check_house_ctx`, used by all four)

| spec step | line |
|---|---|
| 0.6 step 2 `Instruction: <PascalName>` log | dispatcher, `src/ix/mod.rs:70-73` |
| 0.6 step 4 missing account -> 3005, lazily per field | 12-14, 21, 23, 25, 28 |
| vault `Account<Vault>` a-e (3012/3007/3001/3002/3003 incl. paused bool) | 22 |
| v2_state `Account<VaultV2State>` a-e (incl. vrf_mode_enabled bool) | 24 |
| owner `Signer` -> 3010 | 26 |
| system_program `Program<System>` -> 3008 / 3009 (house_deposit only) | 27-29 |
| vault seeds + stored bump -> 2006 | 30 |
| vault mut -> 2000 | 31 |
| `vault.owner == owner` -> 6007 | 32 |
| v2_state seeds + stored bump -> 2006 | 33 |
| v2_state mut -> 2000 | 34 |
| owner mut -> 2000 | 35 |

## 1. house_deposit

| spec step | line |
|---|---|
| args `amount: u64`, short -> 102, trailing ignored | 44 |
| account checks in order | 45 |
| 1 `amount > 0` -> 6009 | 48 |
| 2 `assets_pre = vault_assets` | 49 |
| 3 `total_units_pre` | 50 |
| 4 `deposit_to_units` | 51 |
| 5 `units_minted > 0` -> 6008 | 52 |
| 6 System Transfer owner -> vault | 54 |
| 7 `total_units` checked_add, write @17 | 57-58 |
| 8 `house_units` checked_add, write @33 | 59-60 |
| 9 emit `HouseDeposited` (56 bytes) | 62 |
| 10 exit writes | 58, 60 |

## 2. house_request_withdraw

| spec step | line |
|---|---|
| args `units: u128`, short -> 102 | 72 |
| account checks in order | 73 |
| 1 `house_pending_units == 0` -> 6035 | 77 |
| 2 `units > 0` -> 6009 | 78 |
| 3 `units <= house_units` -> 6038 | 79-80 |
| 4 `house_after` checked_sub | 82 |
| 5 `user_units_total` on pre-write state | 83 |
| 6 `enforce_house_floor` -> 6033 / 6008 | 84 |
| 7 write `house_units` @33 | 86 |
| 8 write `house_pending_units` @49 | 87 |
| 9 `unlock = slot.saturating_add(cooldown)` | 88-89 |
| 10 write `house_pending_unlock_slot` @65 | 90 |
| 11 emit `HouseWithdrawRequested` (40 bytes) | 92 |

## 3. house_cancel_withdraw

| spec step | line |
|---|---|
| no args, trailing ignored | 101 |
| account checks in order | 102 |
| 1 `house_pending_units > 0` -> 6036 | 106-107 |
| 2 `units = house_pending_units` | 106 |
| 3 `house_units` checked_add, write @33 | 108-109 |
| 4 `house_pending_units = 0` | 110 |
| 5 `house_pending_unlock_slot = 0` | 111 |
| 6 emit `HouseWithdrawCancelled` (32 bytes) | 113 |

## 4. house_complete_withdraw

| spec step | line |
|---|---|
| no args, trailing ignored | 122 |
| account checks in order | 123 |
| 1 `house_pending_units > 0` -> 6036 | 127-128 |
| 2 `now = Clock.slot` | 129 |
| 3 `now >= house_pending_unlock_slot` -> 6037 | 130 |
| 4 `units = house_pending_units` | 127 |
| 5 `assets_pre = vault_assets` | 132 |
| 6 `units_to_assets` with pre-burn `total_units` | 133-134 |
| 7 `assets_out <= assets_pre` -> 6039 | 135 |
| 8 `house_pending_units = 0` | 137 |
| 9 `house_pending_unlock_slot = 0` | 138 |
| 10 `total_units` checked_sub -> 6008, write @17 | 139 |
| 11 if `assets_out > 0`: vault debit then owner credit, checked -> 6008 | 141-143 |
| 12 emit `HouseWithdrawCompleted` (40 bytes), slot = `now` | 145 |

## Deviations

| item | detail |
|---|---|
| 3005 order | Missing accounts fail lazily at the field Anchor reaches, not upfront as in the PORT_NOTES skeleton (Anchor `try_accounts` checks `is_empty()` per field) |
| Clock reads | One `Clock::get` per handler; Anchor calls it twice in house_request_withdraw (same slot in one tx, bytes identical) |
| Spec vs source | None found |
