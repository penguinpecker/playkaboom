# Port spec: VRF-mode instructions + `#[ephemeral]` undelegation callback

Covers (11): `start_game_vrf`, `delegate_vrf`, `reveal_request_vrf`, `reveal_callback_vrf`, `cash_out_vrf`,
`settle_and_undelegate_vrf`, `settle_vrf`, `refund_stalled_vrf`, `admin_release_vrf_claim`,
`admin_close_orphaned_game_v2`, `process_undelegation` (injected by `#[ephemeral]`, lib.rs:141).

Source of truth (git HEAD e82f2c5, READ ONLY):
- `programs/kaboom/src/vrf_mode.rs` (handlers + contexts; "V:" line refs below)
- `programs/kaboom/src/lib.rs` (wrappers 1732-1784, helpers 1790-1918, account structs 1971-2237, errors 2710-2824; "L:" refs)
- SDK macro sources actually compiled by the Anchor build (Cargo.lock): `ephemeral-rollups-sdk 0.15.5`
  (+ `-attribute-{ephemeral,delegate,commit}-0.15.5`), `ephemeral-vrf-sdk 0.4.1` + `ephemeral-vrf-sdk-vrf-macro 0.4.1`,
  `magicblock-magic-program-api 0.10.1`, Anchor `anchor-lang/anchor-syn 0.31.1` (all in `~/.cargo/registry/src/index.crates.io-*/`).
- Pinocchio side: vendored `pinocchio/vendor/ephemeral-rollups-pinocchio-0.17.3` (only local patch: `vrf/instruction.rs`
  returns `Result` instead of `.expect()`).

