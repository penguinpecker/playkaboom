# kaboom-p shared spec (everything the 42 handlers share)

Source of truth (read-only): `programs/kaboom/src/lib.rs` (3287 lines) + `programs/kaboom/src/vrf_mode.rs` (1279 lines) at git HEAD `e82f2c5`, compiled by Anchor 0.31.1 with `ephemeral-rollups-sdk` 0.15.5 (`anchor-compat`, `vrf`), `ephemeral-vrf-sdk` 0.4.1, borsh 0.10.4, `solana-security-txt` 1.1.2 (lockfile).
IDL cross-check: `target/idl/kaboom.json` matches HEAD (it has `vrf_max_payout_bps`, 42 instructions incl. `process_undelegation`).

How this file was checked:

- Every instruction, account and event discriminator below was recomputed as `sha256(prefix + name)[..8]` and compared with the IDL. All 42 + 8 + 34 match.
- The 42 `Instruction: <Name>` strings were grepped out of the Anchor build `target/deploy/kaboom.so`. All 42 are present byte-for-byte.
- Account offsets and sizes were generated from the IDL types. They were checked against every `SPACE`/`SIZE` constant and against the hand offsets in `vrf_mode.rs:76-95`.
- The Rent sysvar was read from mainnet on 2026-11-04 (read-only RPC): `lamports_per_byte_year = 5080`, `exemption_threshold = 1.0`, `burn_percent = 50`.

Table of contents: 0 IDs and fixed PDAs · 1 accounts · 2 events · 3 errors · 4 constants, seeds, helpers · 5 Anchor 0.31.1 semantics to reproduce · 6 MagicBlock (ephemeral / delegate / commit / VRF) · 7 security.txt · 8 off-chain dependencies · 9 instruction index · 10 open questions.

---

## 0. Program IDs and fixed PDAs (new program)

| what | value |
|---|---|
| program id (NEW) | `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju` (hex `ca9491fbe79556899ffa2905be5399d9f46cef073b08cce9869a5bfa8c00a2c0`) |
| old id (dead, do not use) | `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh` |
| Vault PDA `[b"kaboom_vault"]` | `7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7`, bump **254** (hex `62785d302a360e4063407051e248133a5b6f3e9d6ce74d8e159edf55d5392830`) |
| VaultV2State PDA `[b"kaboom_v2_state"]` | `Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue`, bump **255** (hex `ec216cd947391ac9222ce77f5fe3b272a57dc197bb8def9cf4df58c9969d208f`) |
| VRF caller identity `[b"identity"]` under this program | `7LmGUyc5oTRr4RJpYmHf4g6gE5SeA2t5nW3DD2DepMuK`, bump **253** (hex `5e3635afee32fb2337032b7ad677421a2aeed89a962436e4172bdc1ac16da712`) |
| scoped VRF callback signer `[b"identity", program_id]` under VRF program | `DypFSEHLnVdULGoAiGq7NmKfi8w5vSCYEXKwkfVMcMbh`, bump 255 (hex `c0da31620ab49fb1d0f267491e9ab3525fbeb947a8db986e462c4fe284c14fe4`) |
| System program | `11111111111111111111111111111111` |
| SlotHashes sysvar | `SysvarS1otHashes111111111111111111111111111` |
| MagicBlock delegation program (DLP) | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Magic program (ER) | `Magic11111111111111111111111111111111111111` |
| Magic context (ER) | `MagicContext1111111111111111111111111111111` |
| VRF program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |
| VRF ephemeral oracle queue (`VRF_ORACLE_QUEUE`, pinned) | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |

These values come from `@solana/web3.js` `findProgramAddressSync` with the new ID. They are safe to hard-code as constants.

**Why constants are allowed for the two singletons.** Anchor checks `create_program_address([seed, stored_bump]) == key` after the account has passed the owner and discriminator checks. Only `initialize_vault` / `initialize_v2` can create a program-owned `Vault` / `VaultV2State`, and both use the canonical bump. So `key == VAULT_PDA` gives the same accept/reject set and the same error, 2006 ConstraintSeeds. It saves 1,500 CU per account per instruction.

The same reasoning applies to the identity PDAs:
- Anchor runs `find_program_address` twice for `program_identity` in `reveal_request_vrf`: once in the `seeds` constraint and again in `invoke_signed_vrf`. Bump 253 means 3 tries each.
- Anchor runs one `find` for `scoped_vrf_identity` in `reveal_callback_vrf`.
- Compare against the constants above and sign with bump 253.

---

## 1. Accounts (`#[account]`, Borsh after an 8-byte discriminator)

General rules (Anchor 0.31.1 + borsh 0.10.4):

- **Layout.** Fields are serialized in declaration order with no padding, little-endian. `Pubkey` = 32 raw bytes. `[T; N]` = N items back-to-back. A `#[derive(AnchorSerialize)]` fieldless enum = 1 byte (variant index). `bool` = 1 byte.
- **Strict decoding at load time.** When Anchor loads a typed account it rejects these with **3003 AccountDidNotDeserialize**:
  - a `bool` byte other than 0/1
  - an `Option` tag other than 0/1
  - an enum index out of range (`GameStatus` > 3)
  - data too short for the fields
- **Port rule for typed loads.** When the port "loads" a typed account it must make the same checks, so that corrupted bytes fail the same way. This matters in practice for `VrfGame`, whose bytes come back from the rollup commit (`pending` @79 must be 0/1). The checks are cheap: check `data_len >= space` and check each bool/enum byte. Trailing bytes beyond the Borsh length are ignored by Anchor.
- **Variable-length fields.** Only `Option<Pubkey>` occurs: `PlayerStats.referrer`, and `GameSessionV2.session_key` (data definition only). Borsh writes `0x00` for None (1 byte) and `0x01 ‖ 32 bytes` for Some.
  - **PlayerStats with `referrer = None`.** Borsh puts `_reserved[64]` at offsets 107..171 and leaves 171..203 untouched.
  - **Why fixed offsets are still byte-identical.** `_reserved` is never written with non-zero bytes, the account is zero-filled at creation, and `referrer` is never set back to None. So the fixed-offset view (tag @106, key @107..139, reserved @139..203) produces the same bytes for every state the program can reach.
  - **Port rule for referrer.** Validate tag ≤ 1. Write `tag=1` and the key @107 when setting it. Never rewrite the reserved bytes.
  - The off-chain decoder `packages/sdk/src/accounts.ts:127-134` also skips 32 bytes on None, and the getProgramAccounts filter uses offset 107 (see §8).
- **No account is ever reallocated.** `realloc` is not used anywhere.
- **Data definition only.** `GameSessionV2` (ER-era) is never created. Only `admin_close_orphaned_game_v2` reads it, raw (see the end of this section). On the NEW program id no `GameSessionV2` can exist, so that instruction is dead weight kept for parity.

### GameSession

- discriminator `sha256("account:GameSession")[..8]` = `967414c5cd79dcf0` (bytes `150, 116, 20, 197, 205, 121, 220, 240`)
- PDA seeds: `[b"kaboom_game", player]`
- space at init: `GameSession::SPACE` = **180** bytes; serialized max end = 180
- rent-exempt minimum on mainnet today (5080 lamports/byte, threshold 1.0): 1564640 lamports

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| - | discriminator | `[u8; 8]` | 8 | 0 | 8 |
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `bump` | `u8` | 1 | 40 | 41 |
| 2 | `status` | `GameStatus` | 1 | 41 | 42 |
| 3 | `bet` | `u64` | 8 | 42 | 50 |
| 4 | `mine_count` | `u8` | 1 | 50 | 51 |
| 5 | `commitment` | `[u8; 32]` | 32 | 51 | 83 |
| 6 | `revealed_mask` | `u16` | 2 | 83 | 85 |
| 7 | `revealed_safe_mask` | `u16` | 2 | 85 | 87 |
| 8 | `safe_reveals` | `u8` | 1 | 87 | 88 |
| 9 | `multiplier_bps` | `u64` | 8 | 88 | 96 |
| 10 | `start_slot` | `u64` | 8 | 96 | 104 |
| 11 | `created_at` | `i64` | 8 | 104 | 112 |
| 12 | `settled` | `bool` | 1 | 112 | 113 |
| 13 | `mine_layout` | `u16` | 2 | 113 | 115 |
| 14 | `salt` | `[u8; 32]` | 32 | 115 | 147 |
| 15 | `version` | `u8` | 1 | 147 | 148 |
| 16 | `max_payout` | `u64` | 8 | 148 | 156 |
| 17 | `_reserved` | `[u8; 24]` | 24 | 156 | 180 |

### LpPosition

- discriminator `sha256("account:LpPosition")[..8]` = `69f125c8e002fc5a` (bytes `105, 241, 37, 200, 224, 2, 252, 90`)
- PDA seeds: `[b"kaboom_lp", user]`
- space at init: `LpPosition::SPACE` = **121** bytes; serialized max end = 121
- rent-exempt minimum on mainnet today (5080 lamports/byte, threshold 1.0): 1264920 lamports

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| - | discriminator | `[u8; 8]` | 8 | 0 | 8 |
| 0 | `user` | `pubkey` | 32 | 8 | 40 |
| 1 | `units` | `u128` | 16 | 40 | 56 |
| 2 | `pending_units` | `u128` | 16 | 56 | 72 |
| 3 | `pending_unlock_slot` | `u64` | 8 | 72 | 80 |
| 4 | `created_slot` | `u64` | 8 | 80 | 88 |
| 5 | `bump` | `u8` | 1 | 88 | 89 |
| 6 | `_reserved` | `[u8; 32]` | 32 | 89 | 121 |

### PlayerStats

- discriminator `sha256("account:PlayerStats")[..8]` = `a992f2b06676e7ac` (bytes `169, 146, 242, 176, 102, 118, 231, 172`)
- PDA seeds: `[b"kaboom_stats", player]`
- space at init: `PlayerStats::SPACE` = **203** bytes; serialized max end = 203
- rent-exempt minimum on mainnet today (5080 lamports/byte, threshold 1.0): 1681480 lamports

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| - | discriminator | `[u8; 8]` | 8 | 0 | 8 |
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `bump` | `u8` | 1 | 40 | 41 |
| 2 | `version` | `u8` | 1 | 41 | 42 |
| 3 | `games_played` | `u64` | 8 | 42 | 50 |
| 4 | `games_won` | `u64` | 8 | 50 | 58 |
| 5 | `total_wagered` | `u64` | 8 | 58 | 66 |
| 6 | `total_payouts` | `u64` | 8 | 66 | 74 |
| 7 | `biggest_win` | `u64` | 8 | 74 | 82 |
| 8 | `biggest_multiplier_bps` | `u64` | 8 | 82 | 90 |
| 9 | `current_streak` | `u32` | 4 | 90 | 94 |
| 10 | `best_streak` | `u32` | 4 | 94 | 98 |
| 11 | `last_played` | `i64` | 8 | 98 | 106 |
| 12 | `referrer` | `Option<pubkey>` | 33 var | 106 | 139 |
| 13 | `_reserved` | `[u8; 64]` | 64 | 139 (*) | 203 |

### ReferralAccount

- discriminator `sha256("account:ReferralAccount")[..8]` = `eda2504ec4e95b02` (bytes `237, 162, 80, 78, 196, 233, 91, 2`)
- PDA seeds: `[b"kaboom_referral", referrer]`
- space at init: `ReferralAccount::SPACE` = **103** bytes; serialized max end = 103
- rent-exempt minimum on mainnet today (5080 lamports/byte, threshold 1.0): 1173480 lamports

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| - | discriminator | `[u8; 8]` | 8 | 0 | 8 |
| 0 | `referrer` | `pubkey` | 32 | 8 | 40 |
| 1 | `bump` | `u8` | 1 | 40 | 41 |
| 2 | `version` | `u8` | 1 | 41 | 42 |
| 3 | `tier` | `u8` | 1 | 42 | 43 |
| 4 | `accrued_lamports` | `u64` | 8 | 43 | 51 |
| 5 | `total_earned` | `u64` | 8 | 51 | 59 |
| 6 | `referred_count` | `u32` | 4 | 59 | 63 |
| 7 | `referred_volume` | `u64` | 8 | 63 | 71 |
| 8 | `_reserved` | `[u8; 32]` | 32 | 71 | 103 |

### Vault

