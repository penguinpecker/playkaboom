# Port spec: House LP instructions

Covers: `house_deposit`, `house_request_withdraw`, `house_cancel_withdraw`, `house_complete_withdraw`.

Source of truth: `programs/kaboom/src/lib.rs` @ e82f2c5 (handlers 1615-1728, helpers 1854-1941,
account structs 1971-2081, contexts 2665-2706, errors 2722-2828, events 2931-2958).
`vrf_mode.rs` has no house-LP code (only a comment at 162-172 about `deposit_to_units` with zero assets).
Anchor framework behaviour quoted from `anchor-syn-0.31.1` / `anchor-lang-0.31.1` in `~/.cargo/registry`.

New program ID `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`. Canonical PDAs under it
(computed with `solana find-program-derived-address`):

| PDA | seeds | address | canonical bump |
|---|---|---|---|
| vault | `[b"kaboom_vault"]` (lib.rs:129) | `7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7` | 254 |
| v2_state | `[b"kaboom_v2_state"]` (lib.rs:130) | `Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue` | 255 |

Both bumps are written as the canonical bump by their init instructions (`vault.bump = ctx.bumps.vault` lib.rs:168,
`v2.bump = ctx.bumps.v2_state` lib.rs:1326).

---

## 0. Shared definitions

### 0.1 Discriminators (sha256 prefix, all cross-checked equal to `target/idl/kaboom.json`)

| item | preimage | hex | decimal |
|---|---|---|---|
| ix house_deposit | `global:house_deposit` | `1f32a79706db5571` | `[31, 50, 167, 151, 6, 219, 85, 113]` |
| ix house_request_withdraw | `global:house_request_withdraw` | `bebd4c2ebd4c5a94` | `[190, 189, 76, 46, 189, 76, 90, 148]` |
| ix house_cancel_withdraw | `global:house_cancel_withdraw` | `a7afe00731ccb8a2` | `[167, 175, 224, 7, 49, 204, 184, 162]` |
| ix house_complete_withdraw | `global:house_complete_withdraw` | `d1e765c7cda1698e` | `[209, 231, 101, 199, 205, 161, 105, 142]` |
| account Vault | `account:Vault` | `d308e82b02987577` | `[211, 8, 232, 43, 2, 152, 117, 119]` |
| account VaultV2State | `account:VaultV2State` | `eefcdafd5966445e` | `[238, 252, 218, 253, 89, 102, 68, 94]` |
| event HouseDeposited | `event:HouseDeposited` | `ad71d71ae51ba3e7` | `[173, 113, 215, 26, 229, 27, 163, 231]` |
| event HouseWithdrawRequested | `event:HouseWithdrawRequested` | `fe1e163f066d7700` | `[254, 30, 22, 63, 6, 109, 119, 0]` |
| event HouseWithdrawCancelled | `event:HouseWithdrawCancelled` | `acb8bffabda91054` | `[172, 184, 191, 250, 189, 169, 16, 84]` |
| event HouseWithdrawCompleted | `event:HouseWithdrawCompleted` | `cdb31882b1c9ba09` | `[205, 179, 24, 130, 177, 201, 186, 9]` |

### 0.2 Account layouts used (byte offsets include the 8-byte discriminator)

`Vault` (lib.rs:1971-2000), `Vault::SPACE = 428` (lib.rs:1995-2001). Fields read here: `owner` and `bump` only.

| field | off | size |
|---|---|---|
| disc | 0 | 8 |
| owner: Pubkey | 8 | 32 |
| house_authority | 40 | 32 |
| treasury | 72 | 32 |
| bump: u8 | 104 | 1 |
| house_edge_bps..treasury_split_bps (4 x u16) | 105 | 8 |
| total_games, total_wagered, total_payouts (3 x u64) | 113 | 24 |
| paused: bool | 137 | 1 |
| version: u8 | 138 | 1 |
| allowlist_count: u8 | 139 | 1 |
| withdraw_allowlist: [Pubkey; 8] (MAX_ALLOWLIST lib.rs:81) | 140 | 256 |
| pending_owner | 396 | 32 |
| end | 428 | |

