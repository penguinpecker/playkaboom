# Port spec: Phase-2 LP vault (v2 + user LP) instructions

Scope: `initialize_v2`, `update_v2_config`, `lp_deposit`, `request_withdraw`,
`cancel_withdraw`, `complete_withdraw`, `close_lp_position`.

Source of truth (read-only): `programs/kaboom/src/lib.rs` @ `e82f2c5`
(line numbers below are that file unless marked otherwise). `vrf_mode.rs` is not
involved in any of these seven instructions. Cross-checked against
`target/idl/kaboom.json`: every discriminator, account list, signer/writable flag,
arg type, account type layout, event discriminator and error code below matches.

New program ID: `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`.

---

## 0. Shared definitions

### 0.1 Anchor 0.31.1 per-instruction pipeline (must be reproduced in this order)

From `anchor-syn-0.31.1/src/codegen/program/handlers.rs` and
`codegen/accounts/try_accounts.rs`:

1. `msg!("Instruction: <PascalName>")`, before anything else (before args are
   parsed, so it is logged even when the instruction then fails).
2. Args: `Borsh::deserialize(&mut &data[8..])`. Truncated or invalid data fails with
   **102 InstructionDidNotDeserialize**. **Trailing bytes are ignored** (this is
   `deserialize`, not `try_from_slice`). An instruction with no args accepts any
   trailing bytes.
3. **Deserialize phase**, accounts in struct order. Any missing account fails with
   **3005 AccountNotEnoughKeys**. An `init`/`init_if_needed` field only takes its
   AccountInfo here and is not checked yet.
   - `Account<T>` (`anchor-lang/src/accounts/account.rs:303`), checked in this order:
     a. owner == System program **and** lamports == 0 → **3012 AccountNotInitialized**
     b. owner != program_id → **3007 AccountOwnedByWrongProgram**
     c. data_len < 8 → **3001 AccountDiscriminatorNotFound**
     d. data[0..8] != disc → **3002 AccountDiscriminatorMismatch**
     e. Borsh-deserialize data[8..] (needs data_len ≥ 8 + body size; any `bool`
        byte must be 0 or 1) → otherwise **3003 AccountDidNotDeserialize**.
        Extra trailing data is allowed.
   - `Signer`: !is_signer → **3010 AccountNotSigner**.
   - `Program<System>`: key != `11111111111111111111111111111111` → **3008
     InvalidProgramId**; !executable → **3009 InvalidProgramExecutable**.
4. **Init phase**: init fields only (see 0.6).
5. **Constraint phase**: every non-init field in struct order. Within one field the
   order is fixed by `linearize` (`codegen/accounts/constraints.rs:71`):
   Seeds → Mut → Signer → has_one → raw `constraint =` → owner → rent_exempt →
   executable → close → address.
   - Seeds with a stored bump: `create_program_address(seeds ++ [stored_bump])`. If
     that errors, or if key != result → **2006 ConstraintSeeds**.
   - Mut: !is_writable → **2000 ConstraintMut**.
   - Raw `constraint = expr @ E` → custom error E.
   - Close: field.key == target.key → **2011 ConstraintClose**.
6. Handler body.
7. **Exit phase**, fields in struct order:
   - field with `close = t`: `common::close` (0.7);
   - else, if the field is mut (or init): re-serialize `disc ++ borsh(struct)` into
     data[0..] (skipped if the account is now system-owned with empty data);
   - non-mut fields: nothing is written.
   Pinocchio may write fields in place during the handler instead of at exit.
   Writing the same bytes back for an unchanged mut account (for example `vault`
   in lp_deposit) can be skipped.

Errors are `ProgramError::Custom(code)`. Anchor's `AnchorError ... Error Number`
log lines are not ABI and need not be reproduced (see Open questions).

### 0.2 Events (`emit!`)

`sol_log_data(&[ disc8 ++ borsh(fields in declaration order) ])`, one slice, which
shows up as `Program data: <base64>`. All integers are little-endian and a Pubkey is
32 raw bytes.