- discriminator `sha256("account:Vault")[..8]` = `d308e82b02987577` (bytes `211, 8, 232, 43, 2, 152, 117, 119`)
- PDA seeds: `[b"kaboom_vault"]` (singleton)
- space at init: `Vault::SPACE` = **428** bytes; serialized max end = 428
- rent-exempt minimum on mainnet today (5080 lamports/byte, threshold 1.0): 2824480 lamports

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| - | discriminator | `[u8; 8]` | 8 | 0 | 8 |
| 0 | `owner` | `pubkey` | 32 | 8 | 40 |
| 1 | `house_authority` | `pubkey` | 32 | 40 | 72 |
| 2 | `treasury` | `pubkey` | 32 | 72 | 104 |
| 3 | `bump` | `u8` | 1 | 104 | 105 |
| 4 | `house_edge_bps` | `u16` | 2 | 105 | 107 |
| 5 | `max_bet_bps` | `u16` | 2 | 107 | 109 |
| 6 | `max_payout_bps` | `u16` | 2 | 109 | 111 |
| 7 | `treasury_split_bps` | `u16` | 2 | 111 | 113 |
| 8 | `total_games` | `u64` | 8 | 113 | 121 |
| 9 | `total_wagered` | `u64` | 8 | 121 | 129 |
| 10 | `total_payouts` | `u64` | 8 | 129 | 137 |
| 11 | `paused` | `bool` | 1 | 137 | 138 |
| 12 | `version` | `u8` | 1 | 138 | 139 |
| 13 | `allowlist_count` | `u8` | 1 | 139 | 140 |
| 14 | `withdraw_allowlist` | `[pubkey; 8]` | 256 | 140 | 396 |
| 15 | `pending_owner` | `pubkey` | 32 | 396 | 428 |

### VaultV2State

- discriminator `sha256("account:VaultV2State")[..8]` = `eefcdafd5966445e` (bytes `238, 252, 218, 253, 89, 102, 68, 94`)
- PDA seeds: `[b"kaboom_v2_state"]` (singleton)
- space at init: `VaultV2State::SPACE` = **191** bytes; serialized max end = 191
- rent-exempt minimum on mainnet today (5080 lamports/byte, threshold 1.0): 1620520 lamports

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| - | discriminator | `[u8; 8]` | 8 | 0 | 8 |
| 0 | `bump` | `u8` | 1 | 8 | 9 |
| 1 | `total_outstanding_max_payout` | `u64` | 8 | 9 | 17 |
| 2 | `total_units` | `u128` | 16 | 17 | 33 |
| 3 | `house_units` | `u128` | 16 | 33 | 49 |
| 4 | `house_pending_units` | `u128` | 16 | 49 | 65 |
| 5 | `house_pending_unlock_slot` | `u64` | 8 | 65 | 73 |
| 6 | `seed_units` | `u128` | 16 | 73 | 89 |
| 7 | `total_pending_units` | `u128` | 16 | 89 | 105 |
| 8 | `min_house_share_bps` | `u16` | 2 | 105 | 107 |
| 9 | `max_user_position_bps` | `u16` | 2 | 107 | 109 |
| 10 | `min_health_bps` | `u16` | 2 | 109 | 111 |
| 11 | `withdraw_cooldown_slots` | `u64` | 8 | 111 | 119 |
| 12 | `min_lp_deposit` | `u64` | 8 | 119 | 127 |
| 13 | `vrf_mode_enabled` | `bool` | 1 | 127 | 128 |
| 14 | `vrf_validator` | `pubkey` | 32 | 128 | 160 |
| 15 | `vrf_max_payout_bps` | `u16` | 2 | 160 | 162 |
| 16 | `_reserved` | `[u8; 29]` | 29 | 162 | 191 |

### VrfClaim

- discriminator `sha256("account:VrfClaim")[..8]` = `ebb3fd7739e546df` (bytes `235, 179, 253, 119, 57, 229, 70, 223`)
- PDA seeds: `[b"kaboom_vrf_claim", player]`
- space at init: `8 + VrfClaim::SIZE` = **69** bytes; serialized max end = 69
- rent-exempt minimum on mainnet today (5080 lamports/byte, threshold 1.0): 1000760 lamports

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| - | discriminator | `[u8; 8]` | 8 | 0 | 8 |
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `bet` | `u64` | 8 | 40 | 48 |
| 2 | `reserved` | `u64` | 8 | 48 | 56 |
| 3 | `mine_count` | `u8` | 1 | 56 | 57 |
| 4 | `house_edge_bps` | `u16` | 2 | 57 | 59 |
| 5 | `start_slot` | `u64` | 8 | 59 | 67 |
| 6 | `settled` | `bool` | 1 | 67 | 68 |
| 7 | `bump` | `u8` | 1 | 68 | 69 |

### VrfGame

- discriminator `sha256("account:VrfGame")[..8]` = `e92415e3fd87fa04` (bytes `233, 36, 21, 227, 253, 135, 250, 4`)
- PDA seeds: `[b"kaboom_vrf_game", player]`
- space at init: `8 + VrfGame::SIZE` = **621** bytes; serialized max end = 621
- rent-exempt minimum on mainnet today (5080 lamports/byte, threshold 1.0): 3804920 lamports

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| - | discriminator | `[u8; 8]` | 8 | 0 | 8 |
| 0 | `status` | `u8` | 1 | 8 | 9 |
| 1 | `player` | `pubkey` | 32 | 9 | 41 |
| 2 | `session_key` | `pubkey` | 32 | 41 | 73 |
| 3 | `bump` | `u8` | 1 | 73 | 74 |
| 4 | `mine_count` | `u8` | 1 | 74 | 75 |
| 5 | `house_edge_bps` | `u16` | 2 | 75 | 77 |
| 6 | `safe_reveals` | `u8` | 1 | 77 | 78 |
| 7 | `reveal_count` | `u8` | 1 | 78 | 79 |
| 8 | `pending` | `bool` | 1 | 79 | 80 |
| 9 | `pending_tile` | `u8` | 1 | 80 | 81 |
| 10 | `revealed_mask` | `u16` | 2 | 81 | 83 |
| 11 | `mine_mask` | `u16` | 2 | 83 | 85 |
| 12 | `multiplier_bps` | `u64` | 8 | 85 | 93 |
| 13 | `reveals` | `[VrfReveal; 16]` | 528 | 93 | 621 |


(*) = offset assumes `referrer = Some`. See the Option note above.

`VrfReveal` (element of `VrfGame.reveals`): `tile: u8` then `randomness: [u8; 32]`, 33 bytes in total. `reveals[i]` starts at absolute offset `93 + 33*i`: `tile` @`93+33i`, `randomness` @`94+33i .. 127+33i`.

`GameStatus` enum byte: `Playing=0, Won=1, Lost=2, Expired=3`.

### GameSessionV2 (not in the IDL; raw-read only)

- discriminator `sha256("account:GameSessionV2")[..8]` = `640fad5758afa964` (`vrf_mode.rs:97`, recomputed and matches).
- PDA seeds `[b"game_v2", player]`. `GameSessionV2::SPACE` = 221.
- Raw offsets used by `admin_close_orphaned_game_v2`:
  - disc 0..8
  - `player` 8..40
  - `bump` 40
  - `status` 41
  - **`bet` 42..50**
  - `mine_count` 50
  - `commitment` 51..83
  - masks 83..87
  - `safe_reveals` 87
  - `multiplier_bps` 88..96
  - `start_slot` 96..104
  - `created_at` 104..112
  - **`settled` 112**
  - `mine_layout` 113..115
  - `salt` 115..147
  - `version` 147
  - **`max_payout` 148..156**
  - `session_key: Option<Pubkey>` 156 (1 or 33 bytes)
  - `_reserved[32]`
- Minimum length checked by the handler: `GAME_V2_MAX_PAYOUT_OFFSET + 8 = 156`.

### Raw-offset constants the handlers use (`vrf_mode.rs:79-95`)

| const | value | meaning |
|---|---|---|
| `VRF_GAME_STATUS_OFFSET` | 8 | `VrfGame.status` (must stay the first field) |
| `VRF_GAME_SAFE_REVEALS_OFFSET` | 77 | `VrfGame.safe_reveals` |
| `VRF_GAME_PENDING_OFFSET` | 79 | `VrfGame.pending` |
| `VRF_GAME_MIN_RAW_LEN` (private) | 80 | smallest prefix the raw reads need |
| player bytes in `VrfGame` | 9..41 | `refund_stalled_vrf` compares them raw |
| `GAME_V2_BET_OFFSET` | 42 | |
| `GAME_V2_SETTLED_OFFSET` | 112 | |
| `GAME_V2_MAX_PAYOUT_OFFSET` | 148 | |
| `GAME_V2_DISCRIMINATOR` | `[0x64,0x0f,0xad,0x57,0x58,0xaf,0xa9,0x64]` | |

---

## 2. Events (`#[event]`, emitted with `emit!`)

**Wire format (Anchor 0.31.1, `anchor-attribute-event` `emit!`).** `sol_log_data(&[&data])` with a **single** slice, `data = sha256("event:<Name>")[..8] ‖ borsh(event)`. The runtime prints `Program data: <base64(data)>`.

The port must pass ONE slice. Two slices would print two space-separated base64 strings and break `packages/sdk/src/events.ts`.

The event must be logged while this program is the top invoke frame (not from inside a CPI). The SDK attributes `Program data:` lines through the `Program <id> invoke [n]` / `success|failed` stack.

**Common payload facts.**
- `slot` fields are `Clock::get()?.slot`. Anchor calls the syscall again at each emit; the value is the same within a transaction, so reading it once is fine.
- `VaultFunded.new_balance` is the vault's **total lamports after the transfer**, NOT minus rent.
- `VaultUnitValueUpdated.vault_assets` = lamports − rent(428).

**Who emits what (order matters inside `settle_game`).**

| instruction | events, in order |
|---|---|
| initialize_vault | VaultInitialized |
| fund_vault | VaultFunded |
| set_referrer | ReferrerSet |
| start_game | GameStarted |
| reveal_tile | safe tile: TileRevealed(is_mine=false) · mine: TileRevealed(is_mine=true), then GameLost |
| cash_out | GameWon |
| settle_game | [if referrer set AND rem[0] given: ReferralTierChanged (only if the tier changed), then ReferralAccrued (always on that branch, even if amount=0)] → [TreasuryAccrued only if actual_treasury_cut > 0] → GameSettled → VaultUnitValueUpdated → StatsUpdated |
| claim_referral | ReferralClaimed |
| repair_referral | ReferralRepaired (NOT on the idempotent early return when already correct) |
| refund_expired | GameRefunded |
| withdraw_to_treasury | TreasuryWithdrawal |
| unlock_operator_position | OperatorUnitsUnlocked |
| update_vault | VaultUpdated |
| allowlist_add / allowlist_remove | AllowlistChanged(added=true/false) |
| propose_owner / cancel_proposed_owner / accept_ownership | OwnerProposed / OwnerProposalCancelled / OwnerAccepted |
| initialize_v2 / update_v2_config | V2Initialized / V2ConfigUpdated |
| lp_deposit / request_withdraw / cancel_withdraw / complete_withdraw / close_lp_position | LpDeposited / LpWithdrawRequested / LpWithdrawCancelled / LpWithdrawCompleted / LpPositionClosed |
| house_deposit / house_request_withdraw / house_cancel_withdraw / house_complete_withdraw | HouseDeposited / HouseWithdrawRequested / HouseWithdrawCancelled / HouseWithdrawCompleted |
| close_game, close_unsettled_game, all 10 VRF instructions, process_undelegation | **none** (vrf_mode.rs has zero `emit!`; `settle_vrf` does not even emit ReferralTierChanged) |

Offsets below are into the decoded `Program data` buffer (disc at 0..8). There are no variable-length fields in any event.

#### AllowlistChanged  `bcd3683729aa532f`  (81 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `address` | `pubkey` | 32 | 40 | 72 |
| 2 | `added` | `bool` | 1 | 72 | 73 |
| 3 | `slot` | `u64` | 8 | 73 | 81 |

#### GameLost  `c8a1e2e30b81fa9f`  (90 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `game` | `pubkey` | 32 | 40 | 72 |
| 2 | `bet` | `u64` | 8 | 72 | 80 |
| 3 | `tile_index` | `u8` | 1 | 80 | 81 |
| 4 | `safe_reveals` | `u8` | 1 | 81 | 82 |
| 5 | `slot` | `u64` | 8 | 82 | 90 |

#### GameRefunded  `386f18d1f3a555ff`  (96 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `game` | `pubkey` | 32 | 40 | 72 |
| 2 | `bet` | `u64` | 8 | 72 | 80 |
| 3 | `refund` | `u64` | 8 | 80 | 88 |
| 4 | `slot` | `u64` | 8 | 88 | 96 |

#### GameSettled  `3f6d8055e53fa7b0`  (148 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `game` | `pubkey` | 32 | 40 | 72 |
| 2 | `mine_count` | `u8` | 1 | 72 | 73 |
| 3 | `mine_layout` | `u16` | 2 | 73 | 75 |
| 4 | `salt` | `[u8; 32]` | 32 | 75 | 107 |
| 5 | `commitment` | `[u8; 32]` | 32 | 107 | 139 |
| 6 | `verified` | `bool` | 1 | 139 | 140 |
| 7 | `slot` | `u64` | 8 | 140 | 148 |

#### GameStarted  `def74eff3db89c29`  (121 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `game` | `pubkey` | 32 | 40 | 72 |
| 2 | `bet` | `u64` | 8 | 72 | 80 |
| 3 | `mine_count` | `u8` | 1 | 80 | 81 |
| 4 | `commitment` | `[u8; 32]` | 32 | 81 | 113 |
| 5 | `slot` | `u64` | 8 | 113 | 121 |