All discriminators were computed with `python3 hashlib` and cross-checked equal to `target/idl/kaboom.json`.
**None of these 11 instructions emits an event (`emit!`) or any `msg!`** other than Anchor's automatic
`"Instruction: <Name>"` log. Do not add events (the commit-reveal path's `GameStarted` / `GameSettled` etc. are NOT emitted here).

---

## 0. Shared definitions

### 0.1 Program / external addresses

| name | value | source |
|---|---|---|
| program ID (NEW) | `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju` | binding decision (IDL still says `9Xip2L...`) |
| System program | `11111111111111111111111111111111` (32 zero bytes) | |
| Delegation program (DLP) | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | vendored `consts.rs`, IDL delegate_vrf |
| Magic program | `Magic11111111111111111111111111111111111111` | vendored `consts.rs`, IDL |
| Magic context | `MagicContext1111111111111111111111111111111` | vendored `consts.rs`, IDL |
| VRF program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` | vrf-sdk 0.4.1 `consts.rs`, IDL |
| VRF oracle queue (pinned) | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` | V:102-103 |
| SlotHashes sysvar | `SysvarS1otHashes111111111111111111111111111` | IDL reveal_request_vrf |
| program_identity PDA `["identity"]` under NEW id | `7LmGUyc5oTRr4RJpYmHf4g6gE5SeA2t5nW3DD2DepMuK`, bump **253** | `solana find-program-derived-address` |
| scoped VRF identity `["identity", NEW id]` under VRF program | `DypFSEHLnVdULGoAiGq7NmKfi8w5vSCYEXKwkfVMcMbh`, bump 255 | same (vrf macro `scoped_vrf_identity(&crate::ID)`) |
| vault PDA `["kaboom_vault"]` | `7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7` (bump 254) | |
| v2_state PDA `["kaboom_v2_state"]` | `Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue` (bump 255) | |

The two identity PDAs are deterministic: Anchor derives them at runtime with `find_program_address`
(vrf macro, `vrf_callback` macro); the port MUST hard-code them as constants (same accept/reject set, saves ~3-6k CU per call).
Add a host unit test that re-derives both from the program ID.

### 0.2 Seeds (bytes)

| const | bytes | ref |
|---|---|---|
| `VAULT_SEED` | `b"kaboom_vault"` | L:129 |
| `VAULT_V2_SEED` | `b"kaboom_v2_state"` | L:130 |
| `GAME_V2_SEED` | `b"game_v2"` | L:135 |
| `STATS_SEED` | `b"kaboom_stats"` | L:136 |
| `REFERRAL_SEED` | `b"kaboom_referral"` | L:137 |
| `VRF_CLAIM_SEED` | `b"kaboom_vrf_claim"` | V:52 |
| `VRF_GAME_SEED` | `b"kaboom_vrf_game"` (15 bytes) | V:53 |
| identity | `b"identity"` | vrf-sdk `IDENTITY` |
| DLP buffer (under OUR program) | `b"buffer"` | delegate macro `DELEGATE_BUFFER_TAG` |
| DLP delegation record (under DLP) | `b"delegation"` | |
| DLP delegation metadata (under DLP) | `b"delegation-metadata"` | |
| DLP undelegate buffer (under DLP) | `b"undelegate-buffer"` | vendored `seeds.rs` |

### 0.3 Constants

`GRID_SIZE=16u8` (L:50), `MIN_MINES=1`, `MAX_MINES=15` (L:51-52), `BPS=10_000u64` (L:53), `MIN_BET_LAMPORTS=1_000_000` (L:74),
`REFERRAL_BRONZE_BPS=50`, `SILVER=60`, `GOLD=70` (u16, L:84-86), `SILVER_VOLUME_LAMPORTS=10_000_000_000`,
`GOLD_VOLUME_LAMPORTS=100_000_000_000` (L:88-89). VRF: `VRF_PLAYING=0, VRF_WON=1, VRF_LOST=2, NO_TILE=255` (V:58-61),
`STALL_SLOTS=25` (V:64), `ABANDON_SLOTS=216_000` (V:68), `COMMIT_FREQUENCY_MS=1_000u32` (V:71),
`VRF_GAME_STATUS_OFFSET=8`, `VRF_GAME_SAFE_REVEALS_OFFSET=77`, `VRF_GAME_PENDING_OFFSET=79`, `VRF_GAME_MIN_RAW_LEN=80` (V:79-83),
`MAX_VRF_REVEALS=16` (V:85), `GAME_V2_BET_OFFSET=42`, `GAME_V2_SETTLED_OFFSET=112`, `GAME_V2_MAX_PAYOUT_OFFSET=148`,
`GAME_V2_DISCRIMINATOR=[0x64,0x0f,0xad,0x57,0x58,0xaf,0xa9,0x64]` (V:93-97; = sha256("account:GameSessionV2")[..8], verified).

### 0.4 Instruction discriminators (sha256("global:<name>")[..8]; all == IDL)

| instruction | log line (`Program log: ...`) | hex | decimal |
|---|---|---|---|
| start_game_vrf | `Instruction: StartGameVrf` | `94d851daf2182ec7` | `[148, 216, 81, 218, 242, 24, 46, 199]` |
| delegate_vrf | `Instruction: DelegateVrf` | `dd39aa29648e1e29` | `[221, 57, 170, 41, 100, 142, 30, 41]` |
| reveal_request_vrf | `Instruction: RevealRequestVrf` | `50575a0827cb1f40` | `[80, 87, 90, 8, 39, 203, 31, 64]` |
| reveal_callback_vrf | `Instruction: RevealCallbackVrf` | `0cdfcd0f3a017c56` | `[12, 223, 205, 15, 58, 1, 124, 86]` |
| cash_out_vrf | `Instruction: CashOutVrf` | `e5b00b5fc6255a6e` | `[229, 176, 11, 95, 198, 37, 90, 110]` |
| settle_and_undelegate_vrf | `Instruction: SettleAndUndelegateVrf` | `d5471bb4585a189c` | `[213, 71, 27, 180, 88, 90, 24, 156]` |
| settle_vrf | `Instruction: SettleVrf` | `9963ce5475b44511` | `[153, 99, 206, 84, 117, 180, 69, 17]` |
| refund_stalled_vrf | `Instruction: RefundStalledVrf` | `3cef840b96687b62` | `[60, 239, 132, 11, 150, 104, 123, 98]` |
| admin_release_vrf_claim | `Instruction: AdminReleaseVrfClaim` | `b9c71f674e59c3cc` | `[185, 199, 31, 103, 78, 89, 195, 204]` |
| admin_close_orphaned_game_v2 | `Instruction: AdminCloseOrphanedGameV2` | `6e18ce9b48d63824` | `[110, 24, 206, 155, 72, 214, 56, 36]` |
| process_undelegation | `Instruction: ProcessUndelegation` | `c41c29ce302533a7` | `[196, 28, 41, 206, 48, 37, 51, 167]` |

`process_undelegation`'s discriminator equals the DLP's `EXTERNAL_UNDELEGATE_DISCRIMINATOR` (vendored `consts.rs`) — the DLP calls it by that value.

Anchor handler prologue (anchor-syn `codegen/program/handlers.rs:104-145`), applies to every instruction here:
1. `sol_log("Instruction: <Name>")` FIRST, before anything else.
2. Args: `__Args::deserialize(&mut &data[8..])` (Borsh `deserialize`, NOT `try_from_slice`): too few bytes -> `InstructionDidNotDeserialize` (102); **trailing bytes are ignored**.
3. Accounts (`try_accounts`) then handler then `exit()` (see 0.8).

### 0.5 Account discriminators (sha256("account:<T>")[..8]; == IDL)

| type | hex | decimal |
|---|---|---|
| VrfClaim | `ebb3fd7739e546df` | `[235, 179, 253, 119, 57, 229, 70, 223]` |
| VrfGame | `e92415e3fd87fa04` | `[233, 36, 21, 227, 253, 135, 250, 4]` |
| Vault | `d308e82b02987577` | `[211, 8, 232, 43, 2, 152, 117, 119]` |
| VaultV2State | `eefcdafd5966445e` | `[238, 252, 218, 253, 89, 102, 68, 94]` |
| PlayerStats | `a992f2b06676e7ac` | `[169, 146, 242, 176, 102, 118, 231, 172]` |
| ReferralAccount | `eda2504ec4e95b02` | `[237, 162, 80, 78, 196, 233, 91, 2]` |
| GameSessionV2 (raw-read only) | `640fad5758afa964` | `[100, 15, 173, 87, 88, 175, 169, 100]` |

### 0.6 Account layouts (byte offsets INCLUDE the 8-byte discriminator; all little-endian)

**VrfClaim** (V:109-128) — allocated space `8 + VrfClaim::SIZE = 8 + 61 = 69`, rent-exempt min 1,000,760 at current mainnet rent (5080/byte, threshold 1.0).
| field | type | offset |
|---|---|---|
| player | Pubkey | 8..40 |
| bet | u64 | 40..48 |
| reserved | u64 | 48..56 |
| mine_count | u8 | 56 |
| house_edge_bps | u16 | 57..59 |
| start_slot | u64 | 59..67 |
| settled | bool | 67 |
| bump | u8 | 68 |

**VrfGame** (V:137-158) — space `8 + 613 = 621` (rent 3,804,920 today). `VrfReveal` = `{tile: u8, randomness: [u8;32]}` = 33 bytes.
| field | type | offset |
|---|---|---|
| status | u8 | 8 |
| player | Pubkey | 9..41 |
| session_key | Pubkey | 41..73 |
| bump | u8 | 73 |
| mine_count | u8 | 74 |
| house_edge_bps | u16 | 75..77 |
| safe_reveals | u8 | 77 |
| reveal_count | u8 | 78 |
| pending | bool | 79 |
| pending_tile | u8 | 80 |
| revealed_mask | u16 | 81..83 |
| mine_mask | u16 | 83..85 |
| multiplier_bps | u64 | 85..93 |
| reveals[i] | VrfReveal | `93 + 33*i` : tile at +0, randomness at +1..+33 (i in 0..16; ends at 621) |

**Vault** (L:1971-2004) — SPACE 428 (incl. disc). owner 8..40, house_authority 40..72, treasury 72..104, bump 104,
house_edge_bps 105..107, max_bet_bps 107..109, max_payout_bps 109..111, treasury_split_bps 111..113, total_games 113..121,
total_wagered 121..129, total_payouts 129..137, paused(bool) 137, version 138, allowlist_count 139, withdraw_allowlist 140..396,
pending_owner 396..428.

**VaultV2State** (L:2009-2083) — SPACE 191. bump 8, total_outstanding_max_payout u64 9..17, total_units u128 17..33,
house_units u128 33..49, house_pending_units u128 49..65, house_pending_unlock_slot u64 65..73, seed_units u128 73..89,
total_pending_units u128 89..105, min_house_share_bps u16 105..107, max_user_position_bps u16 107..109, min_health_bps u16 109..111,
withdraw_cooldown_slots u64 111..119, min_lp_deposit u64 119..127, vrf_mode_enabled(bool) 127, vrf_validator Pubkey 128..160,
vrf_max_payout_bps u16 160..162, _reserved 162..191.

**PlayerStats** (L:2191-2216) — SPACE 203 (rent 1,681,480 today). player 8..40, bump 40, version 41, games_played u64 42..50,
games_won 50..58, total_wagered 58..66, total_payouts 66..74, biggest_win 74..82, biggest_multiplier_bps 82..90,
current_streak u32 90..94, best_streak u32 94..98, last_played i64 98..106, referrer `Option<Pubkey>` tag at 106
(Some => key at 107..139), then `_reserved[64]`.
NOTE Borsh `Option` is variable-width: with `None` the 64 reserved bytes start at 107, not 139. Every field this spec touches is
before offset 106, so in-place writes are byte-identical to Anchor's whole-struct re-serialization; never rewrite the tail.

**ReferralAccount** (L:2219-2237) — SPACE 103. referrer 8..40, bump 40, version 41, tier u8 42, accrued_lamports u64 43..51,
total_earned u64 51..59, referred_count u32 59..63, referred_volume u64 63..71, _reserved 71..103.

**GameSessionV2** (raw only, V:87-97 / L:2155-2188): player 8..40, settled 112, bet 42..50, max_payout 148..156; min length read = 156.

### 0.7 Typed-account load = Anchor `Account<T>::try_accounts` (anchor-lang `accounts/account.rs:303-313`, attribute-account `lib.rs:244-258`)

For every account typed `Account<T>` / `Box<Account<T>>` below, the port's loader MUST, in this order:
1. accounts slice exhausted -> 3005 AccountNotEnoughKeys.
2. `owner == System && lamports == 0` -> 3012 AccountNotInitialized.
3. `owner != program_id` -> 3007 AccountOwnedByWrongProgram.
4. `data_len < 8` -> 3001 AccountDiscriminatorNotFound; `data[..8] != DISC` -> 3002 AccountDiscriminatorMismatch.
5. Borsh-validity of the body -> 3003 AccountDidNotDeserialize: `data_len >= 8 + body_len`; every `bool` byte in {0,1}
   (VrfClaim.settled@67, VrfGame.pending@79, Vault.paused@137, VaultV2State.vrf_mode_enabled@127); PlayerStats referrer tag@106 in {0,1}.
   (VrfGame bytes are written by the rollup committer, so the pending-byte check is NOT dead code.)

`Signer` -> `!is_signer` -> 3010 AccountNotSigner. `Program<T>` -> `key != T::id()` -> 3008 InvalidProgramId, then `!executable` -> 3009.
`AccountInfo` / `UncheckedAccount` -> no checks.

### 0.8 Anchor constraint/exit ordering (anchor-syn `codegen/accounts/try_accounts.rs`, `constraints.rs`, `exit.rs`)

- Phase A (deserialize), field order: typed checks of 0.7 for every non-`init` field; `init`/`init_if_needed` fields are only popped raw.
- Phase B: all `init`/`init_if_needed` fields in field order (find_program_address, address check, create, then mut, rent-exempt).
- Phase C: every other field in field order; within a field: `seeds` -> `mut` -> `signer` -> `has_one` -> raw `constraint` -> `owner`
  -> `rent_exempt` -> `executable` -> `close` -> `address` (constraints.rs `linearize`).
  - `seeds` + `bump = <stored>`: `create_program_address(seeds ++ [bump])`; Err -> 2006; `key != pda` -> 2006 ConstraintSeeds.
  - `seeds` + bare `bump`: `find_program_address` (canonical); `key != pda` -> 2006.
  - `mut`: `!is_writable` -> 2000 ConstraintMut.
  - raw `constraint = e @ Err` -> that custom error (else 2003).
  - `close = t`: `key == t.key` -> 2011 ConstraintClose.
  - `address = a @ Err` -> custom error, else 2012 ConstraintAddress.
- Handler.
- Exit, field order: `close = t` fields: `t.lamports += acc.lamports` (checked_add().unwrap()), `acc.lamports = 0`,
  `assign(System)`, `realloc(0)` (anchor-lang `common.rs:6-15`) — the account is NOT serialized first, so any handler write to a
  closed account is discarded. Other `mut` typed accounts: whole struct re-serialized (in-place field writes are equivalent).
- Init (`generate_create_account`, constraints.rs:1621-1674), payer = `player`, PDA seeds with canonical bump:
  - `lamports == 0`: `system::CreateAccount{from: payer, to: acc, lamports: rent.minimum_balance(space), space, owner: program}` signed by the PDA.
  - `lamports > 0` (pre-funded PDA, a griefing vector — MUST be supported): `payer == acc` -> 4101; `need = max(rent.minimum_balance(space),1) - lamports` (saturating);
    if `need > 0` `system::Transfer(payer -> acc, need)` (unsigned); `system::Allocate(acc, space)` signed; `system::Assign(acc, program)` signed.
  - Then `Account::try_from_unchecked` (steps 2-3 + Borsh of body, no disc check), `mut` (2000), rent-exempt (`!rent.is_exempt(lamports, data_len)` -> 2005).
  - `init_if_needed` (only `player_stats`): create path only if `owner == System`; else full 0.7 load (3007/3001/3002/3003); then
    `space != data_len` -> 2019 ConstraintSpace, `owner != program` -> 2004 ConstraintOwner, `lamports < rent.minimum_balance(space)` -> 2005.

### 0.9 Custom errors used (6000 + enum index, L:2711-2824; == IDL)

InvalidMineCount 6000, InvalidTileIndex 6001, TileAlreadyRevealed 6002, GameNotPlaying 6003, BetTooLow 6004, BetExceedsMax 6005,
VaultInsufficientFunds 6006, Unauthorized 6007, MathOverflow 6008, VaultPaused 6012, GameAlreadySettled 6017, NoTilesRevealed 6019,
ReferralMismatch 6022, HealthFloorBreached 6034, VrfModeDisabled 6042, BadSessionKey 6043, RevealPending 6044, NoRevealPending 6045,
TooManyReveals 6046, ReplayMismatch 6047, NotStalledYet 6048, BadGameAccount 6049, GameAlreadyResolved 6050,
PayoutExceedsReserved 6051, GameStillDelegated 6052, VrfValidatorNotSet 6053, WrongVrfValidator 6054.

Panics: the Anchor build has `overflow-checks = true` (root Cargo.toml). Unchecked `-`, `<<` in the source panic on overflow ->
the instruction FAILS. Port: every such spot must fail (any error; `ProgramError::ArithmeticOverflow` is fine) — listed inline as "PANIC".

### 0.10 Shared helpers (exact semantics)

- `vault_assets(vault)` L:1854-1857: `vault.lamports.saturating_sub(Rent::get()?.minimum_balance(428))`. Reads LIVE lamports each call
  (order of calls matters in settle_vrf). Port: fetch Rent once per instruction, `try_minimum_balance(428)`.
- `mul_div_floor(a,num,den)` L:1836-1843: `u128(a).checked_mul(num)` -> `checked_div(den)` -> `u64::try_from`; any failure -> MathOverflow.
- `calc_multiplier(safe:u8, mines:u8, edge:u16) -> u64` L:1790-1834: `safe==0` -> `BPS`. Else require `mines+safe <= 16` (u64 add) else
  InvalidMineCount; `num=den=1u128`; for `i in 0..safe`: `tiles = 16-i` (checked, MathOverflow), `safe_rem = (16-mines)-i` (checked, MathOverflow),
  require `safe_rem > 0` else InvalidMineCount; `num*=tiles`, `den*=safe_rem` (checked, MathOverflow). `raw = num*BPS/den` (checked);
  `edge_factor = BPS - edge as u64` (**unchecked: PANIC if edge > 10000**); `final = raw*edge_factor/BPS` (checked); `u64::try_from` -> MathOverflow.
- `worst_case_payout(bet, mines, edge)` L:1846-1850: `mul_div_floor(bet, calc_multiplier(16u8.saturating_sub(mines), mines, edge)?, BPS)`.
- `units_to_assets(units:u128, assets:u64, total:u128)` L:1873-1883: `total==0 || units==0` -> 0; `units.checked_mul(assets)` / `total` -> u64::try_from; failures MathOverflow.
- `calc_health_bps(v2, assets)` L:1893-1909: `assets==0` -> 0; `pending = units_to_assets(v2.total_pending_units, assets, v2.total_units)?`;
  `oblig = v2.total_outstanding_max_payout.checked_add(pending)` (MathOverflow); `free = assets.saturating_sub(oblig)`;
  `h = u128(free)*BPS / assets` (checked, MathOverflow); return `min(h, BPS) as u16`.
- `enforce_min_health(v2, assets)` L:1911-1918: `v2.min_health_bps == 0` -> Ok; `calc_health_bps(..)? >= min_health_bps` else HealthFloorBreached.
- `admin_spendable(vault, v2)` V:176-183: `a = vault_assets(vault)?; if v2.total_units > 0 { a.saturating_sub(1) } else { a }`.
- `decide_mine(r:&[u8;32], safe:u8, mines:u8) -> bool` V:192-201: `rem = 16u8.saturating_sub(safe) as u64`; `rem==0` -> false;
  `x = u64::from_le_bytes(r[0..8]) % rem`; return `x < mines as u64`.

Lamport moves on program-owned accounts (vault, closing PDAs) are direct `set_lamports` arithmetic exactly like Anchor's
`**try_borrow_mut_lamports()`; always re-read `lamports()` immediately before each read-modify-write (duplicate AccountViews, e.g.
`treasury == player`, then behave like Anchor's shared `Rc<RefCell>`).

---

## 1. `start_game_vrf`  (L:1732-1739 -> V:208-332; context V:992-1030)

Discriminator `94d851daf2182ec7` / `[148, 216, 81, 218, 242, 24, 46, 199]`. Log `Instruction: StartGameVrf`.

### Args (41 bytes, Borsh, after disc)
| field | type | bytes | offset in data |
|---|---|---|---|
| mine_count | u8 | 1 | 8 |
| bet | u64 LE | 8 | 9..17 |
| session_key | Pubkey | 32 | 17..49 |
`data.len() < 49` -> 102. Extra bytes ignored.

### Accounts
| # | name | signer | writable | constraints (phase) |
|---|---|---|---|---|
| 0 | player | yes | yes | `Signer` (A: 3010); `mut` (C: 2000). Payer of all three inits. |
| 1 | vault | no | yes | `Account<Vault>` (A: 0.7); C: `seeds=[VAULT_SEED], bump=vault.bump` (2006), `mut` (2000) |
| 2 | v2_state | no | yes | `Account<VaultV2State>` (A); C: `seeds=[VAULT_V2_SEED], bump=v2_state.bump` (2006), `mut` |
| 3 | claim | no | yes | B: `init, payer=player, space=69, seeds=[VRF_CLAIM_SEED, player], bump` (canonical, find; key mismatch 2006); then mut, rent-exempt |
| 4 | game | no | yes | B: `init, payer=player, space=621, seeds=[VRF_GAME_SEED, player], bump` |
| 5 | player_stats | no | yes | B: `init_if_needed, payer=player, space=203, seeds=[STATS_SEED, player], bump` (find runs ALWAYS, even when it exists; 2006 on mismatch) |
| 6 | system_program | no | no | `Program<System>` (A: 3008/3009) |
No remaining accounts used.

Full validation order (0.8): A: player(3010), vault(0.7), v2_state(0.7), system_program(3008/3009) ->
B: claim init, game init, player_stats init_if_needed -> C: player mut, vault seeds+mut, v2_state seeds+mut.
`init` on an already-existing claim/game (previous game not settled/refunded) fails inside the system program (Allocate on an
account in use / CreateAccount on funded account) — must still fail.

### Handler (V:214-331)
1. V:215-218 `require!(v2.vrf_mode_enabled)` else VrfModeDisabled.
2. V:224-227 `require!(v2.vrf_validator != Pubkey::default())` else VrfValidatorNotSet.
3. V:228-231 `require!(v2.vrf_max_payout_bps > 0)` else VrfValidatorNotSet.
4. V:232 `require!(!vault.paused)` else VaultPaused.
5. V:233-236 `require!(1 <= mine_count <= 15)` else InvalidMineCount.
6. V:237 `require!(bet >= 1_000_000)` else BetTooLow.
7. V:239-240 `available = vault_assets(vault)?` (read BEFORE the transfer; reused below, do NOT re-read).
8. V:244 `pre_health = calc_health_bps(v2, available)?` (u16).
9. V:245-248 `effective_max_bet_bps = (vault.max_bet_bps as u64).checked_mul(pre_health as u64) ?MathOverflow / BPS` (plain `/`).
10. V:253 `vrf_payout_bps = min(vault.max_payout_bps, v2.vrf_max_payout_bps)` (u16).
11. V:254-257 `effective_max_payout_bps = (vrf_payout_bps as u64).checked_mul(pre_health as u64) ?MathOverflow / BPS`.
12. V:258 `max_bet = mul_div_floor(available, effective_max_bet_bps, BPS)?`; V:259 `require!(bet <= max_bet)` else BetExceedsMax.
13. V:261 `worst = worst_case_payout(bet, mine_count, vault.house_edge_bps)?` (u64).
14. V:262 `max_payout = mul_div_floor(available, effective_max_payout_bps, BPS)? as u128`; V:263-266 `require!(worst as u128 <= max_payout)` else VaultInsufficientFunds.
15. V:268 `house_edge_bps = vault.house_edge_bps`.
16. V:271-280 CPI `system::Transfer { from: player, to: vault, lamports: bet }` (unsigned; player is tx signer).
17. V:282 `clock = Clock::get()?`.
18. V:284-292 claim writes: player=player.key, bet, reserved=worst, mine_count, house_edge_bps, start_slot=clock.slot, settled=0, bump=canonical claim bump (from B).
19. V:294-308 game writes: status=0, player=player.key, session_key=arg, bump=canonical game bump, mine_count, house_edge_bps, safe_reveals=0,
    reveal_count=0, pending=0, pending_tile=255, revealed_mask=0, mine_mask=0, multiplier_bps=10_000, reveals = 16 x {0, [0;32]}
    (data is freshly zeroed by create, so only non-zero fields need writing; write the discriminator at 0..8 for BOTH claim and game —
    Anchor's exit serializer writes it).
20. V:311-316 `if stats.player == Pubkey::default()` { stats.player = player.key; stats.bump = canonical stats bump; stats.version = 1 }.
    (On a fresh create also write the PlayerStats discriminator; on an existing account touch nothing.)
21. V:318-320 `vault.total_games = total_games.saturating_add(1)`; `vault.total_wagered = total_wagered.saturating_add(bet)`.
22. V:323-327 `v2.total_outstanding_max_payout = checked_add(worst)` else MathOverflow.
23. V:328 `new_assets = available.saturating_add(bet)`; V:329 `enforce_min_health(v2 /*updated*/, new_assets)?` -> HealthFloorBreached 6034 (or MathOverflow 6008 from calc_health_bps).
24. Exit: vault, v2_state, claim, game, player_stats serialized (in-place writes above are equivalent).

Lamports: player -> claim (rent 69 or shortfall), player -> game (rent 621), player -> player_stats (rent 203 if created), player -> vault (bet).
CU: 3 `try_find_program_address` (claim, game, stats) + 2 `create_program_address` are unavoidable for parity (bumps are not in the ABI).

---

## 2. `delegate_vrf`  (L:1741-1743 -> V:393-416; context V:1032-1043 expanded by `#[delegate]`)

Discriminator `dd39aa29648e1e29` / `[221, 57, 170, 41, 100, 142, 30, 41]`. Log `Instruction: DelegateVrf`. Args: none (0 bytes).

### Accounts (order = `#[delegate]` macro expansion: the 3 generated `del` accounts are inserted BEFORE `game`, then
`owner_program`, `delegation_program`, `system_program` appended; matches IDL)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | player | yes | yes | `Signer` (A 3010); C: mut (2000) |
| 1 | buffer_game | no | yes | C: `seeds=[b"buffer", game.key], bump` (find) under **our program** (`seeds::program = crate::id()`) (2006); mut (2000) |
| 2 | delegation_record_game | no | yes | C: `seeds=[b"delegation", game.key], bump` under `delegation_program.key()` (the PASSED account's key) (2006); mut |
| 3 | delegation_metadata_game | no | yes | C: `seeds=[b"delegation-metadata", game.key], bump` under `delegation_program.key()` (2006); mut |
| 4 | game | no | yes | `AccountInfo` (no type checks); C: `seeds=[VRF_GAME_SEED, player], bump` (find, canonical) (2006); mut |
| 5 | v2_state | no | **no** | `Account<VaultV2State>` (A 0.7); C: `seeds=[VAULT_V2_SEED], bump=v2_state.bump` (2006) |
| 6 | owner_program | no | no | C: `address = crate::id()` (2012) |
| 7 | delegation_program | no | no | C: `address = DLP id` (2012) |
| 8 | system_program | no | no | `Program<System>` (A 3008/3009) |
| 9.. | remaining | | | optional; see step 2 |

Note the record/metadata seed checks run before `delegation_program`'s address check (field order); a wrong DLP account fails either
with 2006 or 2012 — failure is what matters, checking the address first is acceptable.
The IDL's `buffer_game.pda.program` constant is the OLD program id bytes `[126,188,49,...]`; clients must derive it under the NEW id.

### Handler (V:394-415)
1. V:394-395 `pinned = v2.vrf_validator`; `require!(pinned != default)` else VrfValidatorNotSet.
2. V:398-400 if `remaining_accounts[0]` exists (accounts index 9): `require!(it.key == pinned)` else WrongVrfValidator. Extra remaining accounts ignored.
3. V:402-406 `check_vrf_game_delegable(game.owner, game.data)` (V:372-391), in order:
   a. `owner == program_id` else GameStillDelegated;
   b. `data.len() >= 80` else BadGameAccount;
   c. `data[0..8] == VrfGame disc` else BadGameAccount;
   d. `data[8] == 0` (PLAYING) else GameAlreadyResolved;
   e. `data[79] == 0` (pending) else RevealPending.
4. V:407-414 `delegate_account(seeds=[VRF_GAME_SEED, player.key], DelegateConfig{commit_frequency_ms: 1000, validator: Some(pinned)})`.
   Exact 0.15.5 semantics (`ephemeral-rollups-sdk-0.15.5/src/cpi.rs` `delegate_account_inner` + `utils.rs`), in order:
   a. game bump = canonical bump of `[VRF_GAME_SEED, player]` under our program (reuse the one from the seeds check);
      buffer bump = canonical bump of `[b"buffer", game.key]` under our program (reuse from the seeds check).
   b. `data_len = game.data_len()` (621).
   c. Create buffer (`create_pda(..., rent_exempt=false)`): if `buffer.lamports == 0`: `system::CreateAccount{from: player, to: buffer,
      lamports: 0, space: data_len, owner: program}` signed `[b"buffer", game, [buffer_bump]]`;
      **else** (pre-funded buffer): NO transfer; `system::Allocate(buffer, data_len)` signed; `system::Assign(buffer, program)` signed.
      (The vendored pinocchio `delegate_account` only has the CreateAccount branch — a donated lamport would brick delegation for that
      player; the port must keep the 0.15.5 else-branch.)
   d. Copy `game.data -> buffer.data` (full 621 bytes).
   e. Zero `game.data` (all 621 bytes).
   f. If `game.owner != System`: direct `assign(game, System)` (legal: we own it, data zeroed).
   g. If `game.owner != DLP`: CPI `system::Assign{account: game, owner: DLP}` signed `[VRF_GAME_SEED, player, [game_bump]]`.
   h. CPI DLP `Delegate` (discriminator u64 0), accounts in order:
      `player (w,s), game (w,s — PDA-signed), owner_program (r), buffer_game (w), delegation_record_game (w), delegation_metadata_game (w), system_program (r)`,
      signed with game seeds. Data (104 bytes):
      `[0;8] | e8 03 00 00 (1000u32) | 02 00 00 00 (2 seeds) | 0f 00 00 00 "kaboom_vrf_game" | 20 00 00 00 <player 32> | 01 <pinned 32>`.
   i. Close buffer (`close_pda_with_system_transfer`): `resize(buffer, 0)`; `assign(buffer, System)`; if `buffer.lamports > 0`:
      CPI `system::Transfer(buffer -> player, buffer.lamports)` signed with buffer seeds. (Equivalent alternative: move lamports directly
      to player BEFORE the assign, as vendored `close_pda_acc` does — same end state.)
5. Exit: v2_state not mut -> nothing. game is an AccountInfo -> nothing.

The vendored `ephemeral_rollups_pinocchio::instruction::delegate_account` matches steps b,d-i (direct-lamport close) but (1) lacks the
pre-funded-buffer branch (c) and (2) calls panicking `Address::find_program_address` for the buffer bump. Prefer a ~40-line inline
implementation using `pinocchio_system::{CreateAccount, Allocate, Assign}` and the vendored `utils::cpi_delegate` for step h.

---

## 3. `reveal_request_vrf`  (L:1745-1751 -> V:420-451; context V:1045-1057 expanded by `#[vrf]`) — HOT (runs in the ER)

Discriminator `50575a0827cb1f40` / `[80, 87, 90, 8, 39, 203, 31, 64]`. Log `Instruction: RevealRequestVrf`.

### Args (2 bytes): `tile_index: u8` (data[8]), `client_seed: u8` (data[9]). `< 10` bytes -> 102.

### Accounts (macro appends program_identity, vrf_program, slot_hashes, system_program; == IDL)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | session | yes | yes | `Signer` (A 3010); C: mut (2000) |
| 1 | game | no | yes | `Account<VrfGame>` (A 0.7); C: `seeds=[VRF_GAME_SEED, game.player], bump=game.bump` (create_program_address; 2006); mut (2000) |
| 2 | oracle_queue | no | yes | C: mut (2000); `address = VRF_ORACLE_QUEUE @ WrongVrfValidator` (6054) |
| 3 | program_identity | no | no | C: `seeds=[b"identity"], bump` (find) -> port: `key == 7LmGUyc5oTRr4RJpYmHf4g6gE5SeA2t5nW3DD2DepMuK` else 2006 |
| 4 | vrf_program | no | no | `Program<VrfProgram>`: key == VRF program (A 3008), executable (3009) |
| 5 | slot_hashes | no | no | C: `address = SlotHashes sysvar` (2012) |
| 6 | system_program | no | no | `Program<System>` (A 3008/3009) |

### Handler (V:421-450)
1. V:422-425 `require!(session.key == g.session_key)` else BadSessionKey.
2. V:426 `require!(g.status == 0)` else GameNotPlaying.
3. V:427 `require!(tile_index < 16)` else InvalidTileIndex.
4. V:428 `require!(!g.pending)` else RevealPending.
5. V:429-430 `bit = 1u16 << tile_index`; `require!(g.revealed_mask & bit == 0)` else TileAlreadyRevealed.
6. V:432-433 `g.pending = 1`; `g.pending_tile = tile_index` (write in place now; the game account is not part of the CPI).
7. V:435-449 CPI to VRF program, scoped request. Anchor builds `create_request_scoped_randomness_ix` (data[0]=10) and the `#[vrf]`
   macro's `invoke_signed_vrf` keeps 10 (it maps 3/11->11, else ->10), signs with `[b"identity", [253]]`
   (Anchor re-runs `try_find_program_address(["identity"])` -> `InvalidSeeds` on None; the port uses the constant bump 253).
   Instruction accounts (vrf-sdk 0.4.1 `instructions.rs:build_request_ix`):
   `session (w,s) | program_identity (r,s) | oracle_queue (w) | system_program (r) | slot_hashes (r)`, program_id = VRF program.
   Data (126 bytes):
   | offset | bytes |
   |---|---|
   | 0..8 | `0a 00 00 00 00 00 00 00` |
   | 8..40 | `[client_seed; 32]` |
   | 40..72 | callback_program_id = NEW program id |
   | 72..76 | `08 00 00 00` |
   | 76..84 | `0c df cd 0f 3a 01 7c 56` (reveal_callback_vrf disc) |
   | 84..88 | `01 00 00 00` (1 callback meta) |
   | 88..120 | game.key |
   | 120 | `00` (is_signer) |
   | 121 | `01` (is_writable) |
   | 122..126 | `00 00 00 00` (callback_args empty) |
   Vendored `vrf::RequestRandomnessCpi{high_priority: false, ...}.invoke_signed(buf, &[signer])` produces exactly this
   (pinocchio needs all 5 AccountViews incl. system_program; Anchor omitted it from the infos list because executable accounts are
   resolved by the runtime — no behavioural difference).
8. Exit: game re-serialized (equivalent to step 6).

---

## 4. `reveal_callback_vrf`  (L:1753-1758 -> V:455-481; context V:1059-1064 expanded by `#[vrf_callback]`) — HOT (ER)

Discriminator `0cdfcd0f3a017c56` / `[12, 223, 205, 15, 58, 1, 124, 86]`. Log `Instruction: RevealCallbackVrf`.

### Args (32 bytes): `randomness: [u8; 32]` (data[8..40]). `< 40` -> 102.
(The VRF program sends `disc ++ randomness ++ callback_args(empty)`.)

### Accounts
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vrf_program_identity | yes | no | `Signer` (A 3010); C: `address = scoped_vrf_identity(&crate::ID)` -> constant `DypFSEHLnVdULGoAiGq7NmKfi8w5vSCYEXKwkfVMcMbh` (2012) |
| 1 | game | no | yes | `Account<VrfGame>` (A 0.7); C: mut (2000). **No seeds constraint** (parity: do not add one). |

### Handler (V:456-480)
1. V:457 `require!(g.pending)` else NoRevealPending.
2. V:458-459 `tile = g.pending_tile`; `bit = 1u16 << tile` — **PANIC if tile >= 16** (port: fail).
3. V:461-462 `idx = g.reveal_count as usize`; `require!(idx < 16)` else TooManyReveals.
4. V:463 `g.reveals[idx] = {tile, randomness}`; V:464 `g.reveal_count = reveal_count.saturating_add(1)`.
5. V:466 `is_mine = decide_mine(&randomness, g.safe_reveals, g.mine_count)` (uses safe_reveals BEFORE increment).
6. V:467-469 `g.revealed_mask |= bit`; `g.pending = 0`; `g.pending_tile = 255`.
7. V:470-472 if mine: `g.mine_mask |= bit`; `g.status = 2`.
8. V:473-479 else: `g.safe_reveals = safe_reveals.saturating_add(1)`; `g.multiplier_bps = calc_multiplier(g.safe_reveals, g.mine_count, g.house_edge_bps)?` (InvalidMineCount 6000 / MathOverflow 6008 / PANIC if edge > 10000; all inputs are rollup state);
   `if g.safe_reveals >= 16 - g.mine_count` (u8 sub; PANIC if mine_count > 16, but calc_multiplier already errors first) `{ g.status = 1 }`.
9. Exit: game re-serialized. An error anywhere leaves the account untouched (tx revert) — write order in place is fine.

---

## 5. `cash_out_vrf`  (L:1760-1762 -> V:484-496; context V:1066-1072) — ER

Discriminator `e5b00b5fc6255a6e` / `[229, 176, 11, 95, 198, 37, 90, 110]`. Log `Instruction: CashOutVrf`. Args: none.

### Accounts
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | signer | yes | yes | `Signer` (A 3010); C: mut (2000) |
| 1 | game | no | yes | `Account<VrfGame>` (A); C: `seeds=[VRF_GAME_SEED, game.player], bump=game.bump` (2006); mut |

### Handler (V:485-495)
1. V:486-490 `require!(signer.key == g.session_key || signer.key == g.player)` else BadSessionKey.
2. V:491 `require!(g.status == 0)` else GameNotPlaying.
3. V:492 `require!(!g.pending)` else RevealPending.
4. V:493 `require!(g.safe_reveals > 0)` else NoTilesRevealed.
5. V:494 `g.status = 1`. Exit: game serialized.

---

## 6. `settle_and_undelegate_vrf`  (L:1764-1766 -> V:506-521; context V:1074-1081 expanded by `#[commit]`) — ER

Discriminator `d5471bb4585a189c` / `[213, 71, 27, 180, 88, 90, 24, 156]`. Log `Instruction: SettleAndUndelegateVrf`. Args: none.

### Accounts (macro appends magic_program, magic_context)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | payer | yes | yes | `Signer` (A 3010); C: mut (2000) |
| 1 | game | no | yes | `Account<VrfGame>` (A 0.7); C: `seeds=[VRF_GAME_SEED, game.player], bump=game.bump` (2006); mut |
| 2 | magic_program | no | no | `Program<MagicProgram>` (A: key == `Magic111...` 3008; executable 3009) |
| 3 | magic_context | no | yes | C: mut (2000); `address = MagicContext111...` (2012) |

### Handler (V:507-520)
1. V:507-512 `require!(payer.key == g.player || payer.key == g.session_key)` else BadSessionKey.
2. V:513-519 CPI `MagicBlockInstruction::ScheduleIntentBundle` (0.15.5 `ephem/mod.rs:220-271`), program = magic_program,
   accounts (deduped, in order): `payer (w,s) | magic_context (w) | game (w)`.
   Data (33 bytes, bincode 1 legacy):
   `0b 00 00 00` (variant 11) | `00` (commit: None) | `01` (commit_and_undelegate: Some) | `00 00 00 00` (CommitTypeArgs::Standalone)
   | `01 00 00 00 00 00 00 00` (Vec<u8> len 1) | `02` (account index of game) | `00 00 00 00` (UndelegateTypeArgs::Standalone)
   | `00` (commit_finalize: None) | `00` (commit_finalize_and_undelegate: None) | `00 00 00 00 00 00 00 00` (standalone_actions len 0).
   Port: either the vendored `intent_bundle::MagicIntentBundleBuilder::new(payer, ctx, prog).commit_and_undelegate(&[game]).build_and_invoke(&mut buf)`
   or a hard-coded 33-byte constant + `invoke` (cheaper). Either way add a host test asserting these exact bytes.
   NOTE: do NOT use `instruction::commit_and_undelegate_accounts` (that emits the legacy `ScheduleCommitAndUndelegate` = `[2,0,0,0]`, a different wire format).
3. Exit: Anchor re-serializes game with UNCHANGED bytes (no runtime "modified data" error because nothing changed). Port: write nothing to game after the CPI.

---

## 7. `settle_vrf`  (L:1768-1772 -> V:526-738; context V:1083-1128) — HOT (L1, 200k CU budget)

Discriminator `9963ce5475b44511` / `[153, 99, 206, 84, 117, 180, 69, 17]`. Log `Instruction: SettleVrf`. Args: none. Permissionless.

### Accounts
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | payer | yes | yes | `Signer` (A 3010); C: mut |
| 1 | player | no | yes | `AccountInfo`; C: mut (2000) |
| 2 | claim | no | yes | `Box<Account<VrfClaim>>` (A 0.7); C: `seeds=[VRF_CLAIM_SEED, player], bump=claim.bump` (2006); mut; `claim.player == player.key @ Unauthorized` (6007); close: `claim.key == player.key` -> 2011 |
| 3 | game | no | yes | `Box<Account<VrfGame>>` (A 0.7 — a still-delegated game fails here with **3007**); C: `seeds=[VRF_GAME_SEED, player], bump=game.bump` (2006); mut; `game.player == player.key @ Unauthorized`; close check 2011 |
| 4 | vault | no | yes | `Account<Vault>` (A); C: seeds `[VAULT_SEED]`, `bump=vault.bump` (2006); mut |
| 5 | v2_state | no | yes | `Account<VaultV2State>` (A); C: seeds `[VAULT_V2_SEED]`, `bump=v2_state.bump`; mut |
| 6 | treasury | no | yes | `AccountInfo`; C: mut (2000); `address = vault.treasury @ Unauthorized` (6007) |
| 7 | player_stats | no | yes | `Box<Account<PlayerStats>>` (A); C: `seeds=[STATS_SEED, player], bump=player_stats.bump` (2006); mut; `player_stats.player == player.key @ Unauthorized` |
| 8 | system_program | no | no | `Program<System>` (A 3008/3009); unused by the handler |
| 9 | remaining[0] | no | (yes if a cut is paid) | optional ReferralAccount, see step 16 |

### Handler (V:529-737)
1. V:529 `require!(!claim.settled)` else GameAlreadySettled.
2. V:531-541 read `status, reveal_count, mine_count, committed_safe = g.safe_reveals, committed_mult = g.multiplier_bps, edge = g.house_edge_bps`.
3. V:542-545 `require!(status == 1 || status == 2)` else GameNotPlaying.
4. V:551-554 `require!(mine_count == claim.mine_count)` else ReplayMismatch.
5. V:555-558 `require!(edge == claim.house_edge_bps)` else ReplayMismatch.
6. V:562-565 `require!(reveal_count as usize <= 16)` else TooManyReveals.
7. V:568-578 replay: `safe: u8 = 0; lost = false; for i in 0..reveal_count { rec = g.reveals[i];`
   `require!((rec.tile as u16) < 16)` else InvalidTileIndex; `if decide_mine(&rec.randomness, safe, mine_count) { lost = true; break }`;
   `safe = safe.saturating_add(1) }`. (Tiles of entries after a break are NOT checked.)
8. V:579 `require!(safe == committed_safe)` else ReplayMismatch.
9. V:580-583 `require!(status == if lost {2} else {1})` else ReplayMismatch.
10. V:587 `require!(lost || safe > 0)` else ReplayMismatch.
11. V:588-589 `expected_mult = calc_multiplier(safe, mine_count, edge)?` (computed for losses too; InvalidMineCount 6000 / MathOverflow 6008; mine_count and edge already equal the claim, so these are unreachable on honest data); `require!(committed_mult == expected_mult)` else ReplayMismatch.
12. V:592-597 `v2.total_outstanding_max_payout = saturating_sub(claim.reserved)` (BEFORE the treasury liquidity read in step 16).
13. V:599 `bet = claim.bet`.
14. V:602-634 payout: if `!lost`: `p = mul_div_floor(bet, expected_mult, BPS)?`; `require!(p <= claim.reserved)` else PayoutExceedsReserved;
    `available = vault_assets(vault)?`; `require!(p <= available)` else VaultInsufficientFunds;
    `vault.lamports = vault.lamports.checked_sub(p)` (MathOverflow); `player.lamports = player.lamports.checked_add(p)` (MathOverflow);
    `vault.total_payouts = total_payouts.saturating_add(p)` (offset 129); `payout = p`. Else `payout = 0`.
15. V:638-658 stats: `games_played = sat_add(1)`; `total_wagered = sat_add(bet)`; `last_played = Clock::get()?.unix_timestamp`;
    if `!lost`: `games_won = sat_add(1)`; `total_payouts = sat_add(payout)`; `net_win = payout.saturating_sub(bet)`;
    `if net_win > biggest_win { biggest_win = net_win }`; `if expected_mult > biggest_multiplier_bps { biggest_multiplier_bps = expected_mult }`;
    `current_streak = current_streak.saturating_add(1)` (u32); `if current_streak > best_streak { best_streak = current_streak }`;
    else `current_streak = 0`.
16. V:661-706 referral: only if `stats.referrer == Some(referrer_key)` (tag@106 == 1) AND `remaining_accounts[0]` exists (else skip silently):
    a. `expected = find_program_address([REFERRAL_SEED, referrer_key], program_id)` (canonical; port: `try_find_program_address`);
       `require!(referral.key == expected)` else ReferralMismatch.
    b. `Account::<ReferralAccount>::try_from(referral)` -> 0.7 steps 2-5 (3012 / 3007 / 3001 / 3002 / 3003). No writable check here.
    c. `require!(ra.referrer == referrer_key)` else ReferralMismatch.
    d. `cut_bps = match ra.tier {0 => 50, 1 => 60, _ => 70}`; `cut = mul_div_floor(bet, cut_bps, BPS)?`.
    e. `vault_available = vault_assets(vault)?` (AFTER the payout); `actual = min(cut, vault_available)`.
    f. if `actual > 0`: `vault.lamports = checked_sub(actual)` (MathOverflow); `referral.lamports = checked_add(actual)` (MathOverflow).
    g. `ra.accrued_lamports = sat_add(actual)`; `ra.total_earned = sat_add(actual)`; `ra.referred_volume = sat_add(bet)`.
    h. `new_tier = if volume >= 100_000_000_000 {2} else if volume >= 10_000_000_000 {1} else {0}`; `if new_tier != ra.tier { ra.tier = new_tier }` (can lower a tier; keep).
    i. `ra.exit(&crate::ID)` = re-serialize (in-place writes of tier@42, accrued@43, total_earned@51, referred_volume@63). A read-only
       referral account therefore fails at runtime (data always changes since bet >= 1e6) — same in the port.
    No `ReferralAccrued`/`ReferralTierChanged` events here.
17. V:709-734 treasury: `split = vault.treasury_split_bps`, `house_edge = vault.house_edge_bps` (CURRENT vault config, not the claim snapshot).
    If `split > 0`: `edge_share = mul_div_floor(bet, house_edge, BPS)?`; `treasury_cut = mul_div_floor(edge_share, split, BPS)?`;
    `assets_now = vault_assets(vault)?` (after payout + referral); `pending_value = units_to_assets(v2.total_pending_units, assets_now, v2.total_units)?`;
    `liquidity = assets_now.saturating_sub(v2.total_outstanding_max_payout /*post step 12*/).saturating_sub(pending_value)`;
    `actual = min(treasury_cut, liquidity)`; if `actual > 0`: vault `checked_sub` / treasury `checked_add` (MathOverflow). No `TreasuryAccrued` event.
18. V:736 `claim.settled = true` — **dead write**: claim is closed in exit without being serialized (0.8). Port: skip it.
19. Exit, in field order: close claim -> player; close game -> player (each: `player += acc.lamports`, `acc.lamports = 0`, owner = System,
    data_len = 0); vault (total_payouts), v2_state (outstanding), player_stats (stats) persisted.

CU notes: 5 `create_program_address` (claim, game, vault, v2, stats) + 1 `try_find_program_address` when a referral is processed;
fetch Rent once and reuse for every `vault_assets`; replay loop <= 16 cheap iterations; calc_multiplier <= 15 u128 mul/div.
(Option to save CU on the referral PDA is listed in open questions.)

---

## 8. `refund_stalled_vrf`  (L:1774-1776 -> V:767-844; context V:1130-1156)

Discriminator `3cef840b96687b62` / `[60, 239, 132, 11, 150, 104, 123, 98]`. Log `Instruction: RefundStalledVrf`. Args: none.

### Accounts
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | caller | yes | **no** | `Signer` (A 3010) |
| 1 | player | no | yes | `AccountInfo`; C: mut (2000) |
| 2 | claim | no | yes | `Box<Account<VrfClaim>>` (A); C: seeds `[VRF_CLAIM_SEED, player]`, `bump=claim.bump` (2006); mut; `claim.player == player.key @ Unauthorized`; close: claim != player (2011) |
| 3 | game | no | yes | `UncheckedAccount`; C: `seeds=[VRF_GAME_SEED, player], bump` (**find**, canonical; 2006); mut (2000) |
| 4 | vault | no | yes | `Account<Vault>`; C: seeds, `bump=vault.bump`; mut |
| 5 | v2_state | no | yes | `Account<VaultV2State>`; C: seeds, `bump=v2_state.bump`; mut |

### Handler (V:768-843)
1. V:768 `require!(!claim.settled)` else GameAlreadySettled.
2. V:770-775 `is_player = caller.key == claim.player`; `require!(is_player || caller.key == vault.house_authority)` else Unauthorized.
3. V:776-780 `now = Clock::get()?.slot`; `require!(now > claim.start_slot.saturating_add(25))` else NotStalledYet.
4. V:784-810 raw game checks (scoped borrow), in order:
   a. `game.owner == program_id` else GameStillDelegated;
   b. `data.len() >= 80` else BadGameAccount;
   c. `data[8] == 0` else GameAlreadyResolved;
   d. `data[9..41] == player.key` else BadGameAccount;
   e. if `!is_player`: `require!(data[77] == 0 && data[79] == 0)` else Unauthorized.
   **No discriminator check here** (unlike delegate_vrf) — keep parity, do not add one.
5. V:812-817 `v2.total_outstanding_max_payout = saturating_sub(claim.reserved)`.
6. V:818-819 `require!(claim.bet <= vault_assets(vault)?)` else VaultInsufficientFunds.
7. V:820-823 `vault.lamports = checked_sub(bet)` (MathOverflow); V:824-828 `player.lamports = checked_add(bet)` (MathOverflow).
8. V:833-841 manual game close: `g = game.lamports`; `game.lamports = 0`; `game.data.fill(0)` (all 621 bytes; NO resize, NO assign —
   owner stays our program); `player.lamports = checked_add(g)` (MathOverflow). The runtime purges the 0-lamport account at tx end.
9. Exit: close claim -> player (0.8). vault (no field change) and v2_state (outstanding) persisted; game (Unchecked) nothing.

---

## 9. `admin_release_vrf_claim`  (L:1778-1780 -> V:864-896; context V:1178-1197)

Discriminator `b9c71f674e59c3cc` / `[185, 199, 31, 103, 78, 89, 195, 204]`. Log `Instruction: AdminReleaseVrfClaim`. Args: none.

### Accounts
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | owner | yes | no | `Signer` (A 3010); C (first, field order): `vault.owner == owner.key @ Unauthorized` (6007) |
| 1 | player | no | yes | `AccountInfo`; C: mut |
| 2 | claim | no | yes | `Box<Account<VrfClaim>>` (A); C: seeds `[VRF_CLAIM_SEED, player]`, `bump=claim.bump`; mut; `claim.player == player.key @ Unauthorized`; close check 2011 |
| 3 | vault | no | yes | `Account<Vault>` (A); C: seeds, `bump=vault.bump`; mut |
| 4 | v2_state | no | yes | `Account<VaultV2State>` (A); C: seeds, `bump=v2_state.bump`; mut |
(The owner check reads vault before vault's own seeds check; both run before the handler.)

### Handler (V:865-895)
1. V:865 `require!(!claim.settled)` else GameAlreadySettled.
2. V:866-870 `now = Clock::get()?.slot`; `require!(now > claim.start_slot.saturating_add(216_000))` else NotStalledYet.
3. V:872-877 `v2.total_outstanding_max_payout = saturating_sub(claim.reserved)`.
4. V:878-879 `payable = min(claim.bet, admin_spendable(vault, v2 /*total_units*/)?)`.
5. V:880-891 if `payable > 0`: `vault.lamports = checked_sub(payable)`; `player.lamports = checked_add(payable)` (MathOverflow).
6. Exit: close claim -> player; vault, v2_state persisted. The game PDA is NOT touched.

---

## 10. `admin_close_orphaned_game_v2`  (L:1782-1784 -> V:916-983; context V:1158-1176)

Discriminator `6e18ce9b48d63824` / `[110, 24, 206, 155, 72, 214, 56, 36]`. Log `Instruction: AdminCloseOrphanedGameV2`. Args: none.

### Accounts
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | owner | yes | no | `Signer` (A 3010); C: `vault.owner == owner.key @ Unauthorized` |
| 1 | player | no | yes | `AccountInfo`; C: mut |
| 2 | game | no | yes | `UncheckedAccount`; C: `seeds=[GAME_V2_SEED, player], bump` (find, canonical; 2006); mut |
| 3 | vault | no | yes | `Account<Vault>`; C: seeds, `bump=vault.bump`; mut |
| 4 | v2_state | no | yes | `Account<VaultV2State>`; C: seeds, `bump=v2_state.bump`; mut |

### Handler (V:924-982) — game read raw, may be owned by DLP or anyone
1. V:926-930 `require!(data.len() >= 156)` else BadGameAccount.
2. V:931-934 `require!(data[0..8] == GAME_V2_DISCRIMINATOR)` else BadGameAccount.
3. V:935-936 `require!(data[8..40] == player.key)` else Unauthorized.
4. V:937-945 `bet = u64 LE data[42..50]`, `max_payout = u64 LE data[148..156]`, `settled = data[112] != 0` (any non-zero = settled).
5. V:947 `require!(!settled)` else GameAlreadySettled.
6. V:948-952 `v2.total_outstanding_max_payout = saturating_sub(max_payout)`.
7. V:954-955 `payable = min(bet, admin_spendable(vault, v2)?)`; V:956-967 if `> 0`: vault `checked_sub`, player `checked_add` (MathOverflow).
8. V:971-981 only if `game.owner == program_id`: `rent = game.lamports`; `game.lamports = 0`; `game.data.fill(0)` (no resize/assign);
   `player.lamports = checked_add(rent)` (MathOverflow). Otherwise game untouched.
9. Exit: vault, v2_state persisted.
No owner check on `game` at all — deliberately raw (V:917-923). Under the NEW program id no GameSessionV2 can exist
(nothing creates `["game_v2", player]` accounts), so this instruction is vestigial; ported for ABI parity only.

---

## 11. `process_undelegation`  (`#[ephemeral]` lib.rs:141; macro `ephemeral-rollups-sdk-attribute-ephemeral-0.15.5/src/lib.rs` `generate_undelegate`)

Discriminator `c41c29ce302533a7` / `[196, 28, 41, 206, 48, 37, 51, 167]`. Log `Instruction: ProcessUndelegation` (Anchor emits it — it is an
ordinary `#[program]` instruction). Called by the DLP via CPI during undelegation finalization.

### Args: `account_seeds: Vec<Vec<u8>>` Borsh: `u32 n`, then n x (`u32 len`, bytes). Anchor: malformed/short -> 102; trailing bytes ignored;
n = 0 is accepted by the decoder. (Vendored pinocchio `undelegate` instead returns `InvalidInstructionData` for n==0, n>16, short data,
AND trailing bytes — see open question 3.) Real DLP payload here: `[b"kaboom_vrf_game", player]`.

### Accounts (`InitializeAfterUndelegation`; all `UncheckedAccount` under `backward-compat`)
| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | base_account | no | yes | C: mut (2000) |
| 1 | buffer | (must sign, checked in handler) | no | none |
| 2 | payer | (signs the CreateAccount CPI) | yes | C: mut (2000) |
| 3 | system_program | no | no | NO check in Anchor (it is an Unchecked account); the system CPI resolves by program id |

### Handler (0.15.5 `cpi.rs:undelegate_account` + `utils.rs:create_pda(rent_exempt=true)`) plus the MANDATORY 0.16.2+ fix
1. `buffer.is_signer` else `ProgramError::MissingRequiredSignature`.
2. `buffer.owner == DLP` else `ProgramError::InvalidAccountOwner`.
3. **ADDED (binding decision; vendored `undelegate.rs:is_canonical_undelegation_buffer`)**: `buffer.key == find_program_address([b"undelegate-buffer", base_account.key], DLP)`
   else `ProgramError::InvalidSeeds`. Use `try_find_program_address`.
4. `bump = find_program_address(account_seeds, program_id)` (canonical; Anchor: panicking variant; port: `try_find_program_address`, None -> InvalidSeeds).
   No explicit "derives to base_account" check: the signed CPI below fails if it doesn't.
5. `space = buffer.data_len()`; `rent = Rent::get()?`.
6. If `base_account.lamports == 0`: CPI `system::CreateAccount{from: payer, to: base_account, lamports: rent.minimum_balance(space), space, owner: program_id}`
   signed with `account_seeds ++ [bump]`.
   Else (0.15.5 branch, absent from the vendored helper — keep it): `need = rent.minimum_balance(space).saturating_sub(base.lamports)`;
   if `need > 0` CPI `system::Transfer(payer -> base_account, need)` (unsigned); CPI `system::Allocate(base_account, space)` signed;
   CPI `system::Assign(base_account, program_id)` signed.
7. Copy `buffer.data -> base_account.data` (equal lengths).
8. No exit writes.

---

## 12. Cross-cutting subtleties

- **Delegated-game reads**: while delegated, the L1 `VrfGame` is DLP-owned and zero-filled (status reads 0 = PLAYING). Ownership is the guard:
  delegate_vrf (2.3a) and refund_stalled_vrf (8.4a) check `owner == program` BEFORE reading bytes; settle_vrf gets it from the typed load (3007).
- **Close ordering**: settle_vrf closes claim then game (field order) after all handler lamport moves; refund_stalled_vrf zeroes game
  manually in the handler and closes claim in exit; admin_release closes only the claim. End balances are order-independent, but
  never serialize into a closed account.
- **init re-entry guard**: start_game_vrf uses plain `init` for claim/game, so a second game cannot start until settle (closes both),
  refund_stalled_vrf (closes both) or admin_release (closes claim only — the game PDA stays, so that player cannot start a new VRF game
  until it is undelegated + refunded/closed; this is existing behaviour, keep it). `player_stats` is `init_if_needed` guarded by `player == default`.
- **Pre-funded PDA griefing**: claim/game/stats init, delegate buffer, and undelegation re-create all have a `lamports > 0` path
  (transfer shortfall + allocate + assign). Must be ported; plain CreateAccount would let a 1-lamport donation lock a player out.
- **remaining_accounts**: delegate_vrf index 9 (optional validator echo); settle_vrf index 9 (optional ReferralAccount). Extra trailing accounts are ignored.
- **Unused accounts that are still validated**: settle_vrf `system_program` (3008/3009); reveal_request_vrf `slot_hashes`, `vrf_program`, `system_program`.
- **Writable flags**: delegate_vrf v2_state and refund `caller` are read-only in the ABI; do not require writability.
- **Arithmetic flavours** are part of parity: saturating for counters/outstanding releases, checked (MathOverflow) for lamport moves,
  `checked_add` (MathOverflow) for the start-time reservation, unchecked-with-panic in calc_multiplier edge factor and callback bit shift.

---

## 13. Open questions

1. CU: settle_vrf referral PDA uses canonical `find_program_address` (Anchor). Using `create_program_address` with `ReferralAccount.bump` (offset 40)
   would save ~1.5-3k CU but changes error precedence for bogus accounts (owner/disc read before ReferralMismatch). Default in this spec: keep find.
2. The vendored pinocchio `delegate_account` and `undelegate` both lack the Anchor-0.15.5 pre-funded-account branch and use panicking
   `find_program_address`. Spec says hand-write both flows (reusing vendored `cpi_delegate` and the canonical-buffer check). Confirm vs. patching the vendored crate.
3. process_undelegation arg parsing: Anchor accepts n==0 seeds and trailing bytes; vendored rejects them with InvalidInstructionData.
   Only the DLP calls this with exact bytes, so either is safe; spec prefers Anchor-tolerant parsing returning 102 on short data. Confirm.
4. ScheduleIntentBundle: hard-coded 33-byte payload vs vendored `intent_bundle` builder (needs a data buffer, more code/CU). Spec allows either, with a byte test.
5. admin_close_orphaned_game_v2 is vestigial under the new program id (no GameSessionV2 can exist). Kept per "full parity"; flagging in case the owner wants it dropped later.
6. The vendored crate's `vrf/instruction.rs` patch breaks its own `#[cfg(test)]` (`view.program_id` on a `Result`); harmless for builds, fails `cargo test` of the vendor crate.

## F-fix deviations (2026-11-04, binding spec `FIXES.md`)

- F3: `VRF_VOID = 3`. New house-only ER instruction `force_undelegate_vrf` (disc `da30a3da54f8e465`, accounts `house WS, game W, magic_program, magic_context W, vault`): PLAYING with `pending == 0` (else 6044) becomes WON if `safe_reveals > 0`, else VOID; other statuses unchanged; then the same commit+undelegate CPI as `settle_and_undelegate_vrf` (shared `schedule_undelegate`). `refund_stalled_vrf` accepts PLAYING or VOID (Anchor: VOID gives 6050).
- F3 (round 2): `settle_and_undelegate_vrf` applies the same mapping first (`end_playing`, shared with the force): a PLAYING game with a pending reveal fails 6044, one with progress is committed WON, one without VOID. Anchor commits PLAYING as-is. So no game reaches L1 PLAYING with progress or pending, and a PLAYING game on L1 is always a never-delegated zero-progress one (house refund branch).
- F5: `settle_vrf` requires `remaining_accounts[0]` when `player_stats.referrer` is Some (missing: 6022).
- F6: `start_game_vrf` Pass B reuses a program-owned, VrfGame-disc'd game PDA after the claim `init` succeeds (seeds 2006, mut 2000, data zeroed, rent carried over) instead of `init` (Anchor: Allocate fails).