| Event | disc hex | disc dec | body layout (bytes) | total |
|---|---|---|---|---|
| V2Initialized (2875) | 22d57fc53df936d4 | [34,213,127,197,61,249,54,212] | vault:Pubkey32, seed_units:u128, house_units:u128, total_units:u128, slot:u64 | 96 |
| V2ConfigUpdated (2884) | 070e3395b4fc25a2 | [7,14,51,149,180,252,37,162] | vault:Pubkey32, slot:u64 | 48 |
| LpDeposited (2890) | 55d3b89fb0e01c48 | [85,211,184,159,176,224,28,72] | user:32, amount_lamports:u64, units_minted:u128, total_units_after:u128, vault_assets_after:u64, slot:u64 | 96 |
| LpWithdrawRequested (2900) | bfe9de83e97aaa1a | [191,233,222,131,233,122,170,26] | user:32, units:u128, unlock_slot:u64, slot:u64 | 72 |
| LpWithdrawCancelled (2908) | d00a6e73ea9e567d | [208,10,110,115,234,158,86,125] | user:32, units_returned:u128, slot:u64 | 64 |
| LpWithdrawCompleted (2915) | 7b1ebe2fe2c11c53 | [123,30,190,47,226,193,28,83] | user:32, units_burned:u128, amount_lamports:u64, total_units_after:u128, vault_assets_after:u64, slot:u64 | 96 |
| LpPositionClosed (2925) | d90ffaccd65acc30 | [217,15,250,204,214,90,204,48] | user:32, slot:u64 | 48 |

`slot` is always `Clock::get()?.slot`. It is the same value for every call within
one instruction, so one `Clock::get` per handler is enough.

### 0.3 Account layouts (all fields unaligned: read and write with `from_le_bytes`/`to_le_bytes` on byte slices and never cast pointers to `u128`/`u64`)

**Vault** (1971-2004). disc `d308e82b02987577` = [211,8,232,43,2,152,117,119].
SPACE = 428 (body 420). Offsets (absolute, including the 8-byte disc):

| field | off | size |
|---|---|---|
| owner | 8 | 32 |
| house_authority | 40 | 32 |
| treasury | 72 | 32 |
| bump | 104 | 1 |
| house_edge_bps | 105 | 2 |
| max_bet_bps | 107 | 2 |
| max_payout_bps | 109 | 2 |
| treasury_split_bps | 111 | 2 |
| total_games | 113 | 8 |
| total_wagered | 121 | 8 |
| total_payouts | 129 | 8 |
| paused (bool) | 137 | 1 |
| version | 138 | 1 |
| allowlist_count | 139 | 1 |
| withdraw_allowlist [Pubkey;8] | 140 | 256 |
| pending_owner | 396 | 32 |

**VaultV2State** (2009-2083). disc `eefcdafd5966445e` = [238,252,218,253,89,102,68,94].
SPACE = 191 (body 183; the `+64` reserved in SPACE equals vrf_mode_enabled 1 +
vrf_validator 32 + vrf_max_payout_bps 2 + _reserved 29).

| field | off | size |
|---|---|---|
| bump | 8 | 1 |
| total_outstanding_max_payout u64 | 9 | 8 |
| total_units u128 | 17 | 16 |
| house_units u128 | 33 | 16 |
| house_pending_units u128 | 49 | 16 |
| house_pending_unlock_slot u64 | 65 | 8 |
| seed_units u128 | 73 | 16 |
| total_pending_units u128 | 89 | 16 |
| min_house_share_bps u16 | 105 | 2 |
| max_user_position_bps u16 | 107 | 2 |
| min_health_bps u16 | 109 | 2 |
| withdraw_cooldown_slots u64 | 111 | 8 |
| min_lp_deposit u64 | 119 | 8 |
| vrf_mode_enabled bool | 127 | 1 |
| vrf_validator Pubkey | 128 | 32 |
| vrf_max_payout_bps u16 | 160 | 2 |
| _reserved [u8;29] | 162 | 29 |

**LpPosition** (2085-2099). disc `69f125c8e002fc5a` = [105,241,37,200,224,2,252,90].
SPACE = 121 (body 113).

| field | off | size |
|---|---|---|
| user | 8 | 32 |
| units u128 | 40 | 16 |
| pending_units u128 | 56 | 16 |
| pending_unlock_slot u64 | 72 | 8 |
| created_slot u64 | 80 | 8 |
| bump u8 | 88 | 1 |
| _reserved [u8;32] | 89 | 32 |

Anchor parity for the `bool` bytes (Vault.paused @137, VaultV2State.vrf_mode_enabled
@127): a byte value > 1 makes Anchor fail with 3003. This program only ever writes 0
or 1 there, so the check is cheap but optional (see Open questions).

### 0.4 PDAs (new program ID)

| account | seeds | address | canonical bump |
|---|---|---|---|
| vault | [b"kaboom_vault"] (129) | 7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7 | 254 |
| v2_state | [b"kaboom_v2_state"] (130) | Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue | 255 |
| position | [b"kaboom_lp", user.key] (131) | per user | per user |

### 0.5 Constants (lib.rs 53-125)

BPS = 10_000 (53); ANTI_INFLATION_SEED_LAMPORTS = 1_000_000_000 (96);
DEFAULT_WITHDRAW_COOLDOWN_SLOTS = 648_000 (100); MIN_WITHDRAW_COOLDOWN_SLOTS = 150
(108); MIN_HEALTH_BPS_FLOOR = 100 (113); DEFAULT_MIN_HOUSE_SHARE_BPS = 5_000 (116);
DEFAULT_MAX_USER_POSITION_BPS = 1_000 (119); DEFAULT_MIN_HEALTH_BPS = 1_000 (122);
DEFAULT_MIN_LP_DEPOSIT_LAMPORTS = 10_000_000 (125).