#### GameWon  `a0c6eac1e38066c7`  (105 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `game` | `pubkey` | 32 | 40 | 72 |
| 2 | `bet` | `u64` | 8 | 72 | 80 |
| 3 | `payout` | `u64` | 8 | 80 | 88 |
| 4 | `multiplier_bps` | `u64` | 8 | 88 | 96 |
| 5 | `safe_reveals` | `u8` | 1 | 96 | 97 |
| 6 | `slot` | `u64` | 8 | 97 | 105 |

#### HouseDeposited  `ad71d71ae51ba3e7`  (56 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `amount_lamports` | `u64` | 8 | 8 | 16 |
| 1 | `units_minted` | `u128` | 16 | 16 | 32 |
| 2 | `total_units_after` | `u128` | 16 | 32 | 48 |
| 3 | `slot` | `u64` | 8 | 48 | 56 |

#### HouseWithdrawCancelled  `acb8bffabda91054`  (32 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `units_returned` | `u128` | 16 | 8 | 24 |
| 1 | `slot` | `u64` | 8 | 24 | 32 |

#### HouseWithdrawCompleted  `cdb31882b1c9ba09`  (40 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `units_burned` | `u128` | 16 | 8 | 24 |
| 1 | `amount_lamports` | `u64` | 8 | 24 | 32 |
| 2 | `slot` | `u64` | 8 | 32 | 40 |

#### HouseWithdrawRequested  `fe1e163f066d7700`  (40 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `units` | `u128` | 16 | 8 | 24 |
| 1 | `unlock_slot` | `u64` | 8 | 24 | 32 |
| 2 | `slot` | `u64` | 8 | 32 | 40 |

#### LpDeposited  `55d3b89fb0e01c48`  (96 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `user` | `pubkey` | 32 | 8 | 40 |
| 1 | `amount_lamports` | `u64` | 8 | 40 | 48 |
| 2 | `units_minted` | `u128` | 16 | 48 | 64 |
| 3 | `total_units_after` | `u128` | 16 | 64 | 80 |
| 4 | `vault_assets_after` | `u64` | 8 | 80 | 88 |
| 5 | `slot` | `u64` | 8 | 88 | 96 |

#### LpPositionClosed  `d90ffaccd65acc30`  (48 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `user` | `pubkey` | 32 | 8 | 40 |
| 1 | `slot` | `u64` | 8 | 40 | 48 |

#### LpWithdrawCancelled  `d00a6e73ea9e567d`  (64 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `user` | `pubkey` | 32 | 8 | 40 |
| 1 | `units_returned` | `u128` | 16 | 40 | 56 |
| 2 | `slot` | `u64` | 8 | 56 | 64 |

#### LpWithdrawCompleted  `7b1ebe2fe2c11c53`  (96 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `user` | `pubkey` | 32 | 8 | 40 |
| 1 | `units_burned` | `u128` | 16 | 40 | 56 |
| 2 | `amount_lamports` | `u64` | 8 | 56 | 64 |
| 3 | `total_units_after` | `u128` | 16 | 64 | 80 |
| 4 | `vault_assets_after` | `u64` | 8 | 80 | 88 |
| 5 | `slot` | `u64` | 8 | 88 | 96 |

#### LpWithdrawRequested  `bfe9de83e97aaa1a`  (72 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `user` | `pubkey` | 32 | 8 | 40 |
| 1 | `units` | `u128` | 16 | 40 | 56 |
| 2 | `unlock_slot` | `u64` | 8 | 56 | 64 |
| 3 | `slot` | `u64` | 8 | 64 | 72 |

#### OperatorUnitsUnlocked  `f58617c78374fbe5`  (136 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `destination` | `pubkey` | 32 | 40 | 72 |
| 2 | `lamports` | `u64` | 8 | 72 | 80 |
| 3 | `burned_seed` | `u128` | 16 | 80 | 96 |
| 4 | `burned_house` | `u128` | 16 | 96 | 112 |
| 5 | `burned_pending` | `u128` | 16 | 112 | 128 |
| 6 | `slot` | `u64` | 8 | 128 | 136 |

#### OwnerAccepted  `733141b7487b298b`  (112 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `old_owner` | `pubkey` | 32 | 40 | 72 |
| 2 | `new_owner` | `pubkey` | 32 | 72 | 104 |
| 3 | `slot` | `u64` | 8 | 104 | 112 |

#### OwnerProposalCancelled  `2aa4695d77b359e9`  (48 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `slot` | `u64` | 8 | 40 | 48 |

#### OwnerProposed  `4c62c01e44302bbc`  (112 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `current_owner` | `pubkey` | 32 | 40 | 72 |
| 2 | `proposed_owner` | `pubkey` | 32 | 72 | 104 |
| 3 | `slot` | `u64` | 8 | 104 | 112 |

#### ReferralAccrued  `4a5d2e8e804119fe`  (89 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `referrer` | `pubkey` | 32 | 8 | 40 |
| 1 | `player` | `pubkey` | 32 | 40 | 72 |
| 2 | `amount` | `u64` | 8 | 72 | 80 |
| 3 | `tier` | `u8` | 1 | 80 | 81 |
| 4 | `slot` | `u64` | 8 | 81 | 89 |

#### ReferralClaimed  `c36d4dc486e24e6c`  (56 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `referrer` | `pubkey` | 32 | 8 | 40 |
| 1 | `amount` | `u64` | 8 | 40 | 48 |
| 2 | `slot` | `u64` | 8 | 48 | 56 |

#### ReferralRepaired  `9a450a635a8607c1`  (48 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `referrer` | `pubkey` | 32 | 8 | 40 |
| 1 | `slot` | `u64` | 8 | 40 | 48 |

#### ReferralTierChanged  `157ec425dc67d7f1`  (49 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `referrer` | `pubkey` | 32 | 8 | 40 |
| 1 | `new_tier` | `u8` | 1 | 40 | 41 |
| 2 | `slot` | `u64` | 8 | 41 | 49 |

#### ReferrerSet  `41bb1dcd74e5459a`  (80 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `referrer` | `pubkey` | 32 | 40 | 72 |
| 2 | `slot` | `u64` | 8 | 72 | 80 |

#### StatsUpdated  `32903e268c94753e`  (92 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `games_played` | `u64` | 8 | 40 | 48 |
| 2 | `games_won` | `u64` | 8 | 48 | 56 |
| 3 | `total_wagered` | `u64` | 8 | 56 | 64 |
| 4 | `total_payouts` | `u64` | 8 | 64 | 72 |
| 5 | `biggest_win` | `u64` | 8 | 72 | 80 |
| 6 | `current_streak` | `u32` | 4 | 80 | 84 |
| 7 | `slot` | `u64` | 8 | 84 | 92 |

#### TileRevealed  `e8b08136969e8fb7`  (91 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `player` | `pubkey` | 32 | 8 | 40 |
| 1 | `game` | `pubkey` | 32 | 40 | 72 |
| 2 | `tile_index` | `u8` | 1 | 72 | 73 |
| 3 | `is_mine` | `bool` | 1 | 73 | 74 |
| 4 | `multiplier_bps` | `u64` | 8 | 74 | 82 |
| 5 | `safe_reveals` | `u8` | 1 | 82 | 83 |
| 6 | `slot` | `u64` | 8 | 83 | 91 |

#### TreasuryAccrued  `56d845a7a2aeb547`  (128 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `treasury` | `pubkey` | 32 | 40 | 72 |
| 2 | `from_game` | `pubkey` | 32 | 72 | 104 |
| 3 | `bet` | `u64` | 8 | 104 | 112 |
| 4 | `amount` | `u64` | 8 | 112 | 120 |
| 5 | `slot` | `u64` | 8 | 120 | 128 |

#### TreasuryWithdrawal  `f475af2ebb6d1410`  (88 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `treasury` | `pubkey` | 32 | 8 | 40 |
| 1 | `destination` | `pubkey` | 32 | 40 | 72 |
| 2 | `amount` | `u64` | 8 | 72 | 80 |
| 3 | `slot` | `u64` | 8 | 80 | 88 |

#### V2ConfigUpdated  `070e3395b4fc25a2`  (48 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `slot` | `u64` | 8 | 40 | 48 |

#### V2Initialized  `22d57fc53df936d4`  (96 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `seed_units` | `u128` | 16 | 40 | 56 |
| 2 | `house_units` | `u128` | 16 | 56 | 72 |
| 3 | `total_units` | `u128` | 16 | 72 | 88 |
| 4 | `slot` | `u64` | 8 | 88 | 96 |

#### VaultFunded  `c077f5c137dfc332`  (64 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `funder` | `pubkey` | 32 | 8 | 40 |
| 1 | `amount` | `u64` | 8 | 40 | 48 |
| 2 | `new_balance` | `u64` | 8 | 48 | 56 |
| 3 | `slot` | `u64` | 8 | 56 | 64 |

#### VaultInitialized  `b42bcf021247034b`  (144 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `owner` | `pubkey` | 32 | 40 | 72 |
| 2 | `house_authority` | `pubkey` | 32 | 72 | 104 |
| 3 | `treasury` | `pubkey` | 32 | 104 | 136 |
| 4 | `slot` | `u64` | 8 | 136 | 144 |

#### VaultUnitValueUpdated  `7fd9881b2619f738`  (74 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `vault_assets` | `u64` | 8 | 40 | 48 |
| 2 | `total_units` | `u128` | 16 | 48 | 64 |
| 3 | `health_bps` | `u16` | 2 | 64 | 66 |
| 4 | `slot` | `u64` | 8 | 66 | 74 |

#### VaultUpdated  `5dbb91d886c90369`  (48 bytes total incl. disc)

| # | field | type | bytes | offset | end |
|---|---|---|---|---|---|
| 0 | `vault` | `pubkey` | 32 | 8 | 40 |
| 1 | `slot` | `u64` | 8 | 40 | 48 |


---

## 3. Errors

### 3.1 `KaboomError` (`#[error_code]`, code = 6000 + index, same order as `lib.rs:2711-2824`)

| code | hex | name | msg |
|---|---|---|---|
| 6000 | 0x1770 | `InvalidMineCount` | Invalid mine count. |
| 6001 | 0x1771 | `InvalidTileIndex` | Invalid tile index. |
| 6002 | 0x1772 | `TileAlreadyRevealed` | Tile already revealed. |
| 6003 | 0x1773 | `GameNotPlaying` | Game is not in playing state. |
| 6004 | 0x1774 | `BetTooLow` | Bet amount too low. |
| 6005 | 0x1775 | `BetExceedsMax` | Bet exceeds max allowed for current vault balance. |
| 6006 | 0x1776 | `VaultInsufficientFunds` | Vault has insufficient funds for the worst-case payout. |
| 6007 | 0x1777 | `Unauthorized` | Unauthorized. |
| 6008 | 0x1778 | `MathOverflow` | Arithmetic overflow. |
| 6009 | 0x1779 | `InvalidAmount` | Invalid amount. |
| 6010 | 0x177a | `InvalidConfig` | Invalid configuration parameter. |
| 6011 | 0x177b | `InvalidCommitment` | Invalid commitment (zero hash). |
| 6012 | 0x177c | `VaultPaused` | Vault is paused. |
| 6013 | 0x177d | `GameExpired` | Game has expired. |
| 6014 | 0x177e | `GameNotExpired` | Game has not expired yet. |
| 6015 | 0x177f | `CommitmentMismatch` | Commitment hash does not match mine_layout + salt. |
| 6016 | 0x1780 | `RevealMismatch` | Revealed tiles do not match the layout. |
| 6017 | 0x1781 | `GameAlreadySettled` | Game already settled. |
| 6018 | 0x1782 | `GameNotFinished` | Game not finished. |
| 6019 | 0x1783 | `NoTilesRevealed` | No tiles revealed. |
| 6020 | 0x1784 | `SelfReferral` | Cannot refer yourself. |
| 6021 | 0x1785 | `ReferrerAlreadySet` | Referrer already set. |
| 6022 | 0x1786 | `ReferralMismatch` | Referral account does not match player_stats.referrer. |
| 6023 | 0x1787 | `NothingToClaim` | Nothing to claim. |
| 6024 | 0x1788 | `DestinationNotAllowlisted` | Withdrawal destination is not on the allowlist. |
| 6025 | 0x1789 | `AllowlistFull` | Allowlist is full. |
| 6026 | 0x178a | `AlreadyAllowlisted` | Address is already on the allowlist. |
| 6027 | 0x178b | `AddressNotInAllowlist` | Address is not on the allowlist. |
| 6028 | 0x178c | `NoPendingOwner` | No pending owner to accept or cancel. |
| 6029 | 0x178d | `V2AlreadyInitialized` | V2 already initialized. |
| 6030 | 0x178e | `V2NotInitialized` | V2 not yet initialized. |
| 6031 | 0x178f | `DepositBelowMin` | Deposit below minimum. |
| 6032 | 0x1790 | `UserPositionCapExceeded` | Deposit would exceed per-user position cap. |
| 6033 | 0x1791 | `HouseShareFloorBreached` | Deposit would push vault below minimum house share. |
| 6034 | 0x1792 | `HealthFloorBreached` | Deposit or new obligation would push health below minimum. |
| 6035 | 0x1793 | `PendingWithdrawAlreadyExists` | Pending withdrawal already exists; cancel it first. |
| 6036 | 0x1794 | `NoPendingWithdraw` | No pending withdrawal to cancel or complete. |
| 6037 | 0x1795 | `CooldownNotElapsed` | Withdrawal cooldown not yet elapsed. |
| 6038 | 0x1796 | `InsufficientUnits` | Insufficient units in LP position. |
| 6039 | 0x1797 | `InsufficientLiquidity` | Vault has insufficient liquidity to honour this withdrawal. |
| 6040 | 0x1798 | `LpPositionNotEmpty` | LP position still has units; cannot close. |
| 6041 | 0x1799 | `NoOperatorUnitsToUnlock` | Operator units (seed + house + house_pending) are already zero; nothing to unlock. |
| 6042 | 0x179a | `VrfModeDisabled` | VRF game mode is disabled. |
| 6043 | 0x179b | `BadSessionKey` | Signer is not the authorized session key. |
| 6044 | 0x179c | `RevealPending` | A reveal is already pending. |
| 6045 | 0x179d | `NoRevealPending` | No reveal is pending. |
| 6046 | 0x179e | `TooManyReveals` | Too many reveals for this game. |
| 6047 | 0x179f | `ReplayMismatch` | Committed game state does not match the randomness replay. |
| 6048 | 0x17a0 | `NotStalledYet` | Game is not stalled yet. |
| 6049 | 0x17a1 | `BadGameAccount` | Malformed game account. |
| 6050 | 0x17a2 | `GameAlreadyResolved` | Game already resolved; cannot refund. |
| 6051 | 0x17a3 | `PayoutExceedsReserved` | Payout exceeds the worst case reserved for this game. |
| 6052 | 0x17a4 | `GameStillDelegated` | Game is still delegated to the rollup; its L1 state is not final. |
| 6053 | 0x17a5 | `VrfValidatorNotSet` | No VRF validator is pinned; VRF mode is hard-disabled. |
| 6054 | 0x17a6 | `WrongVrfValidator` | Delegation must go to the pinned VRF validator. |