`VaultV2State` (lib.rs:2009-2072), `VaultV2State::SPACE = 191` (lib.rs:2074-2081). All integers little-endian.

| field | off | size | used here |
|---|---|---|---|
| disc | 0 | 8 | check |
| bump: u8 | 8 | 1 | seeds |
| total_outstanding_max_payout: u64 | 9 | 8 | no |
| total_units: u128 | 17 | 16 | R/W |
| house_units: u128 | 33 | 16 | R/W |
| house_pending_units: u128 | 49 | 16 | R/W |
| house_pending_unlock_slot: u64 | 65 | 8 | R/W |
| seed_units: u128 | 73 | 16 | R |
| total_pending_units: u128 | 89 | 16 | no |
| min_house_share_bps: u16 | 105 | 2 | R |
| max_user_position_bps: u16 | 107 | 2 | no |
| min_health_bps: u16 | 109 | 2 | no |
| withdraw_cooldown_slots: u64 | 111 | 8 | R |
| min_lp_deposit: u64 | 119 | 8 | no (NOT applied to house_deposit) |
| vrf_mode_enabled: bool | 127 | 1 | no |
| vrf_validator: Pubkey | 128 | 32 | no |
| vrf_max_payout_bps: u16 | 160 | 2 | no |
| _reserved: [u8; 29] | 162 | 29 | no |
| end | 191 | | |

u128 fields sit at odd offsets: read/write with `u128::from_le_bytes` / `to_le_bytes` (no aligned pointer casts).

### 0.3 Error codes used

Custom (`6000 + index`, lib.rs:2722-2828, cross-checked with IDL):
`Unauthorized = 6007`, `MathOverflow = 6008`, `InvalidAmount = 6009`, `HouseShareFloorBreached = 6033`,
`PendingWithdrawAlreadyExists = 6035`, `NoPendingWithdraw = 6036`, `CooldownNotElapsed = 6037`,
`InsufficientUnits = 6038`, `InsufficientLiquidity = 6039`.

Anchor framework (anchor-lang-0.31.1 `src/error.rs`):
`InstructionDidNotDeserialize = 102`, `ConstraintMut = 2000`, `ConstraintSeeds = 2006`,
`AccountDiscriminatorNotFound = 3001`, `AccountDiscriminatorMismatch = 3002`, `AccountDidNotDeserialize = 3003`,
`AccountNotEnoughKeys = 3005`, `AccountOwnedByWrongProgram = 3007`, `InvalidProgramId = 3008`,
`InvalidProgramExecutable = 3009`, `AccountNotSigner = 3010`, `AccountNotInitialized = 3012`.
All return as `ProgramError::Custom(code)`.

### 0.4 Helpers (port 1:1)

**`vault_assets(vault)`** (lib.rs:1854-1857):
```
rent = Rent::get()?.minimum_balance(Vault::SPACE /*428*/)
return vault.lamports().saturating_sub(rent)      // u64, saturating
```
Pinocchio: `Rent::get()?.try_minimum_balance(428)?`. Pinocchio 0.11.2 computes `(128 + len) * lamports_per_byte`
and ignores `exemption_threshold`; Anchor/solana-rent computes `((128+len)*lamports_per_byte_year) as f64 * exemption_threshold`.
These agree only while `exemption_threshold == 1.0`. Mainnet Rent sysvar read on 2026-11-04 (read-only RPC):
`lamports_per_byte_year = 5080`, `exemption_threshold = 1.0`, `burn_percent = 50` -> both give
`556 * 5080 = 2_824_480` lamports for 428 bytes. See open question 1.

**`deposit_to_units(amount: u64, vault_assets_pre: u64, total_units: u128) -> u128`** (lib.rs:1861-1870):
```
if total_units == 0 { return amount as u128 }                       // 1862-1864
require!(vault_assets_pre > 0, MathOverflow)                         // 1865
(amount as u128).checked_mul(total_units)  else MathOverflow         // 1866-1868
    .checked_div(vault_assets_pre as u128) else MathOverflow         // 1869 (cannot fail, divisor > 0)
```

