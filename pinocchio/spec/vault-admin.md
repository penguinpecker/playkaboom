# Port spec: Vault + admin instructions

Covers: `initialize_vault`, `fund_vault`, `withdraw_to_treasury`, `unlock_operator_position`, `update_vault`,
`allowlist_add`, `allowlist_remove`, `propose_owner`, `cancel_proposed_owner`, `accept_ownership`.

Source of truth: `programs/kaboom/src/lib.rs` @ e82f2c5 (handlers 148-214 and 948-1301, helpers 1873-1918,
account structs 1971-2081, contexts 2241-2273 and 2499-2564, errors 2711-2824, events 2828-2994).
`vrf_mode.rs` has no code for these ten instructions (it only re-uses `units_to_assets` / `enforce_min_health`, vrf_mode.rs:43).
Anchor framework behaviour quoted from `anchor-syn-0.31.1` / `anchor-lang-0.31.1` / `anchor-attribute-account-0.31.1`
in `~/.cargo/registry` (paths given as `anchor-syn:<file>:<line>`).

New program ID `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`
(bytes `[202,148,145,251,231,149,86,137,159,250,41,5,190,83,153,217,244,108,239,7,59,8,204,233,134,154,91,250,140,0,162,192]`).

| PDA | seeds | address | canonical bump | bytes |
|---|---|---|---|---|
| vault | `[b"kaboom_vault"]` (lib.rs:129) | `7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7` | 254 | `[98,120,93,48,42,54,14,64,99,64,112,81,226,72,19,58,91,111,62,157,108,231,77,142,21,158,223,85,213,57,40,48]` |
| v2_state | `[b"kaboom_v2_state"]` (lib.rs:130) | `Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue` | 255 | `[236,33,108,217,71,57,26,201,34,44,231,127,95,227,178,114,165,125,193,151,187,141,239,156,244,223,88,201,150,157,32,143]` |

(Computed with `solana find-program-derived-address <ID> string:<seed> --output json`; same table as house.md.)

---

## 0. Shared definitions

### 0.1 Discriminators (sha256 prefix; every one cross-checked equal to `target/idl/kaboom.json`)

| item | preimage | hex | decimal |
|---|---|---|---|
| ix initialize_vault | `global:initialize_vault` | `30bfa32c47813fa4` | `[48, 191, 163, 44, 71, 129, 63, 164]` |
| ix fund_vault | `global:fund_vault` | `1a21cff2776c8649` | `[26, 33, 207, 242, 119, 108, 134, 73]` |
| ix withdraw_to_treasury | `global:withdraw_to_treasury` | `f58495772bffaf3f` | `[245, 132, 149, 119, 43, 255, 175, 63]` |
| ix unlock_operator_position | `global:unlock_operator_position` | `4eb3c9ab2955f6a2` | `[78, 179, 201, 171, 41, 85, 246, 162]` |
| ix update_vault | `global:update_vault` | `43e5b9bce20bd23c` | `[67, 229, 185, 188, 226, 11, 210, 60]` |
| ix allowlist_add | `global:allowlist_add` | `2a05819f37a567cb` | `[42, 5, 129, 159, 55, 165, 103, 203]` |
| ix allowlist_remove | `global:allowlist_remove` | `1e1453d2bc9bd3a3` | `[30, 20, 83, 210, 188, 155, 211, 163]` |
| ix propose_owner | `global:propose_owner` | `5a398d6ec4f1ac27` | `[90, 57, 141, 110, 196, 241, 172, 39]` |
| ix cancel_proposed_owner | `global:cancel_proposed_owner` | `4b46c56903a4c4a6` | `[75, 70, 197, 105, 3, 164, 196, 166]` |
| ix accept_ownership | `global:accept_ownership` | `ac172b0deed55596` | `[172, 23, 43, 13, 238, 213, 85, 150]` |
| account Vault | `account:Vault` | `d308e82b02987577` | `[211, 8, 232, 43, 2, 152, 117, 119]` |
| account VaultV2State | `account:VaultV2State` | `eefcdafd5966445e` | `[238, 252, 218, 253, 89, 102, 68, 94]` |
| event VaultInitialized | `event:VaultInitialized` | `b42bcf021247034b` | `[180, 43, 207, 2, 18, 71, 3, 75]` |
| event VaultFunded | `event:VaultFunded` | `c077f5c137dfc332` | `[192, 119, 245, 193, 55, 223, 195, 50]` |
| event VaultUpdated | `event:VaultUpdated` | `5dbb91d886c90369` | `[93, 187, 145, 216, 134, 201, 3, 105]` |
| event OwnerProposed | `event:OwnerProposed` | `4c62c01e44302bbc` | `[76, 98, 192, 30, 68, 48, 43, 188]` |
| event OwnerProposalCancelled | `event:OwnerProposalCancelled` | `2aa4695d77b359e9` | `[42, 164, 105, 93, 119, 179, 89, 233]` |
| event OwnerAccepted | `event:OwnerAccepted` | `733141b7487b298b` | `[115, 49, 65, 183, 72, 123, 41, 139]` |
| event AllowlistChanged | `event:AllowlistChanged` | `bcd3683729aa532f` | `[188, 211, 104, 55, 41, 170, 83, 47]` |
| event TreasuryWithdrawal | `event:TreasuryWithdrawal` | `f475af2ebb6d1410` | `[244, 117, 175, 46, 187, 109, 20, 16]` |
| event OperatorUnitsUnlocked | `event:OperatorUnitsUnlocked` | `f58617c78374fbe5` | `[245, 134, 23, 199, 131, 116, 251, 229]` |