### 3.2 Anchor framework codes the port must reproduce (where cheap; failing is mandatory)

| code | hex | name | raised by (Anchor 0.31.1) |
|---|---|---|---|
| 101 | 0x65 | InstructionFallbackNotFound | no 8-byte prefix matched (includes data < 8 bytes; there is no 100/InstructionMissing check in 0.31 dispatch) |
| 102 | 0x66 | InstructionDidNotDeserialize | Borsh arg decode failed (short data, bool/Option tag not 0/1). **Trailing bytes are accepted** (`deserialize`, not `try_from_slice`) |
| 1000 | 0x3e8 | IdlInstructionStub | not reachable: Anchor build has IDL ixs (see §10 Q1) |
| 1500 | 0x5dc | EventInstructionStub | data starts with `EVENT_IX_TAG_LE` = `e4 45 a5 2e 51 cb 9a 1d` (event-cpi feature off) |
| 2000 | 0x7d0 | ConstraintMut | `#[account(mut)]` (or implied by `init`) and `!is_writable` |
| 2001 | 0x7d1 | ConstraintHasOne | not used by this program |
| 2003 | 0x7d3 | ConstraintRaw | not used: every `constraint =` has `@ KaboomError::…` |
| 2004 | 0x7d4 | ConstraintOwner | only inside the `init_if_needed` post-check (owner ≠ program id), effectively unreachable |
| 2005 | 0x7d5 | ConstraintRentExempt | after `init`/`init_if_needed`: `lamports < rent(data_len)` |
| 2006 | 0x7d6 | ConstraintSeeds | PDA mismatch, or `create_program_address` with the stored bump failed |
| 2011 | 0x7db | ConstraintClose | `close = X` where `field.key == X.key` |
| 2012 | 0x7dc | ConstraintAddress | `address =` without a custom error (`owner_program`, `delegation_program`, `slot_hashes`, `magic_context`) |
| 2019 | 0x7e3 | ConstraintSpace | `init_if_needed` on an existing account with `data_len != space` |
| 3001 | 0xbb9 | AccountDiscriminatorNotFound | typed account `data_len < 8` |
| 3002 | 0xbba | AccountDiscriminatorMismatch | typed account wrong 8-byte disc |
| 3003 | 0xbbb | AccountDidNotDeserialize | typed account Borsh failure |
| 3004 | 0xbbc | AccountDidNotSerialize | exit write overflow (cannot happen with the fixed spaces) |
| 3005 | 0xbbd | AccountNotEnoughKeys | fewer accounts than the struct declares |
| 3007 | 0xbbf | AccountOwnedByWrongProgram | typed account owner ≠ program id (e.g. `settle_vrf` on a still-delegated `VrfGame`) |
| 3008 | 0xbc0 | InvalidProgramId | `Program<T>` key mismatch (System, VrfProgram, MagicProgram) |
| 3009 | 0xbc1 | InvalidProgramExecutable | `Program<T>` not executable |
| 3010 | 0xbc2 | AccountNotSigner | `Signer<'info>` not signer |
| **3012** | **0xbc4** | **AccountNotInitialized** | typed account with `owner == System && lamports == 0`. **Load-bearing:** `apps/web/src/server/solana.ts:154` maps it to HTTP 409 |
| 4101 | 0x1005 | TryingToInitPayerAsProgramAccount | `init` path with pre-funded lamports and `payer == field` |

Other failures pass through as `ProgramError` without Anchor wrapping:
- `try_borrow_*` → AccountBorrowFailed
- system-program CPI errors (e.g. Allocate on an existing account → `Custom(0)` AccountAlreadyInUse, from the system program)
- in `process_undelegation`: MissingRequiredSignature, InvalidAccountOwner, and the new InvalidSeeds
- `invoke_signed_vrf`: InvalidSeeds if the identity PDA cannot be found
- arithmetic panics: `overflow-checks = true` in the root profile, so a panic → program failure

### 3.3 Error logging (what Anchor prints; optional for the port)

On any `Err`, `entry` calls `e.log()`. The `Program <id> failed: custom program error: 0x…` line and the RPC `{"InstructionError":[i,{"Custom":N}]}` come from the runtime, not the program.

| origin | log line |
|---|---|
| `require!` → `error!` (Source origin) | `Program log: AnchorError thrown in programs/kaboom/src/lib.rs:<line>. Error Code: <Name>. Error Number: <n>. Error Message: <msg>.` |
| `.ok_or(KaboomError::X)?` / `.into()` (no origin) | `AnchorError occurred. Error Code: …` |
| constraint with account name | `AnchorError caused by account: <field>. Error Code: …`. Seeds/address errors add `Left:` / `<pubkey>` / `Right:` / `<pubkey>` lines; ConstraintSpace/bump add `Left: n` / `Right: n` |
| `ProgramError` variants | `ProgramError occurred. Error Code: <Debug>. Error Number: <u64>. Error Message: <Display>.` (Source / account-name variants are similar) |

Every off-chain parser falls back to the runtime-generated hex code or `"Custom":N` (§8). So **the numeric code is the contract, and the text log is cosmetic.** The default recommendation is to log nothing extra on error; see §10 Q3.

---

## 4. Constants, seeds, helpers

### 4.1 Constants (exact values)

| const | type | value | notes |
|---|---|---|---|
| GRID_SIZE | u8 | 16 | |
| MIN_MINES / MAX_MINES | u8 | 1 / 15 | |
| BPS | u64 | 10_000 | |
| GAME_EXPIRY_SLOTS | u64 | 300 | `reveal_tile` allows `slot <= start+300`; `refund_expired` needs `slot > start+300` (both saturating_add) |
| CLOSE_UNSETTLED_EXPIRY_SLOTS | u64 | 38 | `close_unsettled_game` needs `slot > start+38` |
| MIN_BET_LAMPORTS | u64 | 1_000_000 | |
| MAX_HOUSE_EDGE_BPS | u16 | 1_000 | |
| MAX_BET_BPS | u16 | 1_000 | |
| MAX_PAYOUT_BPS | u16 | 5_000 | |
| MAX_ALLOWLIST | usize | 8 | |
| REFERRAL_BRONZE/SILVER/GOLD_BPS | u16 | 50 / 60 / 70 | tier 0 / 1 / anything else (`_ =>` gold) |
| SILVER_VOLUME_LAMPORTS | u64 | 10_000_000_000 | tier = 2 if volume ≥ 100 SOL, else 1 if ≥ 10 SOL, else 0 |
| GOLD_VOLUME_LAMPORTS | u64 | 100_000_000_000 | |
| ANTI_INFLATION_SEED_LAMPORTS | u64 | 1_000_000_000 | |
| DEFAULT_WITHDRAW_COOLDOWN_SLOTS | u64 | 648_000 | |
| MIN_WITHDRAW_COOLDOWN_SLOTS | u64 | 150 | |
| MIN_HEALTH_BPS_FLOOR | u16 | 100 | |
| DEFAULT_MIN_HOUSE_SHARE_BPS | u16 | 5_000 | |
| DEFAULT_MAX_USER_POSITION_BPS | u16 | 1_000 | |
| DEFAULT_MIN_HEALTH_BPS | u16 | 1_000 | |
| DEFAULT_MIN_LP_DEPOSIT_LAMPORTS | u64 | 10_000_000 | |
| treasury split default | u16 | 5_000 | literal in initialize_vault |
| VRF_PLAYING / VRF_WON / VRF_LOST | u8 | 0 / 1 / 2 | `VrfGame.status` (plain u8, NOT validated as an enum) |
| NO_TILE | u8 | 255 | |
| STALL_SLOTS | u64 | 25 | `refund_stalled_vrf` needs `slot > start+25` |
| ABANDON_SLOTS | u64 | 216_000 | `admin_release_vrf_claim` needs `slot > start+216000` |
| COMMIT_FREQUENCY_MS | u32 | 1_000 | DelegateConfig |
| MAX_VRF_REVEALS | usize | 16 | |
| VrfClaim::SIZE / VrfGame::SIZE | usize | 61 / 613 | space = 8 + SIZE |
| Vault / V2 / LpPosition / GameSession / PlayerStats / ReferralAccount SPACE | usize | 428 / 191 / 121 / 180 / 203 / 103 | |
| GameSessionV2::SPACE | usize | 221 | |

### 4.2 Seeds (byte strings)