**`units_to_assets(units: u128, vault_assets: u64, total_units: u128) -> u64`** (lib.rs:1873-1883):
```
if total_units == 0 || units == 0 { return 0 }
v = units.checked_mul(vault_assets as u128) else MathOverflow
      .checked_div(total_units) else MathOverflow
u64::try_from(v) else MathOverflow
```

**`user_units_total(v2) -> u128`** (lib.rs:1885-1891):
```
v2.total_units.checked_sub(v2.seed_units)
  .checked_sub(v2.house_units)
  .checked_sub(v2.house_pending_units)      // any underflow -> MathOverflow
```

**`enforce_house_floor(house_units_after: u128, user_units_total_after: u128, min_house_share_bps: u16)`** (lib.rs:1920-1942):
```
if min_house_share_bps == 0 { return Ok }                            // 1925-1927
denom = house_units_after.checked_add(user_units_total_after) else MathOverflow   // 1928-1930
if denom == 0 { return Ok }                                          // 1931-1933
lhs = house_units_after.checked_mul(10_000) else MathOverflow        // 1934-1936 (BPS lib.rs:53)
rhs = (min_house_share_bps as u128).checked_mul(denom) else MathOverflow  // 1937-1939
require!(lhs >= rhs, HouseShareFloorBreached)                        // 1940
```
These helpers are shared with lp_* instructions; implement once.

### 0.5 Event emission (Anchor `emit!`, anchor-attribute-event-0.31.1 lib.rs:106)
One `sol_log_data` call with ONE slice: `disc(8) ++ borsh(fields in declaration order, LE)`.
Runtime prints `Program data: <base64>`. Pinocchio: build a stack `[u8; N]` and call `sol_log_data(&[&buf])`.

### 0.6 Anchor wrapper order (anchor-syn-0.31.1 `codegen/program/handlers.rs:116-161`, `codegen/accounts/try_accounts.rs:121-171`)
For every instruction below, in this exact order:
1. Dispatcher matched the 8-byte discriminator and passes `data[8..]` (dispatch.rs:23).
2. `msg!("Instruction: <PascalName>")` -> `Program log: Instruction: <PascalName>`. Emitted BEFORE any validation,
   so it appears even when the instruction later fails.
3. Borsh-deserialize args with `deserialize(&mut &data[..])` (NOT `try_from_slice`): too short -> 102
   `InstructionDidNotDeserialize`; trailing bytes are ignored.
4. Deserialize EVERY account field in declaration order (type checks only, section "implicit checks").
   Missing account -> 3005 `AccountNotEnoughKeys`.
5. THEN run constraints field by field in declaration order; within a field the order is
   (constraints.rs `linearize`): `seeds` -> `mut` -> `signer` -> `has_one` -> raw `constraint` -> owner -> ...
6. Handler body.
7. Exit: every `mut` `Account<T>` owned by this program is re-serialized into its data (account.rs:252-265).
   For the four handlers here this equals writing just the changed v2 fields in place (vault data unchanged).
Extra accounts beyond the declared list become `remaining_accounts` and are ignored (none of these handlers read them).
Anchor 0.31.1 has NO duplicate-mutable-account check (grep for `DuplicateMutable` in anchor-lang/anchor-syn 0.31.1 finds nothing),
so the port must not add one.

`Account<T>::try_from` (account.rs:303-313), applied to `vault` (T=Vault) and `v2_state` (T=VaultV2State), in this order:
a. `owner == SystemProgram && lamports == 0` -> 3012 `AccountNotInitialized`
b. `owner != program_id` -> 3007 `AccountOwnedByWrongProgram`
c. `data.len() < 8` -> 3001 `AccountDiscriminatorNotFound`
d. `data[..8] != DISC` -> 3002 `AccountDiscriminatorMismatch`
e. Borsh deserialize of the body fails -> 3003 `AccountDidNotDeserialize`. In practice: `data.len() < SPACE`
   (428 for Vault, 191 for VaultV2State), or a `bool` byte that is not 0/1 (Vault.paused @137,
   VaultV2State.vrf_mode_enabled @127). Port: require `data.len() >= SPACE` -> 3003. The bool-byte check is cheap
   (one compare each); include it for exact parity. Accounts on the new program ID are only written by this program,
   so it only matters for parity.