Reproduce: `python3 -c "import hashlib;print(hashlib.sha256(b'global:fund_vault').digest()[:8].hex())"`.

### 0.2 Account layouts (offsets include the 8-byte discriminator; Borsh = packed, little-endian, no padding)

`Vault` (lib.rs:1971-1993), `Vault::SPACE = 428` (lib.rs:1995-2003).

| field | off | size | notes |
|---|---|---|---|
| disc | 0 | 8 | `d308e82b02987577` |
| owner: Pubkey | 8 | 32 | |
| house_authority: Pubkey | 40 | 32 | |
| treasury: Pubkey | 72 | 32 | |
| bump: u8 | 104 | 1 | 254 under the new ID |
| house_edge_bps: u16 | 105 | 2 | |
| max_bet_bps: u16 | 107 | 2 | |
| max_payout_bps: u16 | 109 | 2 | |
| treasury_split_bps: u16 | 111 | 2 | |
| total_games: u64 | 113 | 8 | |
| total_wagered: u64 | 121 | 8 | |
| total_payouts: u64 | 129 | 8 | |
| paused: bool | 137 | 1 | Borsh: byte must be 0/1 |
| version: u8 | 138 | 1 | |
| allowlist_count: u8 | 139 | 1 | |
| withdraw_allowlist: [Pubkey; 8] | 140 | 256 | entry i at `140 + 32*i` (MAX_ALLOWLIST = 8, lib.rs:81) |
| pending_owner: Pubkey | 396 | 32 | zero = none |
| end | 428 | | |

`VaultV2State` (lib.rs:2009-2072), `VaultV2State::SPACE = 191` (lib.rs:2075-2082). Only `unlock_operator_position` touches it.

| field | off | size | used by unlock_operator_position |
|---|---|---|---|
| disc | 0 | 8 | check `eefcdafd5966445e` |
| bump: u8 | 8 | 1 | seeds (255) |
| total_outstanding_max_payout: u64 | 9 | 8 | R |
| total_units: u128 | 17 | 16 | R/W |
| house_units: u128 | 33 | 16 | R/W (zeroed) |
| house_pending_units: u128 | 49 | 16 | R/W (zeroed) |
| house_pending_unlock_slot: u64 | 65 | 8 | W (zeroed) |
| seed_units: u128 | 73 | 16 | R/W (zeroed) |
| total_pending_units: u128 | 89 | 16 | R |
| min_house_share_bps: u16 | 105 | 2 | no |
| max_user_position_bps: u16 | 107 | 2 | no |
| min_health_bps: u16 | 109 | 2 | R |
| withdraw_cooldown_slots: u64 | 111 | 8 | no |
| min_lp_deposit: u64 | 119 | 8 | no |
| vrf_mode_enabled: bool | 127 | 1 | no (Borsh: byte must be 0/1) |
| vrf_validator: Pubkey | 128 | 32 | no |
| vrf_max_payout_bps: u16 | 160 | 2 | no |
| _reserved: [u8; 29] | 162 | 29 | no |
| end | 191 | | |

All multi-byte fields sit at odd/unaligned offsets: use `from_le_bytes` / `to_le_bytes` on byte slices, never aligned pointer casts.

### 0.3 Error codes

Custom (`6000 + enum index`, lib.rs:2711-2824, cross-checked with IDL `errors`):

| code | hex | variant | lib.rs |
|---|---|---|---|
| 6007 | 0x1777 | Unauthorized | 2727 |
| 6008 | 0x1778 | MathOverflow | 2729 |
| 6009 | 0x1779 | InvalidAmount | 2731 |
| 6010 | 0x177a | InvalidConfig | 2733 |
| 6024 | 0x1788 | DestinationNotAllowlisted | 2761 |
| 6025 | 0x1789 | AllowlistFull | 2763 |
| 6026 | 0x178a | AlreadyAllowlisted | 2765 |
| 6027 | 0x178b | AddressNotInAllowlist | 2767 |
| 6028 | 0x178c | NoPendingOwner | 2769 |
| 6034 | 0x1792 | HealthFloorBreached | 2782 |
| 6039 | 0x1797 | InsufficientLiquidity | 2792 |
| 6041 | 0x1799 | NoOperatorUnitsToUnlock | 2796 |

Anchor framework (anchor-lang-0.31.1 `src/error.rs`, computed from the enum):
`InstructionFallbackNotFound = 101`, `InstructionDidNotDeserialize = 102`, `ConstraintMut = 2000`,
`ConstraintRentExempt = 2005`, `ConstraintSeeds = 2006`, `AccountDiscriminatorNotFound = 3001`,
`AccountDiscriminatorMismatch = 3002`, `AccountDidNotDeserialize = 3003`, `AccountNotEnoughKeys = 3005`,
`AccountOwnedByWrongProgram = 3007`, `InvalidProgramId = 3008`, `InvalidProgramExecutable = 3009`,
`AccountNotSigner = 3010`, `AccountNotInitialized = 3012`, `DeclaredProgramIdMismatch = 4100`,
`TryingToInitPayerAsProgramAccount = 4101`.