Rent: `Rent::get()?` then `try_minimum_balance(n)` = (128 + n) × lamports_per_byte.
pinocchio 0.11.2 reads only the first u64 of the sysvar. Live mainnet (read
2026-11-04) is `lamports_per_byte_year = 5080`, `exemption_threshold = 1.0`, so
Vault(428) = 2,824,480, VaultV2State(191) = 1,620,520 and LpPosition(121) =
1,264,920. solana-rent's `((128+n)*5080) as f64 * 1.0` gives the same values, and
`getMinimumBalanceForRentExemption(428)` returned 2,824,480. (The 6960 / 3480 × 2.0
figures that used to be here are the old default rent and are stale.)

### 0.6 `init` / `init_if_needed` for a program-owned PDA (constraints.rs 469-560, 1032-1132, 1621-1674)

For field F with payer P, space S and seeds `seeds`:

1. `rent = Rent::get()?`.
2. `(pda, bump) = find_program_address(seeds, program_id)`. If F.key != pda →
   **2006**. The bump goes into `ctx.bumps.F`. Use `try_find_program_address`.
3. Let `actual_owner = F.owner` (read it again after the CPIs, as Anchor's
   reference does).
4. If `!if_needed || F.owner == System program`, **create**:
   - if F.lamports == 0: CPI `system::CreateAccount{from: P, to: F, lamports:
     rent.min_balance(S), space: S, owner: program_id}`, signed with
     `seeds ++ [bump]`.
   - else (pre-funded): if P.key == F.key → **4101 TryingToInitPayerAsProgramAccount**;
     `req = max(rent.min_balance(S), 1).saturating_sub(F.lamports)`; if req > 0
     → CPI `system::Transfer{P → F, req}` (unsigned); CPI `system::Allocate{F,
     S}` signed; CPI `system::Assign{F, program_id}` signed.
   - Then view the data **without** a disc check. It is all zeros, so the struct is
     all-default. (Anchor's `try_from_unchecked` 3012/3007 checks cannot fire here.)
   - Non-`if_needed` and F already program-owned: this branch still runs. Lamports
     are > 0, so it reaches `Allocate`, which fails inside the System program
     (`SystemError::AccountAlreadyInUse`, Custom(0)). That is the "second
     initialize_v2 fails" guarantee (1311-1312).
5. Else (`if_needed` and F is not system-owned): full `Account<T>` checks
   (0.1 step 3 a-e: 3007 / 3001 / 3002 / 3003).
6. If `if_needed`: data_len != S → **2019 ConstraintSpace**; owner != program_id →
   **2004 ConstraintOwner**; lamports < rent.min_balance(S) → **2005
   ConstraintRentExempt**.
7. (Seeds is a no-op for init.) Mut: !F.is_writable → **2000**. (The CPI would
   already have failed if F was not writable; the pinocchio port may check
   writability first.)
8. Rent-exempt (implied by init): `!rent.is_exempt(F.lamports, F.data_len)` →
   **2005**.
9. At exit, `disc ++ borsh(struct)` is written. That write is what stamps the
   discriminator on a fresh account. Pinocchio may write the disc right after
   creation; the end state is the same.

### 0.7 `close = target` (anchor-lang/src/common.rs:6-15), run in the exit phase after the handler

`target.lamports = target.lamports.checked_add(F.lamports).unwrap()`;
`F.lamports = 0`; `F.assign(System)`; `F.realloc(0)`. Serialization is skipped.
In pinocchio: add lamports to the target, then `AccountView::close()`. close()
zeroes owner, lamports and data_len; the runtime zeroes the data.

### 0.8 Math helpers (port byte-for-byte; shared with house-LP / game specs)

- `vault_assets(vault)` (1854-1857): `vault.lamports.saturating_sub(rent.min_balance(428))` → u64.
- `deposit_to_units(amount:u64, assets_pre:u64, total_units:u128) -> u128` (1861-1870):
  if total_units == 0 → `amount as u128`; else require assets_pre > 0 else
  **MathOverflow 6008**; `(amount as u128).checked_mul(total_units)` (6008)
  `.checked_div(assets_pre as u128)` (floor).
- `units_to_assets(units:u128, assets:u64, total:u128) -> u64` (1873-1883): if
  total == 0 || units == 0 → 0; `units.checked_mul(assets as u128)` (6008)
  `.checked_div(total)`; `u64::try_from` else 6008.
- `user_units_total(v2) -> u128` (1885-1891): `total_units - seed_units -
  house_units - house_pending_units`, each `checked_sub`, any underflow → 6008.
- `calc_health_bps(v2, assets:u64) -> u16` (1893-1909): if assets == 0 → 0;
  `pending_value = units_to_assets(v2.total_pending_units, assets, v2.total_units)?`;
  `obligations = v2.total_outstanding_max_payout.checked_add(pending_value)` (6008);
  `free = assets.saturating_sub(obligations)`; `h = (free as u128 * 10000) /
  assets as u128` (checked, 6008); return `min(h, 10000) as u16`.
- `enforce_min_health(v2, assets)` (1911-1918): if v2.min_health_bps == 0 → Ok;
  `h = calc_health_bps(..)?`; require h ≥ min_health_bps else **HealthFloorBreached 6034**.
- `enforce_house_floor(house:u128, user:u128, bps:u16)` (1920-1942): if bps == 0
  → Ok; `denom = house.checked_add(user)` (6008); if denom == 0 → Ok; `lhs =
  house.checked_mul(10000)` (6008); `rhs = (bps as u128).checked_mul(denom)` (6008);
  require lhs ≥ rhs else **HouseShareFloorBreached 6033**.
- `enforce_user_position_cap(value:u64, assets:u64, h:u16, bps:u16)` (1944-1967):
  if bps == 0 → Ok; `cap = ((assets as u128 * bps) / 10000 * h) / 10000`. Each step
  is checked (6008) and each division floors **in that order**: floor after the
  first `/10000`, then `*h`, then `/10000`. Require `value as u128 ≤ cap` else
  **UserPositionCapExceeded 6032**.

### 0.9 Custom errors used here (6000 + enum index, lib.rs 2711-2824, verified against the IDL)

Unauthorized 6007, MathOverflow 6008, InvalidAmount 6009, InvalidConfig 6010,
VaultPaused 6012, DepositBelowMin 6031, UserPositionCapExceeded 6032,
HouseShareFloorBreached 6033, HealthFloorBreached 6034,
PendingWithdrawAlreadyExists 6035, NoPendingWithdraw 6036, CooldownNotElapsed 6037,
InsufficientUnits 6038, InsufficientLiquidity 6039, LpPositionNotEmpty 6040.

### 0.10 Discriminator check (reproducible)

```
python3 -c "import hashlib;[print(n,hashlib.sha256(('global:'+n).encode()).digest()[:8].hex()) for n in 'initialize_v2 update_v2_config lp_deposit request_withdraw cancel_withdraw complete_withdraw close_lp_position'.split()]"
```

---

## 1. initialize_v2 (handler 1313-1348, accounts 2568-2590)

- Log: `Program log: Instruction: InitializeV2`
- Discriminator: `4399af27da102620` = [67,153,175,39,218,16,38,32]
- Args: none. Data = 8 bytes, and any trailing bytes are ignored.

### Accounts

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | **no** | `Account<Vault>` (3012/3007/3001/3002/3003). seeds [b"kaboom_vault"], bump = **stored** `vault.bump` → 2006. `constraint = vault.owner == owner.key()` @ **Unauthorized 6007**. Not mut, so it is never written. |
| 1 | v2_state | no | yes | `init`, payer = owner, seeds [b"kaboom_v2_state"], bump = canonical (find), space = 191. Implied mut (2000) and rent-exempt (2005). See 0.6 with if_needed = false. |
| 2 | owner | **yes** | yes | `Signer` (3010), `mut` (2000). |
| 3 | system_program | no | no | `Program<System>` (3008/3009). |

Check order (Anchor): deserialize vault → take v2_state → Signer owner → Program
system → **init v2_state (CPIs happen here)** → vault seeds (2006) → vault raw
(6007) → owner mut (2000). Reordering the checks only changes which error is
reported when more than one check fails. Every failure reverts.

### Handler

1. `assets = vault_assets(vault)` = vault.lamports − rent(428), saturating (1314-1315).
2. `require!(assets >= 1_000_000_000, InsufficientLiquidity 6039)` (1316-1319).
3. `seed: u128 = 1_000_000_000`; `house: u128 = (assets − 1_000_000_000)` (plain sub,
   guarded by step 2); `total: u128 = assets` (1321-1323).
4. Writes to v2_state (1325-1338):
   - bump = canonical bump from 0.6 step 2 (`ctx.bumps.v2_state`, 1326)
   - total_outstanding_max_payout = 0
   - total_units = total
   - house_units = house
   - house_pending_units = 0
   - house_pending_unlock_slot = 0
   - seed_units = seed
   - total_pending_units = 0
   - min_house_share_bps = 5000
   - max_user_position_bps = 1000
   - min_health_bps = 1000
   - withdraw_cooldown_slots = 648_000
   - min_lp_deposit = 10_000_000
   - vrf_mode_enabled, vrf_validator, vrf_max_payout_bps, _reserved: **not
     written** (they stay 0 on the fresh account, so VRF mode is hard-off).
   - disc [238,252,218,253,89,102,68,94] at data[0..8].
5. `emit!(V2Initialized{vault: vault.key, seed_units: seed, house_units: house,
   total_units: total, slot})` (1340-1346).

Lamport movement: only the init. `owner` → v2_state, rent(191) = 1,620,520 today,
through the CreateAccount CPI (or Transfer + Allocate + Assign if pre-funded).

Subtle:
- The vault balance is not moved. Units are minted 1:1 against existing assets,
  so total_units == assets at init time.
- Whether owner is a Squads vault PDA signing through CPI makes no difference to
  the program.
- Units minted before initialize_v2 cannot exist, because v2_state is the only
  unit ledger.

---

## 2. update_v2_config (handler 1351-1412, accounts 2592-2605)

- Log: `Program log: Instruction: UpdateV2Config`
- Discriminator: `0d494f562f31e428` = [13,73,79,86,47,49,228,40]

### Args (Borsh, in this order)

Each field is `Option<T>`: 1 tag byte (0 = None, 1 = Some; any other value →
**102**), then T if Some.

| # | name | type | bytes if Some |
|---|---|---|---|
| 1 | min_house_share_bps | Option<u16> | 1+2 |
| 2 | max_user_position_bps | Option<u16> | 1+2 |
| 3 | min_health_bps | Option<u16> | 1+2 |
| 4 | withdraw_cooldown_slots | Option<u64> | 1+8 |
| 5 | min_lp_deposit | Option<u64> | 1+8 |
| 6 | vrf_mode_enabled | Option<bool> (byte 0/1 only, else 102) | 1+1 |
| 7 | vrf_validator | Option<Pubkey> | 1+32 |
| 8 | vrf_max_payout_bps | Option<u16> | 1+2 |

Data length: minimum 8+8 = 16 (all None), maximum 8+65 = 73. Truncation → 102.
Trailing bytes are ignored. The fields are variable-offset, so parse them
sequentially.

### Accounts

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | **no** | `Account<Vault>`; seeds [b"kaboom_vault"] bump = stored vault.bump (2006); `vault.owner == owner.key()` @ **6007**. |
| 1 | v2_state | no | yes | `Account<VaultV2State>`; seeds [b"kaboom_v2_state"] bump = **stored** v2_state.bump (2006); mut (2000). |
| 2 | owner | **yes** | **no** | `Signer` (3010). Not mut. |

Order: deserialize vault, v2_state, owner → vault seeds → vault raw → v2 seeds → v2 mut.

### Handler: fields are applied in this order, which differs from the arg order (1362-1406)

1. if Some(v) = vrf_mode_enabled → v2.vrf_mode_enabled = v (1363-1365).
2. if Some(v) = vrf_validator → v2.vrf_validator = v. No validation;
   Pubkey::default() is the kill switch (1368-1370).
3. if Some(v) = vrf_max_payout_bps → `require!(v <= 10000, InvalidConfig 6010)`;
   write (1372-1375). 0 is allowed (hard-off).
4. if Some(v) = min_house_share_bps → `require!(v <= 10000, 6010)`; write (1376-1379).
5. if Some(v) = max_user_position_bps → `require!(v <= 10000, 6010)`; write (1380-1383).
6. if Some(v) = min_health_bps → `require!(v >= 100 && v <= 10000, 6010)`; write (1384-1393).
7. if Some(v) = withdraw_cooldown_slots → `require!(v >= 150, 6010)` (no upper
   bound); write (1394-1403).
8. if Some(v) = min_lp_deposit → write, unvalidated (0 allowed) (1404-1406).
9. `emit!(V2ConfigUpdated{vault: vault.key, slot})` (1407-1410). This is emitted
   even when every arg is None.

Every failure is 6010 and reverts all writes, so the write order is not observable.
Keep it anyway. Lamports: none.

---

## 3. lp_deposit (handler 1415-1480, accounts 2607-2628), hot path

- Log: `Program log: Instruction: LpDeposit`
- Discriminator: `1b4dd2450c2b9410` = [27,77,210,69,12,43,148,16]
- Args: `amount: u64` (8 bytes LE). Data = 16 bytes (trailing bytes ignored).

### Accounts

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>`; seeds [b"kaboom_vault"], bump = stored vault.bump (2006); mut (2000). |
| 1 | v2_state | no | yes | `Account<VaultV2State>`; seeds [b"kaboom_v2_state"], bump = stored (2006); mut (2000). |
| 2 | position | no | yes | `init_if_needed`, payer = user, space = 121, seeds [b"kaboom_lp", user.key], bump = canonical (find). See 0.6 with if_needed = true: create path if system-owned, else full Account<LpPosition> checks, then 2019 / 2004 / 2005, mut 2000, rent-exempt 2005. **No `position.user == user` constraint** (the seeds bind it). |
| 3 | user | **yes** | yes | `Signer` (3010), mut (2000). |
| 4 | system_program | no | no | `Program<System>` (3008/3009). |

Order: deserialize vault, v2_state → take position → Signer user → Program →
**init_if_needed position (may CPI: user pays rent(121) = 1,264,920 today for a new position)** →
vault seeds/mut → v2 seeds/mut → user mut.

### Handler

1. `v2_min = v2.min_lp_deposit` (1416).
2. `require!(!vault.paused, VaultPaused 6012)` (1417). Read byte @137.
3. `require!(amount >= v2_min, DepositBelowMin 6031)` (1418).
4. `assets_pre = vault_assets(vault)` (1420-1421). Vault lamports here are before
   the transfer and are unaffected by the position init.
5. `total_units_pre = v2.total_units` (1422).
6. `units_minted = deposit_to_units(amount, assets_pre, total_units_pre)?` (1424). Errors 6008.
7. `require!(units_minted > 0, MathOverflow 6008)` (1425). This also guarantees
   amount > 0.
8. **CPI** `system::Transfer{from: user, to: vault, lamports: amount}`, unsigned
   (user is a tx signer) (1428-1437). Fails inside System if user has data or is
   not system-owned, or has insufficient lamports.
9. `assets_after = assets_pre.saturating_add(amount)` (1439). This is computed and
   not re-read from lamports.
10. `total_units_after = total_units_pre.checked_add(units_minted)` (6008);
    `v2.total_units = total_units_after` (1441-1444).
11. Reinit guard (1447-1452): `if position.user == [0;32]` then
    `position.user = user.key`; `position.bump = canonical bump` (from 0.6 step 2);
    `position.created_slot = slot`. Otherwise nothing is touched (an existing
    position keeps its user, bump and created_slot).
12. `position.units = position.units.checked_add(units_minted)` (6008) (1453-1456).
13. `user_after = user_units_total(v2)?` using the **updated** total_units (6008) (1459).
14. `enforce_house_floor(v2.house_units, user_after, v2.min_house_share_bps)?` → 6033 / 6008 (1460).
15. `position_units = position.units.checked_add(position.pending_units)` (6008) (1462-1465).
16. `position_value = units_to_assets(position_units, assets_after, v2.total_units)?` (1466).
17. `h = calc_health_bps(v2, assets_after)?` (1467).
18. `enforce_user_position_cap(position_value, assets_after, h, v2.max_user_position_bps)?` → 6032 (1468).
19. `enforce_min_health(v2, assets_after)?` → 6034 (1469). It recomputes the same
    `h`. Reusing the value from step 17 is equivalent: same inputs, and step 17
    always runs first, so any 6008 inside it surfaces at step 17 in both versions.
20. `emit!(LpDeposited{user: user.key, amount_lamports: amount, units_minted,
    total_units_after, vault_assets_after: assets_after, slot})` (1471-1478).
21. Exit: v2_state and position written (and the position disc on first creation);
    vault data unchanged.

Lamports:
- user → position: rent, only on first deposit, through init.
- user → vault: `amount`, through the System Transfer CPI.

Subtle:
- **Pre-funded PDA**: a system-owned position PDA with lamports > 0 must go
  through Transfer (top-up) + Allocate + Assign, not CreateAccount. Otherwise a
  1-lamport donation would DoS deposits.
- **Program-owned but wrong** position (wrong disc or short data) must fail
  3002 / 3001 / 3003, and wrong size must fail 2019.
- A position owned by a third program fails with **3007** (the full
  `Account::try_from` runs before the 2004 check).
- After `close_lp_position`, the PDA is system-owned with 0 lamports, so the next
  deposit re-creates it. The user is default, so step 11 re-stamps it.
- CU: `find_program_address` on every call (parity). Health is computed twice in
  Anchor; once is fine.
- remaining_accounts: unused, and extra accounts are ignored.

---

## 4. request_withdraw (handler 1482-1515, accounts `UserLpAction` 2630-2648)

- Log: `Program log: Instruction: RequestWithdraw`
- Discriminator: `895fbb60fa8a1fb6` = [137,95,187,96,250,138,31,182]
- Args: `units: u128` (16 bytes LE). Data = 24 bytes.

### Accounts (`UserLpAction`, shared by sections 4, 5 and 6)

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>`; seeds [b"kaboom_vault"], stored bump (2006); mut (2000). Validated even though request and cancel never read it. |
| 1 | v2_state | no | yes | `Account<VaultV2State>`; seeds, stored bump (2006); mut (2000). |
| 2 | position | no | yes | `Account<LpPosition>`; seeds [b"kaboom_lp", user.key], bump = **stored** position.bump (2006); mut (2000); `constraint = position.user == user.key()` @ **Unauthorized 6007** (after Seeds and Mut). |
| 3 | user | **yes** | yes | `Signer` (3010), mut (2000). |

Order: deserialize vault, v2, position, user → vault seeds, mut → v2 seeds, mut →
position seeds, mut, raw → user mut.

### Handler

1. `require!(position.pending_units == 0, PendingWithdrawAlreadyExists 6035)` (1486-1489).
2. `require!(units > 0, InvalidAmount 6009)` (1490).
3. `require!(units <= position.units, InsufficientUnits 6038)` (1491).
4. `position.units = position.units.checked_sub(units)` (6008, unreachable) (1493-1496).
5. `position.pending_units = units` (1497).
6. `unlock: u64 = slot.saturating_add(v2.withdraw_cooldown_slots)` (1498-1500);
   `position.pending_unlock_slot = unlock` (1501).
7. `v2.total_pending_units = v2.total_pending_units.checked_add(units)` (6008) (1503-1506).
8. `emit!(LpWithdrawRequested{user: user.key, units, unlock_slot: unlock, slot})` (1508-1513).

No paused check, no health check, no lamports. total_units is unchanged; pending
units still count in total_units until completion.

---

## 5. cancel_withdraw (handler 1517-1542, accounts `UserLpAction`)

- Log: `Program log: Instruction: CancelWithdraw`
- Discriminator: `7035e23a9e1e25a8` = [112,53,226,58,158,30,37,168]
- Args: none (data 8 bytes; trailing bytes ignored).
- Accounts: identical to section 4.

### Handler

1. `require!(position.pending_units > 0, NoPendingWithdraw 6036)` (1520-1523).
2. `units = position.pending_units` (1524).
3. `position.units = position.units.checked_add(units)` (6008) (1525-1528).
4. `position.pending_units = 0`; `position.pending_unlock_slot = 0` (1529-1530).
5. `v2.total_pending_units = v2.total_pending_units.checked_sub(units)` (6008) (1531-1534).
6. `emit!(LpWithdrawCancelled{user: user.key, units_returned: units, slot})` (1536-1540).

No paused check, no house-floor or cap re-check on re-adding units. Lamports: none.

---

## 6. complete_withdraw (handler 1544-1600, accounts `UserLpAction`)

- Log: `Program log: Instruction: CompleteWithdraw`
- Discriminator: `ac818d115ffdfb62` = [172,129,141,17,95,253,251,98]
- Args: none.
- Accounts: identical to section 4 (vault **is** read and debited here).

### Handler

1. `require!(position.pending_units > 0, NoPendingWithdraw 6036)` (1547-1550).
2. `now = Clock slot`; `require!(now >= position.pending_unlock_slot, CooldownNotElapsed 6037)` (1551-1555).
3. `units = position.pending_units` (1557).
4. `assets_pre = vault_assets(vault)` (1558-1559).
5. `assets_out = units_to_assets(units, assets_pre, v2.total_units)?`, using
   total_units **before** the burn (6008) (1560).
6. `require!(assets_out <= assets_pre, InsufficientLiquidity 6039)` (1561-1564).
7. `position.pending_units = 0`; `position.pending_unlock_slot = 0` (1567-1568).
8. `v2.total_pending_units = checked_sub(units)` (6008) (1569-1572).
9. `v2.total_units = checked_sub(units)` (6008) (1573-1576).
10. If `assets_out > 0` (1578-1588), use **direct lamport arithmetic, no CPI**:
    - `vault.lamports = vault.lamports.checked_sub(assets_out)` → 6008 on underflow;
    - `user.lamports = user.lamports.checked_add(assets_out)` → 6008 on overflow.
    The vault is program-owned, so the debit is legal. The vault stays ≥ rent(428)
    because assets_out ≤ assets_pre = lamports − rent.
11. `assets_after = assets_pre.saturating_sub(assets_out)` (1590).
12. `emit!(LpWithdrawCompleted{user: user.key, units_burned: units, amount_lamports:
    assets_out, total_units_after: v2.total_units (post-burn), vault_assets_after:
    assets_after, slot})` (1591-1598).

Subtle:
- There is no paused check, no health check, and outstanding game reservations
  are not checked. Withdrawals are allowed while paused. A withdrawal can take
  lamports that `total_outstanding_max_payout` relies on. This is Anchor
  behaviour and must be kept.
- The position stays open with zeroed pending state. It is closed separately.
- No CPI happens, so lamport and data writes have no ordering hazard. Pinocchio
  must not hold a data borrow on vault or user while setting lamports.

---

## 7. close_lp_position (handler 1602-1613, accounts 2650-2663)

- Log: `Program log: Instruction: CloseLpPosition`
- Discriminator: `217639c3857e6912` = [33,118,57,195,133,126,105,18]
- Args: none.

### Accounts

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | position | no | yes | `Account<LpPosition>` (3012/3007/3001/3002/3003); seeds [b"kaboom_lp", user.key], bump = stored position.bump (2006); mut (2000); `position.user == user.key()` @ **6007**; `close = user` → position.key == user.key → **2011** (checked after raw). |
| 1 | user | **yes** | yes | `Signer` (3010), mut (2000). |

Note there is no vault, no v2_state and no system_program.

### Handler

1. `require!(position.units == 0 && position.pending_units == 0, LpPositionNotEmpty 6040)` (1604-1607).
2. `emit!(LpPositionClosed{user: user.key, slot})` (1608-1611).
3. Exit `close` (0.7): `user.lamports += position.lamports` (checked; Anchor
   panics on overflow, which is unreachable); `position.lamports = 0`; owner →
   System; data_len → 0. The event comes **before** the close.

Lamports: position → user, the whole balance (rent plus any donation), by direct
arithmetic.

---

## 8. Cross-cutting subtleties

1. **No reentrancy surface.** The only CPIs go to the System program
   (CreateAccount, Transfer, Allocate, Assign). No untrusted program is ever
   invoked.
2. **Aliasing.** Distinct seeds make vault, v2_state and position distinct PDAs.
   `user` is a signer, so it cannot be a PDA. Anchor does no duplicate-account
   check in 0.31.1; none is needed here.
3. **Stored vs canonical bump.**
   - initialize_v2 and lp_deposit (first deposit) store the canonical bump from
     `find_program_address`.
   - Every other instruction re-derives with `create_program_address(seeds ++
     [stored bump])` and compares.
   - lp_deposit always uses `find_program_address`, even on existing positions.
4. **The vault is never written in these 7 instructions** (data unchanged). Only
   its lamports change: + in lp_deposit, − in complete_withdraw. There is no need
   to re-serialize it.
5. **Unit invariants relied on, never asserted:**
   - `total_units = seed + house + house_pending + Σ user(units + pending)`
   - `total_pending_units = Σ user pending`
   Checked math with 6008 is the only guard, so keep every `checked_*` exactly
   where it is.
6. **remaining_accounts** are unused by all seven.
7. **Instruction log line.** It must be emitted for all seven, including on paths
   that fail later.

---

## Open questions

1. **Error log lines.** Anchor logs `AnchorError caused by account: X. Error Code:
   ... Error Number: N. Error Message: ...` on failure. The spec only requires the
   numeric Custom(N) code. Does any client or indexer grep those logs? None of
   these seven are referenced by `/api/verify`.
2. **Bool-byte validation** (Vault.paused, VaultV2State.vrf_mode_enabled).
   - Anchor fails with 3003 on bytes > 1.
   - On the new program ID only 0 or 1 can ever be written, so this is
     unreachable.
   - Implementing it costs a few CU. Decision for the lead: implement or skip.
3. **Account data length.** Anchor accepts data_len ≥ 8 + body for vault and
   v2_state (it ignores extra bytes) and only enforces exact length (2019) on
   init_if_needed.
   - Proposal: `>=` checks for parity.
   - Confirm that the shared account loader in the other specs uses the same rule.
4. **Shared helpers.** `vault_assets`, `units_to_assets`, `calc_health_bps`,
   `user_units_total` and `enforce_*` (0.8) are also used by house-LP, start_game,
   settle and the VRF specs. They should be implemented once in a shared module.
   Their definitions here are normative only if the other specs agree.
5. **Rent sysvar.** `Rent::get()` is used both for vault_assets and for init.
   - RESOLVED by the critic (see CRITIC.md): live mainnet is 5080 lamports/byte,
     threshold 1.0, not 6960. pinocchio and solana-rent agree on it, and the RPC
     returned 2,824,480 for 428 bytes. What stays open is only the shared policy
     question (accept, or fail closed if the threshold ever leaves 1.0).

## F-fix deviations (2026-11-04, binding spec `FIXES.md`)

- F4: `complete_withdraw` no longer checks the user's signature (`user_lp_checks(.., user_signs = false)`; request/cancel unchanged) and, as the last check before the lamport move, requires `slot <= pending_unlock_slot + 9_000` (`WITHDRAW_CLAIM_WINDOW_SLOTS`), else 6056 `WithdrawWindowExpired`. A lapsed request is restarted with `[cancel_withdraw, request_withdraw]`.