`Signer::try_from` (signer.rs:49-54): `!is_signer` -> 3010 `AccountNotSigner`.

`Program<System>::try_from` (program.rs:130-139): key != `11111111111111111111111111111111` -> 3008 `InvalidProgramId`;
`!executable` -> 3009 `InvalidProgramExecutable`.

Seeds constraint with a stored bump (constraints.rs:1180-1192):
`pda = create_program_address(&[SEED, &[stored_bump]], program_id)`; error (off-curve result) -> 2006; `key != pda` -> 2006.
`stored_bump` is read from the account's own data (vault @104, v2_state @8) after step 4.

`mut` constraint (constraints.rs:286-295): `!is_writable` -> 2000 `ConstraintMut`.

Raw constraint `constraint = X @ KaboomError::E` (constraints.rs:348-356): `!X` -> custom E.

---

## 1. house_deposit

- Rust name `house_deposit`, log line `Program log: Instruction: HouseDeposit`
- Discriminator `1f32a79706db5571` = `[31, 50, 167, 151, 6, 219, 85, 113]`
- Handler lib.rs:1617-1652, context `HouseDepositCtx` lib.rs:2665-2689

### Args (Borsh, after the 8-byte discriminator)
| field | type | bytes | offset in data |
|---|---|---|---|
| amount | u64 LE | 8 | 8..16 |

`data.len() < 16` -> 102. Trailing bytes ignored.

### Accounts (exact order; matches IDL)
| # | name | signer | writable | optional | constraints |
|---|---|---|---|---|---|
| 0 | vault | no | yes | no | `Account<Vault>` (implicit a-e); `seeds = [b"kaboom_vault"], bump = vault.bump` -> 2006; `mut` -> 2000; `constraint = vault.owner == owner.key() @ Unauthorized` -> 6007 (lib.rs:2674-2680) |
| 1 | v2_state | no | yes | no | `Account<VaultV2State>` (implicit a-e); `seeds = [b"kaboom_v2_state"], bump = v2_state.bump` -> 2006; `mut` -> 2000 (lib.rs:2682-2683) |
| 2 | owner | yes | yes | no | `Signer` -> 3010; `mut` -> 2000 (lib.rs:2685-2686) |
| 3 | system_program | no | no | no | `Program<System>`: address `11111111111111111111111111111111` -> 3008, executable -> 3009 (lib.rs:2688) |

The comment at lib.rs:2666-2673 explains `vault` is `mut` on purpose (it receives the CPI transfer). Keep it.

Validation order (per 0.6): deser vault(a-e) -> deser v2_state(a-e) -> owner signer(3010) -> system_program(3008, 3009)
-> vault seeds(2006) -> vault mut(2000) -> vault.owner == owner(6007) -> v2_state seeds(2006) -> v2_state mut(2000)
-> owner mut(2000).

### Handler steps
1. `require!(amount > 0, InvalidAmount)` -> 6009. (1618)
2. `assets_pre: u64 = vault_assets(vault)` = `vault.lamports.saturating_sub(rent_min(428))`. (1619-1620)
3. `total_units_pre: u128 = v2.total_units`. (1621)
4. `units_minted: u128 = deposit_to_units(amount, assets_pre, total_units_pre)?` (1622):
   if `total_units_pre == 0` -> `amount as u128`; else `require!(assets_pre > 0, MathOverflow)`, then
   `amount * total_units_pre / assets_pre` (checked mul -> MathOverflow; floor div).
5. `require!(units_minted > 0, MathOverflow)` -> 6008. (1623)
6. CPI System Program `Transfer` (ix index 2, data `[2,0,0,0] ++ amount u64 LE`), accounts
   `[owner (signer, writable), vault (writable)]`, `amount` lamports, no PDA signer seeds. (1625-1634)
   Failures propagate the System Program error unchanged (e.g. insufficient funds -> `Custom(1)`;
   `owner` not system-owned or carrying data -> system program error). Pinocchio: `pinocchio_system::instructions::Transfer { from: owner, to: vault, lamports: amount }.invoke()?`.
   NOTE: units were priced on assets BEFORE the transfer (step 2) - keep that order.