Every error (custom and framework) is returned as `ProgramError::Custom(code)`. Errors from system-program CPIs
propagate unchanged (e.g. `Custom(0)` AccountAlreadyInUse from Allocate/CreateAccount, `Custom(1)` ResultWithNegativeLamports
from Transfer). Clients only need the numeric code: `apps/web/src/lib/program-errors.ts:88-95` and
`packages/sdk/src/errors.ts:157-175` fall back to `"Custom":N` / `custom program error: 0xN`, so Anchor's
`AnchorError ... Error Number:` log line need not be reproduced (optional; framework-error account names are only cosmetic).

### 0.4 Anchor wrapper order (applies to every instruction here)

From `anchor-syn:codegen/program/handlers.rs:104-160` and `codegen/accounts/try_accounts.rs`:

1. Entry: `program_id != ID` -> 4100 (entry.rs:51-53). Dispatch by `data.starts_with(disc)`; no match -> 101
   (dispatch.rs:59). Data shorter than 8 bytes never matches.
2. `msg!("Instruction: <PascalCase>")` — logged BEFORE anything else (handlers.rs:124-125). Pinocchio: `pinocchio::log::sol_log("Instruction: X")`.
3. Borsh-deserialize args from `data[8..]` with `BorshDeserialize::deserialize(&mut &data[..])`:
   short data -> 102; **trailing bytes are ignored** (not `try_from_slice`). Borsh 0.10.3: `bool` byte not 0/1 -> 102;
   `Option` tag not 0/1 -> 102.
4. Accounts, **phase A (deserialize, in field order)**: missing account -> 3005; for each field:
   - `Account<T>` (anchor-lang `accounts/account.rs:303-313`): `owner == SystemProgram && lamports == 0` -> 3012;
     `owner != program_id` -> 3007; `data_len < 8` -> 3001; `data[0..8] != disc` -> 3002;
     Borsh body decode fails (data shorter than SPACE, or a `bool` byte > 1) -> 3003. Longer data is accepted.
   - `Signer` -> `!is_signer` -> 3010.
   - `Program<System>` -> `key != 11111111111111111111111111111111` -> 3008; `!executable` -> 3009.
   - `UncheckedAccount` -> nothing.
   - `init` fields are only taken as a raw AccountInfo here (try_accounts.rs:35-56).
5. Accounts, **phase B (constraints)**: first all `init` fields, then every other field in declaration order
   (try_accounts.rs `generate_constraints`). Per field, order is (constraints.rs:71-131):
   Init -> Seeds -> Mut -> Signer -> HasOne -> Raw(`constraint =`) -> Owner -> RentExempt -> ... -> Address.
   - Seeds with `bump = <stored>` (constraints.rs:1133-1188): `create_program_address(seeds ++ [stored_bump])`;
     error (on-curve) -> 2006; `key != derived` -> 2006.
   - Mut: `!is_writable` -> 2000.
   - Raw `constraint = X @ E` -> `Custom(E)`.
6. Handler body.
7. Exit: every `mut` `Account<T>` is re-serialized (disc + Borsh) into its data (exit.rs:47-60,
   account.rs:252-265). Pinocchio writes fields in place instead; equivalent because any later error reverts the tx.
8. Extra accounts beyond the struct are ignored (`remaining_accounts`, unused by all ten handlers). Pinocchio must
   accept `accounts.len() >= N`, not `== N`.

**Seeds check, cheap equivalent (recommended):** because the program ID and seeds are constant,
`create_program_address([b"kaboom_vault", [b]]) == key` holds iff `key == VAULT_PDA && b == 254`
(any other bump derives a different address or fails). So for `seeds = [VAULT_SEED], bump = vault.bump`:
`if key != VAULT_PDA || data[104] != 254 { Custom(2006) }`. Same for v2_state: `key != V2_PDA || data[8] != 255`.
Saves ~1.5k CU per account and avoids linking the curve check. (Fallback: `create_program_address` with stored bump.)

### 0.5 Helpers (port 1:1, shared with lp_* / house_* specs)

- `rent_min_428 = Rent::get()?.try_minimum_balance(428)?` (Anchor: `Rent::get()?.minimum_balance(Vault::SPACE)`).
  Pinocchio 0.11.2 computes `(128 + len) * lamports_per_byte` and ignores `exemption_threshold`; solana-rent 2.2.1
  (what Anchor uses) computes `(((128+len) * lamports_per_byte_year) as f64 * exemption_threshold) as u64`. Mainnet Rent
  sysvar read 2026-11-04 (read-only RPC, slot 465161945): `lamports_per_byte_year = 5080`, `exemption_threshold = 1.0`,
  `burn_percent = 50` -> both formulas give `556 * 5080 = 2_824_480` for 428 bytes. See open question 1.
- `units_to_assets(units: u128, vault_assets: u64, total_units: u128) -> u64` (lib.rs:1873-1883):
  ```
  if total_units == 0 || units == 0 { return 0 }
  v = units.checked_mul(vault_assets as u128)  else MathOverflow
           .checked_div(total_units)           else MathOverflow
  u64::try_from(v)                             else MathOverflow
  ```