| const | bytes | full seeds |
|---|---|---|
| VAULT_SEED | `b"kaboom_vault"` | `[VAULT_SEED]` |
| VAULT_V2_SEED | `b"kaboom_v2_state"` | `[VAULT_V2_SEED]` |
| LP_SEED | `b"kaboom_lp"` | `[LP_SEED, user]` |
| GAME_SEED | `b"kaboom_game"` | `[GAME_SEED, player]` (uses `game.player` from the account's own data in non-init contexts) |
| GAME_V2_SEED | `b"game_v2"` | `[GAME_V2_SEED, player]` |
| STATS_SEED | `b"kaboom_stats"` | `[STATS_SEED, player]` |
| REFERRAL_SEED | `b"kaboom_referral"` | `[REFERRAL_SEED, referrer]` |
| VRF_CLAIM_SEED | `b"kaboom_vrf_claim"` | `[VRF_CLAIM_SEED, player]` |
| VRF_GAME_SEED | `b"kaboom_vrf_game"` | `[VRF_GAME_SEED, player]` (uses `game.player` from data in reveal_request / cash_out / settle_and_undelegate) |
| VRF identity | `b"identity"` | `[b"identity"]` under this program; `[b"identity", program_id]` under the VRF program |
| DLP buffer | `b"buffer"` | `[b"buffer", game]` under **this** program |
| DLP record / metadata | `b"delegation"` / `b"delegation-metadata"` | `[tag, game]` under DLP |
| DLP undelegate buffer | `b"undelegate-buffer"` | `[tag, delegated_account]` under DLP |

### 4.3 Helpers (exact integer semantics; MathOverflow = 6008, InvalidMineCount = 6000)

All intermediate math is u128 `checked_*`; any `None` → 6008. `u64::try_from` failure → 6008. Plain operators panic on overflow because `overflow-checks = true`.

**`calc_multiplier(safe: u8, mines: u8, edge: u16) -> u64`** (`lib.rs:1790`)
1. If `safe == 0`: return 10_000. No other check happens, even for `mines = 0` or out-of-range mines.
2. Require `mines + safe <= 16`, else 6000.
3. `num = 1, den = 1`. For `i in 0..safe`:
   - `tiles = 16 - i`
   - `safe_rem = 16 - mines - i` (checked → 6008)
   - require `safe_rem > 0` (6000; unreachable after step 2)
   - `num *= tiles; den *= safe_rem` (checked)
4. `raw = num * 10_000 / den` (floor).
5. `edge_factor = (10_000u64 - edge as u64)`. This is a u64 subtraction: it panics if edge > 10_000, which every caller prevents.
6. `final = raw * edge_factor / 10_000` (floor), then `u64::try_from`.

Parity oracle: `tests/fixtures/multiplier.json` has 675 rows (`safe_reveals`, `mine_count`, `edge_bps` ∈ {0,100,200,500,1000}, `expected_bps`) covering mines 1..15 and safe 0..16−mines. The in-repo test `lib.rs:3146` asserts every row; the port must ship the same test. Also port the tests at `lib.rs:3168-3286`:
- zero reveals = 10_000
- `(15,2)`, `(16,1)`, `(2,15)` must Err
- worst-case linear in bet
- payout ≤ reserved over every pair
- `decide_mine` exactly uniform

**`mul_div_floor(a: u64, num: u64, den: u64) -> u64`**: `(a as u128 * num as u128) / den`. Checked; `den == 0` → 6008; then `u64::try_from` → 6008.

**`worst_case_payout(bet, mines, edge)`**: `worst_safe = 16.saturating_sub(mines)`; `mul_div_floor(bet, calc_multiplier(worst_safe, mines, edge)?, 10_000)`.

**`vault_assets(vault_info)`**: `lamports.saturating_sub(Rent.minimum_balance(428))`. The handlers inline the same formula many times as `available` / `rent`.

**`deposit_to_units(amount: u64, assets_pre: u64, total_units: u128) -> u128`**:
- if `total_units == 0`: return `amount`
- else require `assets_pre > 0` (6008), then `amount * total_units / assets_pre` (checked, floor, NO u64 cast)

**`units_to_assets(units: u128, assets: u64, total_units: u128) -> u64`**:
- if `total_units == 0 || units == 0`: return 0
- else `units * assets / total_units` (checked), then `u64::try_from`

**`user_units_total(v2)`**: `total_units - seed_units - house_units - house_pending_units`, each step checked (6008).

**`calc_health_bps(v2, assets) -> u16`**:
1. if `assets == 0`: return 0
2. `pending = units_to_assets(v2.total_pending_units, assets, v2.total_units)?`
3. `obl = v2.total_outstanding_max_payout + pending` (checked)
4. `free = assets.saturating_sub(obl)`
5. `h = free * 10_000 / assets` (u128), then `min(h, 10_000) as u16`

**`enforce_min_health(v2, assets)`**: if `min_health_bps == 0` → Ok; else `calc_health_bps >= min_health_bps`, else **6034** HealthFloorBreached.

**`enforce_house_floor(house_after: u128, user_total: u128, min_share: u16)`**:
- if `min_share == 0` → Ok
- `denom = house + user` (checked); if `denom == 0` → Ok
- require `house * 10_000 >= min_share * denom` (checked), else **6033**

**`enforce_user_position_cap(value: u64, assets: u64, health: u16, max_bps: u16)`**:
- if `max_bps == 0` → Ok
- `cap = ((assets * max_bps / 10_000) * health) / 10_000`, flooring at each division (u128 checked)
- require `value <= cap`, else **6032**

**`admin_spendable(vault_info, v2)`** (vrf_mode.rs:176): `a = vault_assets()`; return `a.saturating_sub(1)` if `v2.total_units > 0`, else `a`. Used ONLY by `admin_release_vrf_claim` and `admin_close_orphaned_game_v2`.

**`decide_mine(randomness: &[u8;32], safe: u8, mines: u8) -> bool`** (vrf_mode.rs:192):
- `remaining = 16.saturating_sub(safe) as u64`; if 0 → false
- `x = u64::from_le_bytes(randomness[0..8]) % remaining`
- return `x < mines`

**`check_vrf_game_delegable(owner, data)`** (vrf_mode.rs:372), checked in this order:
1. `owner == program_id`, else 6052
2. `len >= 80`, else 6049
3. `data[..8] == VrfGame disc`, else 6049
4. `data[8] == 0` (Playing), else 6050
5. `data[79] == 0`, else 6044

**Commitment hash** (settle_game, `lib.rs:523-532`): `sha256(mine_layout.to_le_bytes() [2 bytes] ‖ [mine_count] [1 byte] ‖ salt [32 bytes])`, 35 bytes in total, compared with `game.commitment`; mismatch → 6015.
- Port: use the `sol_sha256` syscall with one or three slices (same digest, about 85 + 0.5·35 CU) instead of linking `sha2`.
- Subsequent checks:
  - `popcount(layout) == mine_count` (6015)
  - `revealed_safe_mask & layout == 0` (6016)
  - `mine_mask = revealed_mask & !revealed_safe_mask`; require `mine_mask & layout == mine_mask` (6016)
  - if Lost, `mine_mask != 0` (6016)

**Tile bit**: `1u16 << tile`. Callers range-check `tile < 16` first, except `reveal_callback_vrf`. There `pending_tile` comes from rollup state: a value ≥ 16 makes the shift overflow, a panic with overflow-checks on. Keep the panic (or fail) for parity.

---

## 5. Anchor 0.31.1 runtime semantics the port must reproduce

Read from `~/.cargo/registry/src/index.crates.io-*/anchor-syn-0.31.1/src/codegen/{program,accounts}/*` and `anchor-lang-0.31.1/src/{accounts/account.rs,common.rs,error.rs}`.

### 5.1 Dispatch and the instruction log line

1. `entry` checks `program_id == ID` (4100 otherwise; unreachable on-chain).
2. `dispatch` tests `data.starts_with(disc)` for each of the 42 instructions, in declaration order. The discriminators are unique, so order does not matter.
3. Then the IDL tag `40 f4 bc 78 a7 e9 69 0a` → Anchor IDL management instructions (see §10 Q1).
4. Then the event tag → 1500.
5. Else → **101**.

The per-instruction wrapper (`handlers.rs`) runs these steps in this exact order:
1. `msg!("Instruction: <PascalCase>")` → `Program log: Instruction: <Name>`. Printed **first**, before args or accounts are decoded, so it appears even when the instruction then fails.
2. Borsh-decode the args from `data[8..]`, failure → 102.
3. `try_accounts` (§5.3).
4. The handler.
5. `exit` (§5.6).

Names are in §9. Use them byte-for-byte (`AdminCloseOrphanedGameV2`, `InitializeV2`, `UpdateV2Config`, `ProcessUndelegation`, …). `apps/web` greps `Instruction: SettleVrf`. Cost: one `sol_log_` of ≤ 37 bytes, about 100 CU.

### 5.2 Argument decoding

Borsh 0.10 `deserialize(&mut &data[..])` reads fields in signature order:
- `u8/u16/u64/u128` LE
- `bool` strict 0/1
- `Option<T>` tag strict 0/1, then T
- `Pubkey` / `[u8;32]` raw

Short data → 102. Extra trailing bytes are **ignored**. The port must accept trailing bytes (and must not read them) to keep identical accept-sets.

### 5.3 Account validation order (`try_accounts.rs`, `constraints.rs::linearize`)

Pass A: walk the accounts in declaration order (fewer than needed → **3005**) and run each type's loader.

| declared type | loader check |
|---|---|
| `Account<T>` / `Box<Account<T>>` | (owner == System && lamports == 0) → 3012; owner ≠ program → 3007; len < 8 → 3001; disc ≠ → 3002; Borsh → 3003 |
| `Signer` | `!is_signer` → 3010 |
| `Program<System|VrfProgram|MagicProgram>` | key ≠ id → 3008; `!executable` → 3009 |
| `UncheckedAccount` / `AccountInfo` | nothing |
| `init` / `init_if_needed` fields | just taken from the slice; NOT loaded yet |

Pass B: run the `init` / `init_if_needed` fields' constraint blocks, in declaration order (§5.4).

Pass C: for every non-init field, in declaration order, its constraints in this fixed order:
1. `seeds` (2006)
2. `mut` (2000)
3. `signer` (none used here beyond the `Signer` type)
4. `has_one` (unused)
5. `constraint = … @ E` (custom code)
6. `owner` (unused)
7. `rent_exempt`
8. `executable`
9. `close` self-target check (2011)
10. `address = … [@ E]` (2012 or the custom code)

Example, `SettleVrf.claim`: seeds 2006 → mut 2000 → `claim.player == player` 6007 → close-target 2011.

Seeds forms:
- `seeds = [...], bump = <field>.bump` → `create_program_address(seeds ‖ [stored_bump])`. Err → 2006; key mismatch → 2006.
- `seeds = [...], bump` (no target) on a non-init field → `find_program_address` (canonical), and the bump goes into `ctx.bumps`. This form is used by:
  - `SettleGame.player_stats` (hot path; the bump is used when `stats.player == default`)
  - `DelegateVrf.game`
  - `DelegateVrf.buffer_game` / `delegation_record_game` / `delegation_metadata_game` (`seeds::program` = this program / `delegation_program.key()`)
  - `RefundStalledVrf.game`
  - `AdminCloseOrphanedGameV2.game`
  - `RevealRequestVrf.program_identity`
  - `InitializeAfterUndelegation`: no seeds in 0.15.5

Optimizations allowed (same accept-set and same code):

**Typed `Account<T>` fields.** Anchor validated owner + disc BEFORE the seeds check, and only the canonical address can hold such an account. So the port may use the account's stored bump with `create_program_address`, or a compile-time constant for the singletons, in place of `find`. This applies to e.g. `SettleGame.player_stats`.

**Unchecked fields** (DelegateVrf.game, RefundStalledVrf.game, AdminCloseOrphanedGameV2.game, delegation PDAs). Use `try_find_program_address` (exact). A data-stored bump is not trustworthy before the owner check and could change which error fires.

Use `try_find_program_address`, never the panicking `find_program_address` (task rule; it also avoids linking the ProgramError Debug table). `None` → 2006 (Anchor would panic; both fail).

The `settle_game` / `settle_vrf` referral PDA: Anchor uses `Pubkey::find_program_address([REFERRAL_SEED, referrer])` BEFORE loading the account. Mismatch → 6022, then `Account::try_from` (3012/3007/3001/3002/3003), then `ra.referrer == referrer_key` (6022). Keep that order: `try_find` first. A stored-bump shortcut would turn some 6022s into 3007s.

### 5.4 `init` and `init_if_needed` (Program-owned, `constraints.rs:1032-1127`, `generate_create_account` :1621)

`init` implies `mut` and `rent_exempt = enforce`; the payer is a separately declared `#[account(mut)] Signer`. In Pass B, per field:

1. `(pda, bump) = find_program_address(seeds, program_id)`; `ctx.bumps.<field> = bump`. If `key != pda` → **2006**. Init seeds always use the canonical bump.
2. `rent = Rent::get()`. Then, if `!if_needed || owner == System`, create the account:
   - **Case `lamports == 0`:** `system_program::create_account(from = payer, to = field, lamports = rent.minimum_balance(space), space, owner = program_id)`, signed by `[seeds…, [bump]]`.
   - **Case `lamports > 0` (someone pre-funded the PDA):**
     - `require payer != field`, else **4101**
     - `top_up = max(rent.minimum_balance(space), 1).saturating_sub(lamports)`; if > 0, `system_program::transfer(payer → field, top_up)` (unsigned, payer signs)
     - `system_program::allocate(field, space)` signed by the PDA seeds
     - `system_program::assign(field, program_id)` signed by the PDA seeds
     - If the account already holds data or is not system-owned (e.g. `start_game` while a GameSession exists), `allocate` fails inside the system program with `Custom(0)` AccountAlreadyInUse. So plain `init` on an existing account FAILS. Keep this.
   - The freshly created account is then "loaded unchecked": owner check only, no disc check; the struct is all zeros (`GameStatus::Playing`, `Option::None`, `false`). **The discriminator is only written at exit.**
3. `else` (`init_if_needed` and the account is already owned by someone other than System): a full checked load (owner 3007, 3001/3002/3003).
4. If `if_needed` (both paths), in this order (`constraints.rs:1107-1123`):
   - `space == data_len`, else **2019**
   - `owner == program_id`, else ConstraintOwner 2004 (Anchor reads `actual_field.owner` through a reference into the account, so after the create CPIs it already sees the new owner)
   - `lamports >= rent.minimum_balance(space)`, else **2005**
5. Pass-C-style checks for the init field: `mut` (2000), then `rent_exempt` (`is_exempt(lamports, data_len)`, else 2005).

Handlers detect "first time" by a zero key field: `stats.player == default`, `referral.referrer == default`, `position.user == default`. A pre-funded system account creates a zeroed account, so it behaves as first-time.

`Rent.minimum_balance(n)` in Anchor (solana-rent 2.2.1) is `(((128 + n) * lamports_per_byte_year) as f64 * exemption_threshold) as u64`. Pinocchio 0.11 `try_minimum_balance` reads only the first u64 and computes `(128 + n) * lamports_per_byte`. With today's mainnet sysvar (5080, 1.0) these are identical. SIMD-0194 fixed the threshold at 1.0, so they stay identical. Rent values for every space are listed in §1.

### 5.5 `close = target` (`anchor-lang common.rs::close`, run from exit)

In order:
1. `target.lamports += acct.lamports` (`checked_add(...).unwrap()`, a panic on overflow)
2. `acct.lamports = 0`
3. `acct.assign(System)`
4. `acct.realloc(0)` (data_len → 0)

It runs in **exit**, after the handler. Lamport moves the handler already made to the same target come first; the rent lands after.

Self-target is rejected up front with 2011.

Fields with `close`: `CloseGame.game`, `CloseUnsettledGame.game`, `CloseLpPosition.position` (→ user), `SettleVrf.claim` + `SettleVrf.game`, `RefundStalledVrf.claim`, `AdminReleaseVrfClaim.claim` (→ player).

**Manual "close" (NOT Anchor close; reproduce exactly).** `refund_stalled_vrf.game` (always program-owned at that point) and `admin_close_orphaned_game_v2.game` (only `if owner == program_id`):
- `player.lamports += acct.lamports`
- `acct.lamports = 0`
- `data.fill(0)`
- **owner left as this program, data_len left unchanged** (621 / 221)

The runtime purges the zero-lamport account after the transaction. Within the same transaction a later `init` on that PDA would hit the "lamports == 0" branch, and `create_account` would then fail (AccountAlreadyInUse: data non-empty and not system-owned). Keep this exact behaviour; do not "upgrade" it to a full close.

### 5.6 `Account<T>` exit (persist)

- After the handler returns Ok, `exit` walks the fields in declaration order:
  - `close` fields → §5.5
  - fields marked `mut` (explicit, or implied by `init`) → `exit_with_expected_owner(&T::owner(), program_id)`, which serializes `disc ‖ borsh(struct)` from offset 0 **if `T::owner() == program_id` (always true here) and not `is_closed`** (`is_closed` = live owner System && data empty). The account's *live* owner is NOT checked, so Anchor rewrites the bytes even when a CPI changed the owner (e.g. `settle_and_undelegate_vrf.game`). That write is byte-identical, so it is invisible; the port writes nothing there (`anchor-lang account.rs:252-265, 357-359`).
  - Non-mut typed accounts are never written.
- exit does NOT check `is_writable`. Writing changed bytes to a read-only account fails at the runtime level (ReadonlyDataModified). Pinocchio writes get the same runtime check.
- Writing back unchanged bytes is a no-op. So the port only has to write the fields a handler changes, plus the full image (with disc) for init accounts.

Handlers that rely on exit / in-memory copies (the port must write these explicitly):

- **Init accounts:** the whole image, discriminator included. Applies to `initialize_vault.vault`, `start_game.game`, `initialize_v2.v2_state`, `start_game_vrf.claim` + `game`. The `init_if_needed` accounts too, on the create path: `player_stats`, `referral_account`, `position`.
- **Counters on Vault:** `total_games`, `total_wagered` (start_game, start_game_vrf); `total_payouts` (cash_out, settle_vrf).
- **`settle_game` / `settle_vrf` referral account from `remaining_accounts[0]`:**
  - Loaded with `Account::try_from` (§5.3 codes).
  - Changed: `accrued_lamports += cut`, `total_earned += cut`, `referred_volume += bet`, `tier`.
  - Persisted by an explicit `ra.exit(&ID)` **before** the `ReferralAccrued` emit. The lamports (`actual_cut`) move directly on the AccountInfo.
  - If the client passes it read-only, the runtime rejects the transaction (lamport or data change on a read-only account).
- **`settle_vrf`** sets `claim.settled = true`, then closes `claim`. The flag is never persisted, and the port need not write it.
- **Accounts marked `mut` but never changed** (exit is a no-op): e.g. `cash_out.v2_state`, the `vault` data in `refund_stalled_vrf` / `admin_*` / `complete_withdraw` (only lamports change), `withdraw_to_treasury.vault`. The port can skip these writes.
- **Typed copy vs live lamports.** `Account<T>` holds a *copy* of the data, while lamports are always read live from the AccountInfo. Handlers that move lamports and then re-read `lamports()` (e.g. `settle_game` recomputes `assets_now` after the referral and treasury cuts; `unlock_operator_position` re-reads after the transfer) see the live value. Zero-copy reproduces this naturally.

### 5.7 System transfers and direct lamport moves

- `system_program::transfer(from, to, amount)` is a CPI with metas `[from W S, to W]`. It is used for the bet / deposit / fund moves INTO the vault: fund_vault, start_game, start_game_vrf, lp_deposit, house_deposit, plus the init top-ups. Use `pinocchio_system::instructions::Transfer`.
- Every payout OUT of a program-owned account is a direct lamport edit (`checked_sub` / `checked_add`, else 6008): vault → player / treasury / referral / destination / owner, and referral → referrer. Use `set_lamports`.
- The `Program<System>` account is required in the struct even where a handler does not CPI, e.g. `settle_vrf`. Keep it in the account list (3008/3009 checks).

### 5.8 Sysvars

- `Clock::get()` uses `slot` and `unix_timestamp`; `Rent::get()`.
- Anchor calls them repeatedly. The values are constant within a transaction, so fetch each once per instruction (CU).

### 5.9 Panics and overflow

- The Anchor build has `overflow-checks = true` and `lto = "fat"`. Its entrypoint installs a panic handler that logs `panicked at …`. A panic = instruction failure (ProgramFailedToComplete).
- Required profile (task rule): `overflow-checks = true`, `panic = "abort"`. Any expression that panics in Anchor (u8 `GRID_SIZE - mine_count` on rollup data, shift ≥ 16, `count - 1`) must still fail.

---

## 6. MagicBlock: `#[ephemeral]`, delegate, commit, VRF

### 6.1 `#[ephemeral]` (ephemeral-rollups-sdk-attribute-ephemeral 0.15.5)

It injects exactly one instruction into `mod kaboom`: `process_undelegation(ctx: Context<InitializeAfterUndelegation>, account_seeds: Vec<Vec<u8>>)`. It also adds unused `use` items and the `MagicProgram` import.

- **discriminator** `sha256("global:process_undelegation")[..8]` = `c41c29ce302533a7` = DLP's `EXTERNAL_UNDELEGATE_DISCRIMINATOR [196,28,41,206,48,37,51,167]`.
- Log `Instruction: ProcessUndelegation`.
- **args**: Borsh `Vec<Vec<u8>>` = `u32 n ‖ n × (u32 len ‖ bytes)`. Trailing bytes are ignored (102 on short data).
- **accounts** (0.15.5):

  | # | account | 0.15.5 constraint | IDL flags |
  |---|---|---|---|
  | 0 | `base_account` | `#[account(mut)]` UncheckedAccount | W |
  | 1 | `buffer` | `#[account()]` UncheckedAccount, **no seeds, no checks** | - |
  | 2 | `payer` | `#[account(mut)]` UncheckedAccount (not Signer) | W |
  | 3 | `system_program` | UncheckedAccount, **no address check** | - |

- **logic** (`ephemeral-rollups-sdk-0.15.5/src/cpi.rs:282-324` `undelegate_account`):
  1. `buffer.is_signer`, else MissingRequiredSignature
  2. `buffer.owner == DLP`, else InvalidAccountOwner
  3. `bump = find_program_address(account_seeds, program_id)` (canonical)
  4. `create_pda(base_account, owner = program_id, space = buffer.data_len(), seeds ‖ [bump], system_program, payer, rent_exempt = true)`:
     - if `base.lamports == 0`: `create_account(payer → base, rent(space), space, program_id)`, signed by the PDA
     - else: transfer the top-up `rent(space) − lamports` (if > 0), then `allocate` (signed), then `assign` (signed)
  5. `base.data.copy_from_slice(buffer.data)`
- **The 0.15.5 vulnerability (fixed in 0.16.2, 2026-07-22, after the Flash Trade exploit; RustSec PR #3356 still open, `cargo audit` silent).** `buffer` is only checked to be *a DLP-owned signer*. Nothing ties it to `base_account`, so the bytes copied into the re-created PDA can come from a different delegated account's undelegate buffer. 0.16.2 adds two things: `is_canonical_undelegation_buffer(base, buffer)`, i.e. `buffer == find_program_address([b"undelegate-buffer", base], DLP)`, which returns InvalidSeeds; and, in the macro, `seeds = [b"undelegate-buffer", base_account.key()], bump, seeds::program = DLP` on `buffer` plus `address = system_program::ID` on `system_program`.
- **Vendored `ephemeral-rollups-pinocchio` 0.17.3 does it correctly.** `pinocchio/vendor/ephemeral-rollups-pinocchio-0.17.3/src/instruction/undelegate.rs` `undelegate(delegated, owner_program, buffer, payer, callback_args)`, in order:
  1. buffer is a signer (MissingRequiredSignature)
  2. `buffer.owned_by(DLP)` (InvalidAccountOwner)
  3. `buffer == undelegate_buffer_pda_from_delegated_account(delegated)` (InvalidSeeds) **← the fix**
  4. parse `callback_args` as the Borsh `Vec<Vec<u8>>`
  5. find the bump, `CreateAccount` signed, copy the buffer

  It is called with `callback_args = data[8..]`.

  Divergences from 0.15.5 / 0.16.2 the port must decide on:
  - (a) It **rejects trailing bytes**, `seeds_len == 0`, and `> 16` seeds (InvalidInstructionData). Anchor accepts trailing bytes. DLP sends exact data, so this is harmless; prefer the stricter version.
  - (b) It **only uses `CreateAccount`**: there is no pre-funded (`lamports > 0`) branch. During DLP undelegate the account was just drained by DLP in the same instruction, so lamports are 0. Accept the stricter version or add the allocate+assign branch (see §10 Q5).
  - (c) It does not check `system_program`'s address. Add `system_program == 11111111111111111111111111111111` (as 0.16.2 does) and `base_account.is_writable` / `payer.is_writable` (2000 in Anchor).
  - (d) It uses `Address::find_program_address` (`pda.rs`, which panics on no bump). Patch to `try_find_program_address`, or call our own.
- **Which accounts can come back.** In practice only `VrfGame` (`[b"kaboom_vrf_game", player]`); `delegate_vrf` is the only delegating instruction. Optional hardening, not parity: require `account_seeds[0] == b"kaboom_vrf_game"` and len == 2. This does not change any legitimate flow.

### 6.2 `#[delegate]` on `DelegateVrf` (sdk-attribute-delegate 0.15.5) + `delegate_game`

Final account list:
1. `player` (W S)
2. `buffer_game` (W): `seeds = [b"buffer", game], bump, seeds::program = crate::id()`
3. `delegation_record_game` (W): `[b"delegation", game]` under `delegation_program.key()`
4. `delegation_metadata_game` (W): `[b"delegation-metadata", game]` under `delegation_program.key()`
5. `game` (W): `[b"kaboom_vrf_game", player]`, bump. The `del` attribute is stripped from it.
6. `v2_state` (RO, stored bump)
7. `owner_program` (`address = crate::id()` → 2012)
8. `delegation_program` (`address = DLP` → 2012)
9. `system_program` (`Program<System>`)

The new fields are inserted before the `del` field; the three program fields are appended. `remaining_accounts[0]` is an optional validator.

Note: record and metadata seeds are derived against the *passed* `delegation_program` key in Pass C, before that field's own address check runs. A wrong DLP therefore fails 2006 on the record first, not 2012.

`delegate_account` (sdk 0.15.5 `cpi.rs`), in order:
1. `pda_bump = find(pda_seeds, owner_program)`; `buffer_bump = find([b"buffer", pda], owner_program)`.
2. `create_pda(buffer, owner = program_id, space = pda.data_len(), buffer seeds, system, payer, rent_exempt = false)`:
   - lamports 0 → `create_account` with **0 lamports**
   - pre-funded → allocate + assign, signed
3. Copy `pda.data` → `buffer.data`; zero `pda.data` (memset).
4. If `pda.owner != System`, assign it to System directly (allowed: program-owned with zeroed data). Then `system::assign(pda, DLP)`, signed by the pda seeds.
5. DLP `Delegate` CPI:
   - data = `0u64 LE (8 bytes) ‖ borsh{ commit_frequency_ms: u32 = 1000, seeds: Vec<Vec<u8>> = [b"kaboom_vrf_game", player], validator: Option<Pubkey> = Some(v2.vrf_validator) }`
   - metas: `[payer W S, pda W S, owner_program R, buffer W, delegation_record W, delegation_metadata W, system_program R]`
   - signed by the pda seeds
6. `close_pda_with_system_transfer(buffer)`: `resize(0)`, `assign(System)`, then if lamports > 0, `system::transfer(buffer → payer, all)` signed by the buffer seeds.

Pinocchio equivalent: `ephemeral_rollups_pinocchio::instruction::{delegate_account, DelegateAccountCpiBuilder}` with accounts `[payer, pda, owner_program, buffer, record, metadata, system]`, `seeds = &[b"kaboom_vrf_game", player]`, `bump`, `DelegateConfig { commit_frequency_ms: 1000, validator: Some(pinned) }`. Its arg encoding (`types.rs::try_to_slice`) and metas are byte-identical.

Differences:
- **Pre-funded buffer.** It creates the buffer with `CreateAccount` only, so a griefer who pre-funds `buffer_game` makes `delegate_vrf` fail. 0.15.5 handled this with allocate+assign. Fix: reproduce the 0.15.5 `create_pda(rent_exempt = false)` branch in our own code (§10 Q5).
- **Buffer close.** It closes the buffer by a direct lamport move to payer, then `resize(0)` + `assign`. The end state is the same.
- **Duplicate bump search.** It re-finds the buffer bump. Pass-C already found it; reuse it if writing our own (CU).
- **Stack.** It puts a 625-byte data buffer and 16-entry seed arrays on the stack; watch the 4 KB frame (task rule: zero "Stack offset exceeded" warnings).

### 6.3 `#[commit]` on `SettleAndUndelegateVrf` + `MagicIntentBundleBuilder`

The macro appends:
- `magic_program: Program<MagicProgram>` (3008/3009)
- `magic_context: #[account(mut, address = MAGIC_CONTEXT_ID)] UncheckedAccount` (2000 / 2012)

The handler runs `MagicIntentBundleBuilder::new(payer, magic_context, magic_program).commit_and_undelegate(&[game]).build_and_invoke()`. This produces ONE CPI to the Magic program:
- data: bincode `MagicBlockInstruction::ScheduleIntentBundle(args)` (u32 LE variant 11 ‖ payload)
- metas: deduped `[payer (forced W S), magic_context (forced W, non-signer), game (flags as passed)]`
- no callbacks, so no `AddActionCallback`

It runs inside the ER only.

Pinocchio equivalent: `ephemeral_rollups_pinocchio::intent_bundle::MagicIntentBundleBuilder::new(payer, magic_context, magic_program).commit_and_undelegate(&[game]).build_and_invoke(&mut buf)`. Its `SCHEDULE_INTENT_BUNDLE_DISCRIMINANT = 11u32`; an upstream test asserts canonical encoding.

The legacy `instruction::commit_and_undelegate_accounts` sends the deprecated `ScheduleCommitAndUndelegate` (`[2,0,0,0]`); do **not** use it for parity. Add a unit test that the bytes equal what sdk 0.15.5 / 0.17.3 produce for `[payer, ctx, game]`.

### 6.4 `#[vrf]` on `RevealRequestVrf` + `invoke_signed_vrf` (ephemeral-vrf-sdk-vrf-macro 0.4.1)

The macro appends:
- `program_identity`: `seeds = [b"identity"], bump` → find, 2006
- `vrf_program`: `Program<VrfProgram>`, 3008/3009
- `slot_hashes`: `address = SlotHashes` → 2012
- `system_program`: `Program<System>`

The handler builds `create_request_scoped_randomness_ix(RequestRandomnessParams{ payer: session, oracle_queue, callback_program_id: ID, callback_discriminator: RevealCallbackVrf disc (8 bytes 0cdfcd0f3a017c56), caller_seed: [client_seed; 32], accounts_metas: Some([{game, is_signer: false, is_writable: true}]), callback_args: None })`.

Wire format:
- ix program = VRF program
- metas `[payer W S, program_identity R S, oracle_queue W, system_program R, slot_hashes R]`
- data:
  - `[10,0,0,0,0,0,0,0]` (scoped request; the macro maps any first byte ≠ 3/11 to 10)
  - `caller_seed[32]`
  - `callback_program_id[32]`
  - `u32 8 ‖ disc[8]`
  - `u32 1 ‖ (game[32], 0x00, 0x01)`
  - `u32 0` (empty callback_args)
  - 126 bytes in total

`invoke_signed_vrf` re-runs `try_find_program_address([b"identity"], ID)` (`None` → InvalidSeeds) and calls `invoke_signed` with infos `[payer, program_identity, oracle_queue, slot_hashes]` and signer `[b"identity", [bump]]`.

Pinocchio equivalent: `ephemeral_rollups_pinocchio::vrf::{RequestRandomness{ high_priority: false, … }, RequestRandomnessCpi}`. It must be the **patched** vendored copy: `vendor-vrf-instruction.patch` turns `.expect(...)` into `?`. Its `serialize_into(…, REQUEST_SCOPED_RANDOMNESS_DISCRIMINATOR = 10)` produces the same bytes; there is an upstream test against the canonical builder. It passes `system_program` in the infos as well, which is harmless. Sign with the constant bump 253 (§0).

### 6.5 `#[vrf_callback]` on `RevealCallbackVrf`

The macro inserts at index 0: `vrf_program_identity: Signer` with `address = scoped_vrf_identity(&crate::ID)` (3010 if not a signer; 2012 if wrong). For the new ID that is the constant `DypFSEHLnVdULGoAiGq7NmKfi8w5vSCYEXKwkfVMcMbh`.

Then `game: Account<VrfGame>` (mut). There are **no seeds** on `game` in the callback. Its address is trusted because only the VRF program, signing as our scoped identity, can invoke the callback, with the meta we requested.

---

## 7. security.txt (`lib.rs:35-46`, gated `#[cfg(not(feature = "no-entrypoint"))]`)

Use the same crate. `solana-security-txt` (lockfile has 1.1.2, Cargo.toml says 1.1.1) has zero dependencies without the `parser` feature. It emits `#[no_mangle] pub static security_txt: &str` containing:

```
=======BEGIN SECURITY.TXT V1=======\0
name\0PlayKaboom\0
project_url\0https://www.playkaboom.gg\0
contacts\0link:https://x.com/playkaboomgg\0
policy\0https://github.com/penguinpecker/playkaboom/blob/main/SECURITY.md\0
preferred_languages\0en\0
source_code\0https://github.com/penguinpecker/playkaboom\0
source_revision\0main\0
auditors\0Self-audited (sealevel-attacks + Slowmist + crytic/solana-lints checklists). Pending external audit.\0
acknowledgements\0Thanks to the Neodyme, OtterSec, and Sec3 teams for their public Solana security research.\0
=======END SECURITY.TXT V1=======\0
```

(No newlines; `\0` separators; the field order is exactly as above.)

The macro's `link_section = ".security.txt"` is gated on `target_arch = "bpf"`, so on today's `sbf` toolchain the section attribute does not apply. The Anchor `.so` still contains the string (verified). Explorers scan for the BEGIN/END markers, so nothing more is needed. Keep the `#[no_mangle]` static so LTO/strip does not drop it.

See §10 Q4 on whether `auditors` should change for an unaudited port.

---

## 8. Off-chain code that depends on exact bytes (file:line)

Every item stays valid after a pure program-id swap only if the port keeps the bytes listed here.

**Log lines**
- `apps/web/src/app/api/verify/route.ts:88` and `apps/web/src/app/api/verify/[signature]/route.ts:66`: `logs.some(l => l.includes("Instruction: SettleVrf"))` picks the VRF verify path.
- `packages/sdk/src/events.ts:10,12,14,570-600` (`extractEventsFromLogs`):
  - `"Program data: "` prefix, base64 decode
  - attributes each line to the top of the invoke stack, rebuilt from runtime `Program <id> invoke [n]` / `success|failed`
  - matches the first 8 bytes against `eventDiscriminator(name)` (:5-7)
  - decodes the payload at fixed offsets (:292-548)
  - Decoded events: GameLost, GameSettled, GameWon, HouseDeposited, HouseWithdrawCancelled, HouseWithdrawCompleted, HouseWithdrawRequested, LpDeposited, LpPositionClosed, LpWithdrawCancelled, LpWithdrawCompleted, LpWithdrawRequested, ReferralAccrued, ReferralClaimed, ReferralTierChanged, ReferrerSet, StatsUpdated, V2Initialized, VaultUnitValueUpdated.
  - Consumers: `apps/web/src/server/indexer.ts:205`, `apps/web/src/app/api/verify/route.ts:77,196`, `apps/web/src/app/api/verify/[signature]/route.ts:58`; raw `logMessages` are collected for the indexer at `apps/web/src/app/api/cron/index-events/route.ts:194` and `apps/web/src/server/inline-ingest.ts:48`.
- `scripts/verify-sig.mjs:42,89-98` (+ the `parseGame*` helpers below it): `Program data:` plus the GameWon / GameLost / GameSettled discriminators and field offsets.
- `apps/realtime/src/alchemy-logs.ts:123-124`: `logsSubscribe {mentions:[programId]}` (program id only).
- `tests/sdk/anchor-errors.test.ts:12-27`, `tests/sdk/events-forgery.test.ts:27,37`: fixtures with `Program log: Instruction: RevealTile`, AnchorError lines, and the OLD program id.

**Error codes / error text**
- `packages/sdk/src/errors.ts:11-69` (`KABOOM_ERROR_NAMES`, index = code − 6000; the order must equal §3.1).
- `packages/sdk/src/errors.ts:85-99` (`extractKaboomError`): `/Error Code: ([A-Z][A-Za-z]+)/`, OR runtime `custom program error: 0x…`.
- `packages/sdk/src/errors.ts:118-131,157-177,190-192`: framework codes 3000-3012; regexes `AnchorError caused by account: X. Error Code: N. Error Number: n` / `AnchorError occurred. …`, with hex fallback; `isAccountNotInitializedError` ⇒ **3012 must stay 3012**.
- `apps/web/src/server/solana.ts:154-160` (3012 → `account_not_initialized` 409) and `apps/web/src/server/api-helpers.ts:41`.
- `apps/web/src/lib/program-errors.ts:12-70,86-90`: `"Custom":N`, `custom program error: 0x…`, or `Error Number: N`, mapped through the 6000-6040 table.
- `apps/web/src/hooks/use-vrf-game.ts:58-60,124,441`: string-matches `0x179b` (6043 BadSessionKey) and `0x1776` (6006 VaultInsufficientFunds).
- `scripts/test-lp-withdrawal-cooldown.ts:328`: `CooldownNotElapsed` | `0x1795` | `Custom":6037`.

**Discriminators, account layouts, offsets, sizes**
- `packages/sdk/src/discriminator.ts:8,14`: `sha256("global:"+name)`, `sha256("account:"+name)`.
- `packages/sdk/src/accounts.ts:4-9` (discriminators). Decoders: `:183` VaultV2State, `:226` LpPosition, `:239` Vault, `:283` GameSession, `:324` PlayerStats (Option via `optionPk` `:127-134`, always 33 bytes), `:358` ReferralAccount.
- `packages/sdk/src/vrf.ts:347-348` (VrfClaim/VrfGame discriminators), `:400` decodeVrfClaim, `:415` decodeVrfGame, `:440` raw `status` byte at offset 8; `:55-72` PDAs (`buffer`, `delegation`, `delegation-metadata` under DLP, `identity`); `:100-330` builders (disc + arg offsets + account order, e.g. start_game_vrf `mine_count@8 bet@9 session_key@17`).
- `packages/sdk/src/instructions.ts:46-693`: 31 commit-reveal/LP/admin `build*` builders (disc + Borsh args + account order).
- `packages/sdk/src/pdas.ts:18-50`: seeds.
- `apps/web/src/app/api/ref/referees/[wallet]/route.ts:16-17,39-40` and `scripts/referrals-by.ts:5,15-20`: getProgramAccounts `dataSize 203` + `memcmp offset 107 = PlayerStats.referrer` key.
- `apps/web/src/app/api/admin/release-stuck-obligations/route.ts:47,95`, `scripts/health-diagnose.ts:12,43`, `scripts/list-stuck.ts:12`: `dataSize 180` = GameSession.
- `scripts/diagnose-user.ts:13,75-76`: `dataSize 180` + `memcmp offset 8` = `GameSession.player`.
- `apps/web/src/app/api/status/route.ts:149-152`: `memcmp offset 0` = GameSession discriminator.
- `apps/web/src/app/api/cron/vrf-settle/route.ts:62-65`: `memcmp offset 0` = VrfGame discriminator, then decodeVrfGame.
- `apps/web/src/app/api/ref/confirm/route.ts:105-125`: matches the `set_referrer` ix discriminator in a parsed transaction and reads **account index [3] = player** (index [1] = referrer). The account order must stay identical.
- `scripts/repair-referrals.ts:56,102,255`: ReferralAccount discriminator memcmp + set_referrer ix discriminator.
- `scripts/repair-vault-mirror.ts:84-86,133-135`: LpPosition / ReferralAccount discriminator memcmp.

**Money movement (behaviour, not bytes)**
- `apps/web/src/server/verify-vrf.ts:42-110` reconstructs a `settle_vrf` from the transaction's **lamport deltas**:
  - `treasury_cut = floor(floor(bet*edge/1e4)*split/1e4)`
  - `vault_delta = −(payout + treasury_cut + referral_cut)`
  - referral 0/50/60/70 bps
  - payout = `floor(bet*calc_multiplier/1e4)`

  Any extra or missing lamport move in `settle_vrf` (e.g. funding rent from the vault, or moving the close rent through the vault) breaks this verifier. Closing claim/game rent to `player` does not touch the vault or treasury.

**Program-id hardcodes (swap list, not ABI)**
- `apps/web/.env.local`
- `scripts/{list-stuck,init-vault-mainnet,referrals-by,show-referral,rotate-to-squads-mainnet,health-diagnose,init-v2-mainnet,diagnose-user,repair-vault-mirror}.ts`
- `scripts/verify-deploy.sh`
- `tests/sdk/{anchor-errors,events-forgery}.test.ts`
- `Anchor.toml [programs.mainnet]`

The full list is kept in `~/Projects/kaboom-archive-2026-10-05/redeploy/program-id-touchpoints.txt` (per memory; not re-verified here).

---

## 9. Instruction index (42 = 41 `#[program]` + `process_undelegation`)

Arg offsets are absolute into instruction data (the discriminator is at 0..8). `@var` means after an `Option`, so the offset depends on earlier tags. Account order and W/S flags are from the IDL and are binding. The bracket notes say which accounts are created or closed and how; they come from the source.

| ix (snake) | log name `Instruction: X` | disc hex | args (Borsh, after 8-byte disc) | accounts in order (W=writable, S=signer) |
|---|---|---|---|---|
| `accept_ownership` | `AcceptOwnership` | `ac172b0deed55596` | - | `vault`(W), `new_owner`(S) |
| `admin_close_orphaned_game_v2` | `AdminCloseOrphanedGameV2` | `6e18ce9b48d63824` | - | `owner`(S), `player`(W), `game`(W)[manual zero (if ours)], `vault`(W), `v2_state`(W) |
| `admin_release_vrf_claim` | `AdminReleaseVrfClaim` | `b9c71f674e59c3cc` | - | `owner`(S), `player`(W), `claim`(W)[close->player], `vault`(W), `v2_state`(W) |
| `allowlist_add` | `AllowlistAdd` | `2a05819f37a567cb` | `address: pubkey`@8 (len 40) | `vault`(W), `owner`(S) |
| `allowlist_remove` | `AllowlistRemove` | `1e1453d2bc9bd3a3` | `address: pubkey`@8 (len 40) | `vault`(W), `owner`(S) |
| `cancel_proposed_owner` | `CancelProposedOwner` | `4b46c56903a4c4a6` | - | `vault`(W), `owner`(S) |
| `cancel_withdraw` | `CancelWithdraw` | `7035e23a9e1e25a8` | - | `vault`(W), `v2_state`(W), `position`(W), `user`(WS) |
| `cash_out` | `CashOut` | `016e393a9f9df3c0` | - | `vault`(W), `v2_state`(W), `game`(W), `player`(WS) |
| `cash_out_vrf` | `CashOutVrf` | `e5b00b5fc6255a6e` | - | `signer`(WS), `game`(W) |
| `claim_referral` | `ClaimReferral` | `dbf712943ff770c6` | - | `referral_account`(W), `referrer`(WS) |
| `close_game` | `CloseGame` | `edec9dc9fd14f843` | - | `game`(W)[close->player], `player`(WS) |
| `close_lp_position` | `CloseLpPosition` | `217639c3857e6912` | - | `position`(W)[close->user], `user`(WS) |
| `close_unsettled_game` | `CloseUnsettledGame` | `af122fa8bc5d1091` | - | `v2_state`(W), `game`(W)[close->player], `player`(WS) |
| `complete_withdraw` | `CompleteWithdraw` | `ac818d115ffdfb62` | - | `vault`(W), `v2_state`(W), `position`(W), `user`(WS) |
| `delegate_vrf` | `DelegateVrf` | `dd39aa29648e1e29` | - | `player`(WS), `buffer_game`(W), `delegation_record_game`(W), `delegation_metadata_game`(W), `game`(W), `v2_state`, `owner_program`[= program id; IDL shows old 9Xip2L, use NEW Ednka8zj..], `delegation_program`[=DELeGGvX..], `system_program`[=11111111..], + rem[0]? validator (key must == v2.vrf_validator) |
| `fund_vault` | `FundVault` | `1a21cff2776c8649` | `amount: u64`@8 (len 16) | `vault`(W), `funder`(WS), `system_program`[=11111111..] |
| `house_cancel_withdraw` | `HouseCancelWithdraw` | `a7afe00731ccb8a2` | - | `vault`(W), `v2_state`(W), `owner`(WS) |
| `house_complete_withdraw` | `HouseCompleteWithdraw` | `d1e765c7cda1698e` | - | `vault`(W), `v2_state`(W), `owner`(WS) |
| `house_deposit` | `HouseDeposit` | `1f32a79706db5571` | `amount: u64`@8 (len 16) | `vault`(W), `v2_state`(W), `owner`(WS), `system_program`[=11111111..] |
| `house_request_withdraw` | `HouseRequestWithdraw` | `bebd4c2ebd4c5a94` | `units: u128`@8 (len 24) | `vault`(W), `v2_state`(W), `owner`(WS) |
| `initialize_v2` | `InitializeV2` | `4399af27da102620` | - | `vault`, `v2_state`(W)[init], `owner`(WS), `system_program`[=11111111..] |
| `initialize_vault` | `InitializeVault` | `30bfa32c47813fa4` | `house_edge_bps: u16`@8, `max_bet_bps: u16`@10, `max_payout_bps: u16`@12 (len 14) | `vault`(W)[init], `house_authority`, `treasury`, `owner`(WS), `system_program`[=11111111..] |
| `lp_deposit` | `LpDeposit` | `1b4dd2450c2b9410` | `amount: u64`@8 (len 16) | `vault`(W), `v2_state`(W), `position`(W)[init_if_needed], `user`(WS), `system_program`[=11111111..] |
| `process_undelegation` | `ProcessUndelegation` | `c41c29ce302533a7` | `account_seeds: Vec<bytes>`@8 | `base_account`(W), `buffer`, `payer`(W), `system_program` |
| `propose_owner` | `ProposeOwner` | `5a398d6ec4f1ac27` | `new_owner: pubkey`@8 (len 40) | `vault`(W), `owner`(S) |
| `refund_expired` | `RefundExpired` | `7699a4f42880f2fa` | - | `vault`(W), `v2_state`(W), `game`(W), `player`(WS) |
| `refund_stalled_vrf` | `RefundStalledVrf` | `3cef840b96687b62` | - | `caller`(S), `player`(W), `claim`(W)[close->player], `game`(W)[manual zero (if ours)], `vault`(W), `v2_state`(W) |
| `repair_referral` | `RepairReferral` | `b4c188fcea8a80e5` | - | `vault`, `referrer`, `referral_account`(W), `owner`(S) |
| `request_withdraw` | `RequestWithdraw` | `895fbb60fa8a1fb6` | `units: u128`@8 (len 24) | `vault`(W), `v2_state`(W), `position`(W), `user`(WS) |
| `reveal_callback_vrf` | `RevealCallbackVrf` | `0cdfcd0f3a017c56` | `randomness: [u8; 32]`@8 (len 40) | `vrf_program_identity`(S), `game`(W) |
| `reveal_request_vrf` | `RevealRequestVrf` | `50575a0827cb1f40` | `tile_index: u8`@8, `client_seed: u8`@9 (len 10) | `session`(WS), `game`(W), `oracle_queue`(W)[=5hBR571x..], `program_identity`, `vrf_program`[=Vrf1RNUj..], `slot_hashes`[=SysvarS1..], `system_program`[=11111111..] |
| `reveal_tile` | `RevealTile` | `e16c2aa96fd40c67` | `tile_index: u8`@8, `is_mine: bool`@9 (len 10) | `vault`, `game`(W), `house_authority`(S) |
| `set_referrer` | `SetReferrer` | `73fb3700a6bd194a` | - | `player_stats`(W)[init_if_needed], `referrer`, `referral_account`(W)[init_if_needed], `player`(WS), `system_program`[=11111111..] |
| `settle_and_undelegate_vrf` | `SettleAndUndelegateVrf` | `d5471bb4585a189c` | - | `payer`(WS), `game`(W), `magic_program`[=Magic111..], `magic_context`(W)[=MagicCon..] |
| `settle_game` | `SettleGame` | `603618bdefc6561d` | `mine_layout: u16`@8, `salt: [u8; 32]`@10 (len 42) | `vault`(W), `v2_state`(W), `game`(W), `player_stats`(W), `house_authority`(S), `treasury`(W), + rem[0]? ReferralAccount (W) |
| `settle_vrf` | `SettleVrf` | `9963ce5475b44511` | - | `payer`(WS), `player`(W), `claim`(W)[close->player], `game`(W)[close->player], `vault`(W), `v2_state`(W), `treasury`(W), `player_stats`(W), `system_program`[=11111111..], + rem[0]? ReferralAccount (W) |
| `start_game` | `StartGame` | `f92ffcacb8a2f50e` | `mine_count: u8`@8, `bet: u64`@9, `commitment: [u8; 32]`@17 (len 49) | `vault`(W), `v2_state`(W), `game`(W)[init], `player_stats`(W)[init_if_needed], `player`(WS), `system_program`[=11111111..] |
| `start_game_vrf` | `StartGameVrf` | `94d851daf2182ec7` | `mine_count: u8`@8, `bet: u64`@9, `session_key: pubkey`@17 (len 49) | `player`(WS), `vault`(W), `v2_state`(W), `claim`(W)[init], `game`(W)[init], `player_stats`(W)[init_if_needed], `system_program`[=11111111..] |
| `unlock_operator_position` | `UnlockOperatorPosition` | `4eb3c9ab2955f6a2` | - | `vault`(W), `v2_state`(W), `owner`(S), `destination`(W) |
| `update_v2_config` | `UpdateV2Config` | `0d494f562f31e428` | `min_house_share_bps: Option<u16>`@8, `max_user_position_bps: Option<u16>`@var, `min_health_bps: Option<u16>`@var, `withdraw_cooldown_slots: Option<u64>`@var, `min_lp_deposit: Option<u64>`@var, `vrf_mode_enabled: Option<bool>`@var, `vrf_validator: Option<pubkey>`@var, `vrf_max_payout_bps: Option<u16>`@var | `vault`, `v2_state`(W), `owner`(S) |
| `update_vault` | `UpdateVault` | `43e5b9bce20bd23c` | `house_edge_bps: Option<u16>`@8, `max_bet_bps: Option<u16>`@var, `max_payout_bps: Option<u16>`@var, `treasury_split_bps: Option<u16>`@var, `paused: Option<bool>`@var, `new_house_authority: Option<pubkey>`@var, `new_treasury: Option<pubkey>`@var | `vault`(W), `owner`(S) |
| `withdraw_to_treasury` | `WithdrawToTreasury` | `f58495772bffaf3f` | `amount: u64`@8 (len 16) | `vault`(W), `treasury`(S), `destination`(W) |


---

## 10. Open questions

1. **Anchor IDL instructions.** The Anchor build was not `no-idl`, so it also answers the 7 IDL management instructions (`IdlCreateAccount`, `IdlResizeAccount`, `IdlCloseAccount`, `IdlCreateBuffer`, `IdlWrite`, `IdlSetAuthority`, `IdlSetBuffer`; prefix `40 f4 bc 78 a7 e9 69 0a`), and their strings are in `kaboom.so`. They are not among the 41 + 1. Without them `anchor idl init` cannot publish an on-chain IDL for the new ID. Options: drop them (the IDL prefix then returns 101) and publish the IDL via the Program Metadata program or off-chain only; or port them. Recommend dropping them; owner to confirm.
2. **Rent formula.** Pinocchio ignores `exemption_threshold`. It equals Anchor's f64 formula only while the threshold is 1.0 (true on mainnet today; fixed by SIMD-0194). Accept, or read the 17-byte sysvar and replicate the f64 math (costs soft-float CU and size)? Recommend accepting.
3. **Error text logs.** All off-chain parsers work from the numeric code (runtime hex / `"Custom":N`). Should the port print an Anchor-style `AnchorError occurred. Error Code: <Name>. Error Number: <n>. Error Message: <msg>.` line for explorer readability? It costs about 3-4 KB of strings for 55 + ~20 framework entries and about 100 CU only on failure. Recommend no (codes only) unless the owner wants explorer text. The 3012 account name in `solana.ts:157` is cosmetic.
4. **security.txt `auditors` text** says "Self-audited …" for the Anchor program. For a fresh unaudited port, keep it byte-identical (parity), or say "Pinocchio port, unaudited"? Per the audit-claims rule, the owner decides. `source_code` / `source_revision` still point to `main` of the repo where the pinocchio crate is uncommitted.
5. **Pre-funded PDA branches.** Anchor/0.15.5 handle a PDA that already holds lamports, via transfer/allocate/assign, for `init`, `init_if_needed`, the DLP delegate buffer, and the undelegate re-create. Vendored pinocchio helpers only `CreateAccount`. For our own `init` / `init_if_needed` the port MUST implement both branches (anyone can pre-fund a player's GameSession / PlayerStats PDA; Anchor tolerates it). For `buffer_game` the same griefing applies (pre-funding blocks `delegate_vrf` with the vendored helper): implement it ourselves. For undelegate the lamports are provably 0 inside the DLP instruction. Confirm this approach.
6. **ER compatibility.** The Pinocchio `.so` must also load in the MagicBlock ER validator, which clones the program for `reveal_request_vrf` / `reveal_callback_vrf` / `cash_out_vrf` / `settle_and_undelegate_vrf`. It uses the same cargo-build-sbf 3.1.14 sbpf target as the Anchor build. Not verifiable offline; check in the later test workflow.
7. **Allocator.** The vendored crate enables `pinocchio/alloc`. If no code path allocates, use `no_allocator!()` (smaller); otherwise use a bump allocator. To verify at build time.
8. **Same-tx re-init after a manual zero-close** (§5.5) fails in Anchor, and the port reproduces that. Flagged only in case the owner prefers a real close; that would change behaviour.