7. `v2.total_units = total_units_pre.checked_add(units_minted)` else MathOverflow. (1636-1639)
8. `v2.house_units = v2.house_units.checked_add(units_minted)` else MathOverflow. (1640-1643)
   (Write order 7 then 8; if 8 fails the tx reverts anyway.)
9. `slot = Clock::get()?.slot` (1649), emit `HouseDeposited` (1645-1650):
   `disc ad71d71ae51ba3e7 ++ amount_lamports: u64 = amount ++ units_minted: u128 ++ total_units_after: u128 = v2.total_units (new) ++ slot: u64`
   -> 8 + 8 + 16 + 16 + 8 = 56 bytes.
10. Exit: write v2 fields (`total_units` @17, `house_units` @33). Vault data unchanged.

NOT checked (parity - do not add): `vault.paused`, `min_lp_deposit`, house floor, user cap, health floor, `v2_state` initialized
flag beyond the disc/owner checks.

---

## 2. house_request_withdraw

- Rust name `house_request_withdraw`, log line `Program log: Instruction: HouseRequestWithdraw`
- Discriminator `bebd4c2ebd4c5a94` = `[190, 189, 76, 46, 189, 76, 90, 148]`
- Handler lib.rs:1654-1677, context `HouseLpAction` lib.rs:2691-2706

### Args
| field | type | bytes | offset in data |
|---|---|---|---|
| units | u128 LE | 16 | 8..24 |

`data.len() < 24` -> 102.

### Accounts (`HouseLpAction`, exact order; matches IDL)
| # | name | signer | writable | optional | constraints |
|---|---|---|---|---|---|
| 0 | vault | no | yes | no | `Account<Vault>` (a-e); `seeds = [b"kaboom_vault"], bump = vault.bump` -> 2006; `mut` -> 2000; `vault.owner == owner.key() @ Unauthorized` -> 6007 (lib.rs:2693-2699) |
| 1 | v2_state | no | yes | no | `Account<VaultV2State>` (a-e); `seeds = [b"kaboom_v2_state"], bump = v2_state.bump` -> 2006; `mut` -> 2000 (lib.rs:2701-2702) |
| 2 | owner | yes | yes | no | `Signer` -> 3010; `mut` -> 2000 (lib.rs:2704-2705) |

No system program. `vault` and `owner` must be writable even though this handler moves no lamports (Anchor enforces
`mut` -> 2000). Validation order: deser vault -> deser v2 -> owner signer -> vault seeds -> vault mut -> vault.owner
-> v2 seeds -> v2 mut -> owner mut.

### Handler steps
1. `require!(v2.house_pending_units == 0, PendingWithdrawAlreadyExists)` -> 6035. (1656)
2. `require!(units > 0, InvalidAmount)` -> 6009. (1657)
3. `require!(units <= v2.house_units, InsufficientUnits)` -> 6038. (1658)
4. `house_after: u128 = v2.house_units.checked_sub(units)` else MathOverflow (unreachable after 3). (1662)
5. `user_total: u128 = user_units_total(v2)?` computed on the PRE-write state
   (`total_units - seed_units - house_units(old) - house_pending_units(=0)`, each checked -> MathOverflow). (1663)
6. `enforce_house_floor(house_after, user_total, v2.min_house_share_bps)?` -> 6033 / 6008. (1664)
   The pending units are excluded from the numerator AND denominator (comment 1660-1661).
7. `v2.house_units = house_after`. (1666)
8. `v2.house_pending_units = units`. (1667)
9. `unlock: u64 = Clock::get()?.slot.saturating_add(v2.withdraw_cooldown_slots)` (saturating, not checked). (1668)
10. `v2.house_pending_unlock_slot = unlock`. (1669)
11. Emit `HouseWithdrawRequested` (1671-1675):
    `disc fe1e163f066d7700 ++ units: u128 ++ unlock_slot: u64 = unlock ++ slot: u64 = Clock::get()?.slot`
    -> 8 + 16 + 8 + 8 = 40 bytes. Anchor calls `Clock::get()` twice; within one tx both return the same slot, so reading
    the clock once and reusing it is byte-identical.