- `calc_health_bps(v2, assets: u64) -> u16` (lib.rs:1893-1909):
  ```
  if assets == 0 { return 0 }
  pending_value = units_to_assets(v2.total_pending_units, assets, v2.total_units)?
  obligations   = v2.total_outstanding_max_payout.checked_add(pending_value) else MathOverflow
  free          = assets.saturating_sub(obligations)
  h             = (free as u128).checked_mul(10_000).checked_div(assets as u128)   // MathOverflow (unreachable)
  return min(h, 10_000) as u16
  ```
- `enforce_min_health(v2, assets)` (lib.rs:1911-1918): `if v2.min_health_bps == 0 { Ok }`;
  `require!(calc_health_bps(v2, assets)? >= v2.min_health_bps, HealthFloorBreached)`.
- `is_allowlisted(vault, key)` (pattern at lib.rs:976-980 and 1063-1067): scan
  `withdraw_allowlist[0 .. min(allowlist_count, 8)]` for an exact 32-byte match. The `min` reproduces `.iter().take(n)`
  on an 8-element array (a corrupt count > 8 is clamped, not an error).

### 0.6 Event emission (Anchor `emit!`)

One `sol_log_data` call with ONE slice: `disc(8) ++ borsh(fields in declaration order)`. Runtime prints
`Program data: <base64>`. Pinocchio: stack `[u8; N]`, `sol_log_data(&[&buf])`. `slot` is always `Clock::get()?.slot`
read at the emit site.

| event (lib.rs) | payload layout after disc (offset:field) | total bytes |
|---|---|---|
| VaultInitialized (2828-2835) | 0 vault, 32 owner, 64 house_authority, 96 treasury, 128 slot:u64 | 144 |
| VaultFunded (2837-2843) | 0 funder, 32 amount:u64, 40 new_balance:u64, 48 slot:u64 | 64 |
| VaultUpdated (2845-2849) | 0 vault, 32 slot | 48 |
| OwnerProposed (2851-2857) | 0 vault, 32 current_owner, 64 proposed_owner, 96 slot | 112 |
| OwnerProposalCancelled (2859-2863) | 0 vault, 32 slot | 48 |
| OwnerAccepted (2865-2871) | 0 vault, 32 old_owner, 64 new_owner, 96 slot | 112 |
| AllowlistChanged (2968-2974) | 0 vault, 32 address, 64 added:bool(1 byte), 65 slot | 81 |
| TreasuryWithdrawal (2976-2982) | 0 treasury, 32 destination, 64 amount:u64, 72 slot | 88 |
| OperatorUnitsUnlocked (2984-2993) | 0 vault, 32 destination, 64 lamports:u64, 72 burned_seed:u128, 88 burned_house:u128, 104 burned_pending:u128, 120 slot | 136 |

---

## 1. initialize_vault

- Log: `Program log: Instruction: InitializeVault`
- Disc: `30bfa32c47813fa4` = `[48, 191, 163, 44, 71, 129, 63, 164]`

### Args (6 bytes; ix data = 14 bytes)
| off (after disc) | field | type |
|---|---|---|
| 0 | house_edge_bps | u16 |
| 2 | max_bet_bps | u16 |
| 4 | max_payout_bps | u16 |

### Accounts (lib.rs:2241-2262)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes (init => mut) | `init, payer = owner, space = Vault::SPACE (428), seeds = [b"kaboom_vault"], bump` (canonical, found by `find_program_address`); implicit: Mut (2000), RentExempt Enforce (2005) |
| 1 | house_authority | no | no | UncheckedAccount, no checks (any key, incl. default / owner) |
| 2 | treasury | no | no | UncheckedAccount, no checks |
| 3 | owner | yes | yes | `Signer` (3010), `#[account(mut)]` (2000) |
| 4 | system_program | no | no | `Program<System>`: key == `11111111111111111111111111111111` (3008), executable (3009) |

### Validation order (Anchor)
1. Args decode (102 if < 6 bytes).
2. Phase A: vault taken raw (3005 if missing); house_authority, treasury: nothing; owner: `is_signer` else 3010;
   system_program: 3008 / 3009.
3. Phase B, init vault (anchor-syn constraints.rs:469-560, 1032-1130, 1621-1680):
   a. `(pda, bump) = find_program_address([b"kaboom_vault"], program_id)`; `vault.key != pda` -> 2006.
      Pinocchio: `key != VAULT_PDA` -> 2006, `bump = 254` (const).
   b. `cur = vault.lamports()`; `rent = Rent::get()?`.
   c. If `cur == 0`: CPI `system::CreateAccount { from: owner, to: vault, lamports: rent.min(428), space: 428,
      owner: program_id }` signed with `[b"kaboom_vault", [254]]`.
   d. Else (PDA was pre-funded by anyone — must be supported, otherwise a 1-lamport donation bricks init):
      - `owner.key == vault.key` -> 4101 (unreachable: a PDA cannot be a top-level signer).
      - `required = max(rent.min(428), 1).saturating_sub(cur)`; if `required > 0`: CPI `system::Transfer
        { from: owner, to: vault, lamports: required }` (unsigned).
      - CPI `system::Allocate { account: vault, space: 428 }` signed with vault seeds.
      - CPI `system::Assign { account: vault, owner: program_id }` signed with vault seeds.
      - If the vault already exists (program-owned / has data), Allocate fails with system `Custom(0)`
        AccountAlreadyInUse: **this is the only re-initialization guard**; do not drop it. (CreateAccount on an
        existing account is never reached because an initialized vault has lamports > 0.)
   e. `Account::try_from_unchecked` (account.rs:319-329): system-owned && 0 lamports -> 3012; owner != program -> 3007
      (both unreachable after successful CPIs); body decoded from zeroed data without disc check.
   f. Mut: `!vault.is_writable` -> 2000. RentExempt: `vault.lamports < rent.min(vault.data_len)` -> 2005 (unreachable).
4. Phase B, other fields: owner Mut -> `!owner.is_writable` -> 2000. (If owner is not writable and step 3c/3d moves
   lamports from it, the runtime fails the CPI first; same outcome: failure.)
5. `ctx.bumps.vault = 254`.

### Handler (lib.rs:148-190)
Note the arg checks run AFTER the account is created (a failure reverts the creation).
1. `require!(house_edge_bps <= 1_000, InvalidConfig)` (154; MAX_HOUSE_EDGE_BPS lib.rs:76).
2. `require!(max_bet_bps > 0 && max_bet_bps <= 1_000, InvalidConfig)` (155-158; MAX_BET_BPS lib.rs:77).
3. `require!(max_payout_bps > 0 && max_payout_bps <= 5_000, InvalidConfig)` (159-162; MAX_PAYOUT_BPS lib.rs:78).
4. Writes (164-180), data offsets per 0.2:
   - disc `d308e82b02987577` at 0 (Anchor writes it at exit via `try_serialize`; Pinocchio must write it explicitly).
   - owner = accounts[3].key (165); house_authority = accounts[1].key (166); treasury = accounts[2].key (167).
   - bump = 254 (168, `ctx.bumps.vault`).
   - house_edge_bps, max_bet_bps, max_payout_bps = args (169-171).
   - treasury_split_bps = 5_000 (172).
   - total_games = 0, total_wagered = 0, total_payouts = 0 (173-175).
   - paused = 0 (176); version = 1 (177); allowlist_count = 0 (178).
   - withdraw_allowlist = 8 x zero pubkey (179); pending_owner = zero (180).
   (Data is freshly allocated zeros, so only disc/keys/bump/bps/split/version are non-zero; writing all is fine.)
5. Emit `VaultInitialized { vault: vault.key, owner, house_authority, treasury, slot: Clock::get()?.slot }` (182-188).
6. No lamport movement besides the init CPI(s). No other msg!.

### Subtle
- Permissionless: whoever lands `initialize_vault` first on the new program ID becomes `owner`, `house_authority`,
  `treasury` setter. Same as the Anchor program. See open question 3.
- No check that house_authority / treasury are non-default (update_vault checks this, init does not). Preserve.
- Lamports placed in the vault: exactly `rent.min(428)` (2,824,480 on current mainnet) on the create path; on the
  pre-funded path `max(cur, rent.min(428))`.

---

## 2. fund_vault

- Log: `Program log: Instruction: FundVault`
- Disc: `1a21cff2776c8649` = `[26, 33, 207, 242, 119, 108, 134, 73]`

### Args (8 bytes; ix data = 16)
| off | field | type |
|---|---|---|
| 0 | amount | u64 |

### Accounts (lib.rs:2264-2273)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>` (3012/3007/3001/3002/3003); `seeds = [b"kaboom_vault"], bump = vault.bump` (2006); `mut` (2000) |
| 1 | funder | yes | yes | `Signer` (3010); `mut` (2000) |
| 2 | system_program | no | no | `Program<System>` (3008/3009) |

Order: Phase A vault deser, funder signer, system_program id/executable; Phase B vault Seeds, vault Mut, funder Mut.

### Handler (lib.rs:193-214)
1. `require!(amount > 0, InvalidAmount)` (194).
2. CPI `system::Transfer { from: funder, to: vault, lamports: amount }` (196-205), unsigned. System program errors
   (insufficient funds `Custom(1)`, funder carrying data `InvalidArgument`) propagate.
3. Emit `VaultFunded { funder: funder.key, amount, new_balance: vault.lamports() /* read AFTER the CPI */,
   slot }` (207-212).
4. Exit re-serializes vault unchanged (no-op in Pinocchio).

### Subtle
- Not gated by `paused`, no minimum, mints no LP units: the deposit is a donation that raises NAV for all unit holders.
- Works before `initialize_v2` (does not touch v2_state).

---

## 3. withdraw_to_treasury

- Log: `Program log: Instruction: WithdrawToTreasury`
- Disc: `f58495772bffaf3f` = `[245, 132, 149, 119, 43, 255, 175, 63]`

### Args (8 bytes; ix data = 16)
| off | field | type |
|---|---|---|
| 0 | amount | u64 |

### Accounts (lib.rs:2499-2514)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>`; `seeds = [b"kaboom_vault"], bump = vault.bump` (2006); `mut` (2000); `constraint = vault.treasury == treasury.key() @ Unauthorized` (6007) |
| 1 | treasury | yes | no | `Signer` (3010) |
| 2 | destination | no | yes | UncheckedAccount, `mut` (2000) |