12. Exit: write `house_units` @33, `house_pending_units` @49, `house_pending_unlock_slot` @65.

No lamport movement, no CPI.

---

## 3. house_cancel_withdraw

- Rust name `house_cancel_withdraw`, log line `Program log: Instruction: HouseCancelWithdraw`
- Discriminator `a7afe00731ccb8a2` = `[167, 175, 224, 7, 49, 204, 184, 162]`
- Handler lib.rs:1679-1692, context `HouseLpAction` lib.rs:2691-2706

### Args
None. Instruction data is just the 8-byte discriminator; trailing bytes are ignored (Anchor deserializes a unit struct).

### Accounts
Identical to section 2 (`HouseLpAction`): `vault (w)`, `v2_state (w)`, `owner (s, w)`, same constraints, errors and order.

### Handler steps
1. `require!(v2.house_pending_units > 0, NoPendingWithdraw)` -> 6036. (1681)
2. `units: u128 = v2.house_pending_units`. (1682)
3. `v2.house_units = v2.house_units.checked_add(units)` else MathOverflow. (1683)
4. `v2.house_pending_units = 0`. (1684)
5. `v2.house_pending_unlock_slot = 0`. (1685)
6. Emit `HouseWithdrawCancelled` (1687-1690):
   `disc acb8bffabda91054 ++ units_returned: u128 = units ++ slot: u64 = Clock::get()?.slot` -> 8 + 16 + 8 = 32 bytes.
7. Exit: write `house_units` @33, `house_pending_units` @49, `house_pending_unlock_slot` @65.

No floor check (returning units only raises house share), no cooldown check, no lamport movement, no CPI.

---

## 4. house_complete_withdraw

- Rust name `house_complete_withdraw`, log line `Program log: Instruction: HouseCompleteWithdraw`
- Discriminator `d1e765c7cda1698e` = `[209, 231, 101, 199, 205, 161, 105, 142]`
- Handler lib.rs:1694-1728, context `HouseLpAction` lib.rs:2691-2706

### Args
None (8-byte discriminator only; trailing bytes ignored).

### Accounts
Identical to section 2 (`HouseLpAction`). Here `vault` writable is load-bearing (debited) and `owner` writable is
load-bearing (credited).

### Handler steps
1. `require!(v2.house_pending_units > 0, NoPendingWithdraw)` -> 6036. (1696)
2. `now: u64 = Clock::get()?.slot`. (1697)
3. `require!(now >= v2.house_pending_unlock_slot, CooldownNotElapsed)` -> 6037. (1698)
4. `units: u128 = v2.house_pending_units`. (1700)
5. `assets_pre: u64 = vault_assets(vault)` (lamports minus rent-min(428), saturating). (1701-1702)
6. `assets_out: u64 = units_to_assets(units, assets_pre, v2.total_units)?` using `total_units` BEFORE the burn
   (`units * assets_pre / total_units`, floor; checked mul/div; u64 conversion -> MathOverflow; 0 if total_units == 0). (1703)
7. `require!(assets_out <= assets_pre, InsufficientLiquidity)` -> 6039. (1704)
8. `v2.house_pending_units = 0`. (1706)
9. `v2.house_pending_unlock_slot = 0`. (1707)
10. `v2.total_units = v2.total_units.checked_sub(units)` else MathOverflow. (1708)
    `house_units` is NOT touched (the units already left it at request time).
11. If `assets_out > 0` (1710-1720), direct lamport arithmetic (no CPI; vault is program-owned):
    - `vault.lamports = vault.lamports.checked_sub(assets_out)` else MathOverflow (1711-1714)
    - `owner.lamports = owner.lamports.checked_add(assets_out)` else MathOverflow (1715-1719)
    Order: debit vault first, then credit owner. Pinocchio: `set_lamports` / `try_borrow_mut_lamports` equivalents
    with `checked_sub` / `checked_add` -> 6008.
    If `assets_out == 0` no lamports move, but state is still cleared and the event still emits.