Order: Phase A vault deser, treasury signer; Phase B vault Seeds -> Mut -> Raw(Unauthorized); destination Mut.

### Handler (lib.rs:949-1005)
1. `require!(amount > 0, InvalidAmount)` (953).
2. `dest_key = destination.key` (956).
3. `require!(!destination.executable, InvalidAmount)` (962-965).
4. `require!(dest_key != vault.key, InvalidConfig)` (971-974).
5. `require!(is_allowlisted(vault, dest_key), DestinationNotAllowlisted)` (976-981; scan first `min(count,8)` entries).
6. `rent = rent_min_428` (984) — uses `Vault::SPACE` constant, not `data_len`.
7. `available = vault.lamports().saturating_sub(rent)` (985).
8. `withdraw = min(amount, available)` (986) — **may be 0; no error in that case**, the ix succeeds and emits amount 0.
9. Direct lamport arithmetic (no CPI; vault is program-owned):
   `vault.lamports = vault.lamports.checked_sub(withdraw) else MathOverflow` (988-991);
   `destination.lamports = destination.lamports.checked_add(withdraw) else MathOverflow` (992-996).
10. Emit `TreasuryWithdrawal { treasury: treasury.key, destination: dest_key, amount: withdraw, slot }` (998-1003).

### Subtle
- Ignores `VaultV2State` entirely (no outstanding-payout / LP reservation): treasury can drain everything above
  rent, including LP-owned NAV. Preserve exactly (parity); flagged only.
- The vault stays rent-exempt because `withdraw <= lamports - rent`.
- Destination may be any writable non-executable allowlisted account, including `treasury` itself or a
  program-owned account (crediting lamports to any writable account is legal).
- Pinocchio: lamport writes via `set_lamports`; no data borrow is held across them.

---

## 4. unlock_operator_position

- Log: `Program log: Instruction: UnlockOperatorPosition`
- Disc: `4eb3c9ab2955f6a2` = `[78, 179, 201, 171, 41, 85, 246, 162]`

### Args: none (ix data = 8; trailing bytes ignored)

### Accounts (lib.rs:2516-2537)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>`; seeds `[b"kaboom_vault"]`, `bump = vault.bump` (2006); `mut` (2000); `constraint = vault.owner == owner.key() @ Unauthorized` (6007) |
| 1 | v2_state | no | yes | `Account<VaultV2State>` (3012/3007/3001/3002/3003, incl. data_len >= 191 and byte 127 <= 1); seeds `[b"kaboom_v2_state"]`, `bump = v2_state.bump` (2006; cheap form `key == V2_PDA && data[8] == 255`); `mut` (2000) |
| 2 | owner | yes | no | `Signer` (3010) |
| 3 | destination | no | yes | UncheckedAccount, `mut` (2000) |

Order: Phase A vault, v2_state, owner; Phase B vault Seeds -> Mut -> Raw; v2_state Seeds -> Mut; destination Mut.

### Handler (lib.rs:1043-1131) — order matters for which error surfaces
1. `burn_units: u128 = seed_units.checked_add(house_units).checked_add(house_pending_units)` else MathOverflow (1045-1049).
2. `require!(burn_units > 0, NoOperatorUnitsToUnlock)` (1050) — checked BEFORE destination checks.
3. `require!(!destination.executable, InvalidAmount)` (1055-1058).
4. `require!(destination.key != vault.key, InvalidConfig)` (1059-1062).
5. `require!(is_allowlisted(vault, destination.key), DestinationNotAllowlisted)` (1063-1068).
6. `rent = rent_min_428` (1072); `assets: u64 = vault.lamports().saturating_sub(rent)` (1073).
7. `payout_lamports = units_to_assets(burn_units, assets, v2.total_units)?` (1074).
8. `user_pending_value = units_to_assets(v2.total_pending_units, assets, v2.total_units)?` (1079-1080).
9. `withdrawable = assets.saturating_sub(v2.total_outstanding_max_payout).saturating_sub(user_pending_value)` (1081-1083).
10. `actual = min(payout_lamports, withdrawable)` (1084).
11. `require!(actual > 0, InsufficientLiquidity)` (1085).
12. Capture `burned_seed = seed_units`, `burned_house = house_units`, `burned_pending = house_pending_units` (1088-1090).
13. `v2.total_units = total_units.checked_sub(burn_units)` else MathOverflow (1091-1094).
14. `v2.seed_units = 0; v2.house_units = 0; v2.house_pending_units = 0; v2.house_pending_unlock_slot = 0` (1095-1098).
15. Direct lamports: `vault.lamports -= actual` (checked_sub, MathOverflow) (1101-1104);
    `destination.lamports += actual` (checked_add, MathOverflow) (1105-1109).
16. `assets_after = vault.lamports().saturating_sub(rent)` — re-read post-transfer, same `rent` value (1113-1118).
17. `enforce_min_health(v2 /* post-burn: new total_units, unchanged total_pending_units & outstanding */, assets_after)?` (1119).
    `min_health_bps == 0` -> skip; else HealthFloorBreached if `calc_health_bps < min_health_bps`
    (assets_after == 0 gives health 0 and therefore fails whenever min_health_bps > 0).
18. Emit `OperatorUnitsUnlocked { vault: vault.key, destination: dest_key, lamports: actual, burned_seed, burned_house,
    burned_pending, slot }` (1121-1129).
19. Exit re-serializes vault (unchanged data) and v2_state (fields from 13-14).

### Subtle
- When `actual < payout_lamports` (capped by `withdrawable`), ALL operator units are still burned; the shortfall stays
  in the vault and accrues to remaining unit holders. Preserve; do not "fix".
- `enforce_house_floor` is intentionally NOT called (doc 1037-1042).
- `house_pending_unlock_slot` is zeroed even though it is a u64 slot, not units.
- Units are burned in memory before the lamport move; in Pinocchio write order is irrelevant (any later error reverts).
- If `destination == v2_state` (only if the owner allowlisted it) only lamports change; data writes still apply.

---

## 5. update_vault

- Log: `Program log: Instruction: UpdateVault`
- Disc: `43e5b9bce20bd23c` = `[67, 229, 185, 188, 226, 11, 210, 60]`

### Args (variable, 7..80 bytes; ix data 15..88), decoded sequentially
| # | field | type | encoding |
|---|---|---|---|
| 1 | house_edge_bps | Option<u16> | tag u8 (0 = None, 1 = Some + 2 bytes) |
| 2 | max_bet_bps | Option<u16> | same |
| 3 | max_payout_bps | Option<u16> | same |
| 4 | treasury_split_bps | Option<u16> | same |
| 5 | paused | Option<bool> | tag, then 1 byte that must be 0/1 |
| 6 | new_house_authority | Option<Pubkey> | tag, then 32 bytes |
| 7 | new_treasury | Option<Pubkey> | tag, then 32 bytes |

Any tag other than 0/1, a bool byte other than 0/1, or running out of bytes -> 102. Trailing bytes ignored.
SDK encoder: `packages/sdk/src/instructions.ts:407-422`.

### Accounts (`UpdateVault`, lib.rs:2539-2550) — shared by update_vault, allowlist_add, allowlist_remove, propose_owner, cancel_proposed_owner
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>`; seeds `[b"kaboom_vault"]`, `bump = vault.bump` (2006); `mut` (2000); `constraint = vault.owner == owner.key() @ Unauthorized` (6007) |
| 1 | owner | yes | no | `Signer` (3010) |

Order: args decode -> Phase A vault deser, owner signer -> Phase B vault Seeds -> Mut -> Raw.

### Handler (lib.rs:1134-1186) — each step only if `Some`, in this order
1. house_edge_bps: `require!(edge <= 1_000, InvalidConfig)`; write off 105 (1146-1149).
2. max_bet_bps: `require!(b > 0 && b <= 1_000, InvalidConfig)`; write off 107 (1150-1153).
3. max_payout_bps: `require!(p > 0 && p <= 5_000, InvalidConfig)`; write off 109 (1154-1157).
4. treasury_split_bps: `require!(t <= 10_000 /* BPS as u16 */, InvalidConfig)`; write off 111 (1158-1161).
5. paused: write byte 137 = p (no check) (1162-1164).
6. new_house_authority: `require!(auth != [0;32], InvalidConfig)`; write off 40 (1165-1174).
7. new_treasury: `require!(t != [0;32], InvalidConfig)`; write off 72 (1175-1179).
8. Emit `VaultUpdated { vault: vault.key, slot }` (1181-1184) — emitted even when every arg is None.

### Subtle
- A failing later check reverts earlier writes (tx atomicity); Pinocchio may write in place as it goes.
- Cannot change owner, allowlist, counters, version, bump.

---

## 6. allowlist_add

- Log: `Program log: Instruction: AllowlistAdd`
- Disc: `2a05819f37a567cb` = `[42, 5, 129, 159, 55, 165, 103, 203]`
- Args (32 bytes; ix data = 40): `address: Pubkey` at off 0.
- Accounts: `UpdateVault` (section 5 table; owner == vault.owner else 6007).

### Handler (lib.rs:1189-1212)
1. `require!((allowlist_count as usize) < 8, AllowlistFull)` (1191-1194).
2. `require!(!is_allowlisted(vault, address), AlreadyAllowlisted)` (1195-1200; scan first `count` entries).
3. `slot = allowlist_count as usize`; `withdraw_allowlist[slot] = address` (write at `140 + 32*slot`) (1201-1202).
4. `allowlist_count = allowlist_count.saturating_add(1)` (1203).
5. Emit `AllowlistChanged { vault: vault.key, address, added: true (1), slot }` (1205-1210).

### Subtle
- No rejection of the zero pubkey, the vault key, or executables here; withdraw paths reject executables / vault later.

---

## 7. allowlist_remove

- Log: `Program log: Instruction: AllowlistRemove`
- Disc: `1e1453d2bc9bd3a3` = `[30, 20, 83, 210, 188, 155, 211, 163]`
- Args (32 bytes; ix data = 40): `address: Pubkey` at off 0.
- Accounts: `UpdateVault` (section 5 table).

### Handler (lib.rs:1215-1241)
1. `count = allowlist_count as usize` (1217).
2. Find the FIRST `i in 0..count` with `withdraw_allowlist[i] == address` (1218-1224). None -> AddressNotInAllowlist (1225).
   (Anchor indexes `[i]` directly; count > 8 would panic, unreachable because add caps at 8. Pinocchio: iterate
   `0..min(count, 8)`; see open question 4.)
3. `last = count - 1` (1227).
4. If `idx != last`: `withdraw_allowlist[idx] = withdraw_allowlist[last]` (1228-1230) (swap-remove; order NOT preserved).
5. `withdraw_allowlist[last] = [0;32]` (1231).
6. `allowlist_count = (count - 1) as u8` (1232).
7. Emit `AllowlistChanged { vault: vault.key, address, added: false (0), slot }` (1234-1239).

---

## 8. propose_owner

- Log: `Program log: Instruction: ProposeOwner`
- Disc: `5a398d6ec4f1ac27` = `[90, 57, 141, 110, 196, 241, 172, 39]`
- Args (32 bytes; ix data = 40): `new_owner: Pubkey` at off 0.
- Accounts: `UpdateVault` (section 5 table).

### Handler (lib.rs:1246-1261)
1. `require!(new_owner != [0;32], InvalidConfig)` (1247).
2. `require!(new_owner != vault.owner, InvalidConfig)` (1248-1251).
3. `pending_owner = new_owner` (off 396) (1253) — silently overwrites any existing proposal (no NoPendingOwner-style check).
4. Emit `OwnerProposed { vault: vault.key, current_owner: vault.owner, proposed_owner: new_owner, slot }` (1254-1259).

---

## 9. cancel_proposed_owner

- Log: `Program log: Instruction: CancelProposedOwner`
- Disc: `4b46c56903a4c4a6` = `[75, 70, 197, 105, 3, 164, 196, 166]`
- Args: none (ix data = 8).
- Accounts: `UpdateVault` (section 5 table).

### Handler (lib.rs:1264-1276)
1. `require!(pending_owner != [0;32], NoPendingOwner)` (1266-1269).
2. `pending_owner = [0;32]` (1270).
3. Emit `OwnerProposalCancelled { vault: vault.key, slot }` (1271-1274).

---

## 10. accept_ownership

- Log: `Program log: Instruction: AcceptOwnership`
- Disc: `ac172b0deed55596` = `[172, 23, 43, 13, 238, 213, 85, 150]`
- Args: none (ix data = 8).

### Accounts (`AcceptOwnership`, lib.rs:2553-2564)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>`; seeds `[b"kaboom_vault"]`, `bump = vault.bump` (2006); `mut` (2000); `constraint = vault.pending_owner == new_owner.key() @ Unauthorized` (6007) |
| 1 | new_owner | yes | no | `Signer` (3010) |