12. Emit `HouseWithdrawCompleted` (1722-1726):
    `disc cdb31882b1c9ba09 ++ units_burned: u128 = units ++ amount_lamports: u64 = assets_out ++ slot: u64 = Clock::get()?.slot`
    -> 8 + 16 + 8 + 8 = 40 bytes. (Reuse `now` from step 2: same slot.)
13. Exit: write `house_pending_units` @49, `house_pending_unlock_slot` @65, `total_units` @17. Vault data unchanged.

NOT checked (parity - do not add): `vault.paused`, `min_health_bps` / `total_outstanding_max_payout` (house can withdraw
liquidity that backs open games), house floor (it was checked at request time), user cap.

---

## 5. Subtleties

1. **Rent-exempt floor of the vault.** `assets_out <= assets_pre = lamports - rent_min(428)`, so the vault never drops
   below rent-exempt after step 11 and the runtime's post-tx rent check passes. Pinocchio must use the same `Vault::SPACE`
   (428), not the actual data length, exactly as lib.rs:1855 does. Today they are equal.
2. **Rent formula divergence** (see 0.4): only safe while mainnet `exemption_threshold == 1.0` (true on 2026-11-04).
3. **Pricing vs. transfer order in house_deposit.** Units are priced on pre-transfer assets; the CPI happens after
   pricing but before the state write. After the CPI the vault `AccountView` lamports already reflect the transfer
   (shared runtime memory); no reload needed, and nothing after the CPI reads vault lamports.
4. **Zero-asset trap** (vrf_mode.rs:162-172): when `total_units > 0` and vault assets are 0, `deposit_to_units` fails with
   MathOverflow (6008). Preserve; it is relied on to explain `admin_spendable`.
5. **Floor-div rounding** goes against the depositor (step 4 of deposit) and against the withdrawer (step 6 of complete).
   `units_minted == 0` is rejected with MathOverflow, not InvalidAmount.
6. **No reentrancy surface.** Only CPI is System `Transfer` into the vault; no program-owned data is read after it.
7. **No close / init / init_if_needed / realloc** in these four instructions. No remaining_accounts use.
8. **Clock.** Anchor uses `Clock::get()` (syscall), not a sysvar account; port with `Clock::get()`, no extra account.
   One read per handler is enough.
9. **Seeds check cost.** `create_program_address` with the stored bump costs ~1.5k CU per PDA (x2 here). Not a hot path
   (owner-only, rare). Either form is acceptable: the const compare in shared.md §0 / vault-admin.md §0.4
   (`key == VAULT_PDA && data[104] == 254`, `key == V2_PDA && data[8] == 255`, else 2006) accepts and rejects the same
   inputs, because no program-owned Vault/VaultV2State can exist at a non-canonical bump. Use whichever the shared
   loader uses, so all instructions behave the same.
10. **u128 at odd offsets** (17, 33, 49, 73, 89): never cast to `&u128`; use byte copies.
11. **Signer `owner` is a Squads vault** in production; System `Transfer` from a PDA-signer works because Squads signs via
    CPI. No change needed.

---

## 6. Open questions

1. Rent: accept pinocchio's `try_minimum_balance` (threshold-agnostic) given mainnet `exemption_threshold == 1.0`,
   or read the full 17-byte Rent sysvar and fail-closed if `exemption_threshold != 1.0`? Affects every `vault_assets`
   caller, not just these four; should be one decision in the shared helper.
2. Bool-byte parity (Vault.paused @137, VaultV2State.vrf_mode_enabled @127 must be 0/1, else 3003): include in the shared
   account loader for all instructions or skip? Recommended include (2 compares).
3. Should the account loaders be shared across all specs (vault/v2_state load + seeds + mut + owner check order)? This
   spec assumes one shared `load_vault_v2(...)` helper that reproduces the 0.6 order exactly.