### Handler (lib.rs:1281-1301)
1. `require!(pending_owner != [0;32], NoPendingOwner)` (1283-1286).
2. `require!(pending_owner == new_owner.key, Unauthorized)` (1287-1290) (redundant with the constraint; keep).
3. `old_owner = owner` (1291); `owner = pending_owner` (1292); `pending_owner = [0;32]` (1293).
4. Emit `OwnerAccepted { vault: vault.key, old_owner, new_owner: vault.owner /* the new owner */, slot }` (1294-1299).

### Subtle
- With no pending proposal, the constraint fires first: a real signer vs zero pending_owner -> **6007 Unauthorized**, not
  6028. Step 1 is reachable only if the zero pubkey signs (impossible). Keep the constraint before the handler so the
  surfaced code is 6007.
- Does not touch `house_authority` / `treasury` / allowlist.

---

## 11. Cross-cutting notes for the implementer

1. **Discriminator / layout writes**: only `initialize_vault` writes the Vault disc. All other handlers mutate fields in place.
2. **Borsh `bool` validation on load**: Anchor fails `Account<Vault>` with 3003 if byte 137 > 1, and `Account<VaultV2State>`
   if byte 127 > 1. Cheap to replicate (`data[137] > 1 -> Custom(3003)`); do it for parity.
3. **CU**: none of these are hot paths. Cost is dominated by `Clock::get` / `Rent::get` syscalls and, for
   `initialize_vault`, the system CPI(s). With the const-PDA seeds check (0.4) none of these need `create_program_address`.
4. **Lamport moves summary**:
   - initialize_vault: owner -> vault via CreateAccount (or Transfer + Allocate + Assign), amount `rent.min(428)` / top-up.
   - fund_vault: funder -> vault via system Transfer CPI, `amount`.
   - withdraw_to_treasury: vault -> destination, direct arithmetic, `min(amount, lamports - rent)`.
   - unlock_operator_position: vault -> destination, direct arithmetic, `actual`.
   - the other six: none.
5. **No close / realloc / init_if_needed** in any of the ten instructions. The only init is `initialize_vault`
   (plain `init`; re-init guarded by system Allocate failing).
6. **No msg! besides the `Instruction: X` line** in any of the ten handlers.

## F-fix deviations (2026-11-04, binding spec `FIXES.md`)

- F1 (`initialize_vault`): after Pass C (`check_mut(owner)`) and before the `InvalidConfig` checks, the port requires `owner == DEPLOYER` (`qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG`), else 6055 `NotDeployer`. Every Anchor error path keeps its code; a non-deployer init that Anchor accepts fails on the port.
