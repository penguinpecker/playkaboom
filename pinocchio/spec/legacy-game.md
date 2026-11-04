# Port spec: legacy commit-reveal game instructions

Instructions covered: `start_game`, `reveal_tile`, `cash_out`, `settle_game`, `refund_expired`, `close_game`, `close_unsettled_game`.

Source of truth: `programs/kaboom/src/lib.rs` @ e82f2c5 (line numbers below are `lib.rs:` unless marked otherwise). None of these instructions touch `vrf_mode.rs`. The only things they share with it are the `PlayerStats` layout (VRF also creates it, `vrf_mode.rs:311-316`, and stores the same canonical bump) and the `Vault`/`VaultV2State` accounts.
Anchor semantics come from the anchor-syn/anchor-lang 0.31.1 sources in `~/.cargo/registry`. I read them directly; the file paths are given where they matter.
All discriminators below were computed with python3 hashlib, and every one matches `target/idl/kaboom.json`.

New program ID: `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`. Its fixed PDAs, from `solana find-program-derived-address`:

| PDA | seeds | address | canonical bump |
|---|---|---|---|
| vault | `["kaboom_vault"]` | `7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7` | 254 |
| v2_state | `["kaboom_v2_state"]` | `Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue` | 255 |

Per-player PDAs: game = `["kaboom_game", player]` (lib.rs:132), stats = `["kaboom_stats", player]` (lib.rs:136), referral = `["kaboom_referral", referrer]` (lib.rs:137).

---

## 0. Shared definitions used by these 7 instructions

### 0.1 Constants (lib.rs:50-89)
`GRID_SIZE: u8 = 16`, `MIN_MINES: u8 = 1`, `MAX_MINES: u8 = 15`, `BPS: u64 = 10_000`, `GAME_EXPIRY_SLOTS: u64 = 300`, `CLOSE_UNSETTLED_EXPIRY_SLOTS: u64 = 38`, `MIN_BET_LAMPORTS: u64 = 1_000_000`, `REFERRAL_BRONZE_BPS: u16 = 50`, `REFERRAL_SILVER_BPS: u16 = 60`, `REFERRAL_GOLD_BPS: u16 = 70`, `SILVER_VOLUME_LAMPORTS: u64 = 10_000_000_000`, `GOLD_VOLUME_LAMPORTS: u64 = 100_000_000_000`.

### 0.2 Account layouts (absolute byte offsets, including the 8-byte discriminator)

All values are little-endian Borsh. Rent minimums use the live mainnet Rent sysvar (read 2026-11-04: `lamports_per_byte_year = 5080`, `exemption_threshold = 1.0`, so `(128 + space) * 5080`; `getMinimumBalanceForRentExemption(428)` = 2,824,480 confirms it) and are listed only as a sanity check. The port **must** call the Rent sysvar (`try_minimum_balance`) and never hard-code them.

**Vault**: disc `d308e82b02987577` = `[211,8,232,43,2,152,117,119]`, space 428 (lib.rs:1971-2004), rent 2,824,480.
`owner@8 [32]`, `house_authority@40 [32]`, `treasury@72 [32]`, `bump@104 u8`, `house_edge_bps@105 u16`, `max_bet_bps@107 u16`, `max_payout_bps@109 u16`, `treasury_split_bps@111 u16`, `total_games@113 u64`, `total_wagered@121 u64`, `total_payouts@129 u64`, `paused@137 bool`, `version@138 u8`, `allowlist_count@139 u8`, `withdraw_allowlist@140 [32;8]`, `pending_owner@396 [32]`. End 428.

**VaultV2State**: disc `eefcdafd5966445e` = `[238,252,218,253,89,102,68,94]`, space 191 (lib.rs:2009-2083), rent 1,620,520.
`bump@8 u8`, `total_outstanding_max_payout@9 u64`, `total_units@17 u128`, `house_units@33 u128`, `house_pending_units@49 u128`, `house_pending_unlock_slot@65 u64`, `seed_units@73 u128`, `total_pending_units@89 u128`, `min_house_share_bps@105 u16`, `max_user_position_bps@107 u16`, `min_health_bps@109 u16`, `withdraw_cooldown_slots@111 u64`, `min_lp_deposit@119 u64`, `vrf_mode_enabled@127 bool`, `vrf_validator@128 [32]`, `vrf_max_payout_bps@160 u16`, `_reserved@162 [29]`. End 191.

**GameSession**: disc `967414c5cd79dcf0` = `[150,116,20,197,205,121,220,240]`, space 180 (lib.rs:2109-2142), rent 1,564,640.
`player@8 [32]`, `bump@40 u8`, `status@41 u8 enum`, `bet@42 u64`, `mine_count@50 u8`, `commitment@51 [32]`, `revealed_mask@83 u16`, `revealed_safe_mask@85 u16`, `safe_reveals@87 u8`, `multiplier_bps@88 u64`, `start_slot@96 u64`, `created_at@104 i64`, `settled@112 bool`, `mine_layout@113 u16`, `salt@115 [32]`, `version@147 u8`, `max_payout@148 u64`, `_reserved@156 [24]`. End 180.
`GameStatus` (lib.rs:2101-2107) values: `Playing=0`, `Won=1`, `Lost=2`, `Expired=3`.

**PlayerStats**: disc `a992f2b06676e7ac` = `[169,146,242,176,102,118,231,172]`, space 203 (lib.rs:2191-2216), rent 1,681,480.
`player@8 [32]`, `bump@40 u8`, `version@41 u8`, `games_played@42 u64`, `games_won@50 u64`, `total_wagered@58 u64`, `total_payouts@66 u64`, `biggest_win@74 u64`, `biggest_multiplier_bps@82 u64`, `current_streak@90 u32`, `best_streak@94 u32`, `last_played@98 i64`, `referrer` Option tag `@106 u8`, referrer key `@107 [32]` (only present when the tag is 1), `_reserved [64]`.
The Borsh layout is **variable-length**. With `referrer = Some`, `_reserved` sits at 139..203. With `None`, Anchor serializes `_reserved` at 107..171 and leaves 171..203 untouched.
Fixed offsets are still safe for the port, for three reasons:
- `_reserved` is never written with non-zero bytes.
- The referrer moves only `None -> Some`, in `set_referrer` (lib.rs:243-244).
- Fresh accounts are all zeros.

So the port can read the tag at 106 and the key at 107. It must reject a tag other than 0 or 1 (Anchor would raise 3003).

**ReferralAccount**: disc `eda2504ec4e95b02` = `[237,162,80,78,196,233,91,2]`, space 103 (lib.rs:2219-2237), rent 1,173,480.
`referrer@8 [32]`, `bump@40 u8`, `version@41 u8`, `tier@42 u8`, `accrued_lamports@43 u64`, `total_earned@51 u64`, `referred_count@59 u32`, `referred_volume@63 u64`, `_reserved@71 [32]`. End 103.

Borsh strictness Anchor applies on account load (anchor-lang 0.31.1 uses borsh 0.10.4, which is strict here): a `bool` byte other than 0 or 1, a `GameStatus` greater than 3, or an Option tag other than 0 or 1 fails with **3003 AccountDidNotDeserialize**. The affected fields are Vault.paused, V2.vrf_mode_enabled, Game.settled and PlayerStats.referrer.
Only this program writes these accounts, so these cases cannot be reached. Validating `status <= 3` and the bools is still cheap, and it is recommended.

### 0.3 Events (Anchor `emit!` = `sol_log_data(&[disc ++ borsh(fields)])` as one slice, which shows up as "Program data: <base64>")

| Event | disc hex | disc dec | payload (field order) | payload bytes |
|---|---|---|---|---|
| GameStarted (3005-3013) | de f7 4e ff 3d b8 9c 29 | [222,247,78,255,61,184,156,41] | player[32], game[32], bet u64, mine_count u8, commitment[32], slot u64 | 113 |
| TileRevealed (3015-3024) | e8 b0 81 36 96 9e 8f b7 | [232,176,129,54,150,158,143,183] | player, game, tile_index u8, is_mine bool, multiplier_bps u64, safe_reveals u8, slot u64 | 83 |
| GameWon (3026-3035) | a0 c6 ea c1 e3 80 66 c7 | [160,198,234,193,227,128,102,199] | player, game, bet u64, payout u64, multiplier_bps u64, safe_reveals u8, slot u64 | 97 |
| GameLost (3037-3045) | c8 a1 e2 e3 0b 81 fa 9f | [200,161,226,227,11,129,250,159] | player, game, bet u64, tile_index u8, safe_reveals u8, slot u64 | 82 |
| GameSettled (3047-3057) | 3f 6d 80 55 e5 3f a7 b0 | [63,109,128,85,229,63,167,176] | player, game, mine_count u8, mine_layout u16, salt[32], commitment[32], verified bool, slot u64 | 140 |
| GameRefunded (3059-3066) | 38 6f 18 d1 f3 a5 55 ff | [56,111,24,209,243,165,85,255] | player, game, bet u64, refund u64, slot u64 | 88 |
| StatsUpdated (3068-3078) | 32 90 3e 26 8c 94 75 3e | [50,144,62,38,140,148,117,62] | player, games_played u64, games_won u64, total_wagered u64, total_payouts u64, biggest_win u64, current_streak u32, slot u64 | 84 |
| ReferralAccrued (3087-3094) | 4a 5d 2e 8e 80 41 19 fe | [74,93,46,142,128,65,25,254] | referrer, player, amount u64, tier u8, slot u64 | 81 |
| ReferralTierChanged (3096-3101) | 15 7e c4 25 dc 67 d7 f1 | [21,126,196,37,220,103,215,241] | referrer, new_tier u8, slot u64 | 41 |
| TreasuryAccrued (2995-3003) | 56 d8 45 a7 a2 ae b5 47 | [86,216,69,167,162,174,181,71] | vault, treasury, from_game, bet u64, amount u64, slot u64 | 120 |
| VaultUnitValueUpdated (2959-2966) | 7f d9 88 1b 26 19 f7 38 | [127,217,136,27,38,25,247,56] | vault, vault_assets u64, total_units u128, health_bps u16, slot u64 | 66 |

### 0.4 Error codes used here (6000 + index in `KaboomError`, lib.rs:2710-2824; matches the IDL)
6000 InvalidMineCount, 6001 InvalidTileIndex, 6002 TileAlreadyRevealed, 6003 GameNotPlaying, 6004 BetTooLow, 6005 BetExceedsMax, 6006 VaultInsufficientFunds, 6007 Unauthorized, 6008 MathOverflow, 6011 InvalidCommitment, 6012 VaultPaused, 6013 GameExpired, 6014 GameNotExpired, 6015 CommitmentMismatch, 6016 RevealMismatch, 6017 GameAlreadySettled, 6018 GameNotFinished, 6019 NoTilesRevealed, 6022 ReferralMismatch, 6034 HealthFloorBreached.

Anchor framework codes that can fire on these instructions (from anchor-lang 0.31.1 `error.rs`): 101 InstructionFallbackNotFound, 102 InstructionDidNotDeserialize, 2000 ConstraintMut, 2004 ConstraintOwner, 2005 ConstraintRentExempt, 2006 ConstraintSeeds, 2011 ConstraintClose, 2019 ConstraintSpace, 3001 AccountDiscriminatorNotFound, 3002 AccountDiscriminatorMismatch, 3003 AccountDidNotDeserialize, 3005 AccountNotEnoughKeys, 3007 AccountOwnedByWrongProgram, 3008 InvalidProgramId, 3009 InvalidProgramExecutable, 3010 AccountNotSigner, 3012 AccountNotInitialized, 4101 TryingToInitPayerAsProgramAccount.

### 0.5 Anchor 0.31.1 framework behaviour the port must reproduce

1. **Dispatch** (`anchor-syn/src/codegen/program/handlers.rs:116-160`):
   - Match the first 8 bytes against the discriminator.
   - Log `msg!("Instruction: <PascalName>")` **first**, before any argument or account parsing. So the log line appears even when the call later fails.
   - Deserialize args with `BorshDeserialize::deserialize(&mut &data[8..])`. **Trailing bytes are allowed.** Too few bytes, or a bool byte other than 0 or 1, fails with **102**.
   - Run `try_accounts`, then the handler, then `exit`.
2. **`try_accounts` runs in two phases** (`try_accounts.rs:15-80, 127-163`):
   - **Phase A, deserialize, in declaration order:**
     - Fewer accounts than fields fails with 3005.
     - `Account<T>::try_from` (`anchor-lang/src/accounts/account.rs:303-313`) checks, in order: owner is the system program and lamports == 0 → 3012; then owner != program → 3007; then data length < 8 → 3001; then wrong discriminator → 3002; then a Borsh failure → 3003.
     - `Signer`: `!is_signer` → 3010.
     - `Program<System>`: key != `111…1` → 3008; `!executable` → 3009.
     - `init` and `init_if_needed` fields are only taken as raw `AccountInfo` here.
   - **Phase B, constraints:** all init fields first (in declaration order), then every non-init field in declaration order. Within a field the order is fixed by `constraints.rs:68-133`: `init → seeds → mut → signer → has_one → raw(constraint=) → owner → rent_exempt → close(target check) → address`.
   - `seeds + bump = <field>` uses `create_program_address(seeds ++ [stored_bump])`. An error, or a key mismatch, fails with **2006** (`constraints.rs:1192-1209`).
   - `seeds + bump` with no target uses `find_program_address`, so the canonical bump is required. A mismatch fails with 2006, and `__bumps.<field>` is set to the canonical bump.
   - `mut`: `!is_writable` → 2000.
   - `constraint = expr @ E`: if the expression is false, fail with E.
   - `close = t`: `field.key == t.key` → 2011.
   - Exact error-code ordering is "match where cheap". Failing at all is mandatory.
3. **`init` / `init_if_needed` of a program-owned PDA** (`constraints.rs:1044-1131` and `generate_create_account` at `:1621-1669`). The init parser adds `mut` and `rent_exempt = enforce` automatically (`parser/accounts/constraints.rs:608-623`). Steps:
   - a. `(pda, bump) = find_program_address(seeds, program_id)`, and record the bump. If `key != pda`, fail with 2006.
   - b. `rent = Rent::get()`.
   - c. If the instruction is not `if_needed`, **or** the account's current owner is the system program, create the account:
     - If `lamports == 0`: CPI `system::create_account(from = payer, to = field, lamports = rent.minimum_balance(space), space, owner = program_id)`, signed with `seeds ++ [bump]`.
     - Else (the PDA was pre-funded, which is a griefing vector, so the port MUST handle it):
       - If `payer.key == field.key`, fail with 4101.
       - `need = minimum_balance(space).max(1).saturating_sub(lamports)`. If `need > 0`, CPI `system::transfer(payer → field, need)`.
       - CPI `system::allocate(field, space)`, PDA-signed.
       - CPI `system::assign(field, program_id)`, PDA-signed.
     - Then view the data as a zeroed struct (`try_from_unchecked`: owner check, no discriminator check).
   - d. Otherwise (`if_needed` and the account already exists, not system-owned), use the full `Account::try_from` (3007 / 3001 / 3002 / 3003).
   - e. If `if_needed`, also check: `data_len != space` → 2019; `owner != program_id` → 2004; `lamports < minimum_balance(space)` → 2005.
   - f. Then `mut` (2000), then `rent.is_exempt(lamports, data_len)` → 2005.
   - g. With plain `init` on an account that is already program-owned (an unclosed previous game), the `allocate` CPI is what fails, with system-program custom error 0 (AccountAlreadyInUse). The port gets the identical failure by issuing the same CPIs.
4. **Exit** (`exit.rs` and `account.rs:252-265`), in declaration order:
   - `mut` Account fields are re-serialized as `disc ++ borsh(struct)`, written from offset 0 over the existing buffer. If nothing changed, the bytes are identical, so the port can skip writing unchanged accounts.
   - `close = t` fields are closed with `common::close` (`anchor-lang/src/common.rs:6-15`), in this order:
     1. `t.lamports = t.lamports.checked_add(acc.lamports).unwrap()`
     2. `acc.lamports = 0`
     3. `assign(acc, system_program)`
     4. `realloc(acc, 0)`
   - Signer and UncheckedAccount fields have no exit.
5. **Errors in the handler**:
   - `checked_*` failures map to 6008, not a panic.
   - The release profile has `overflow-checks = true` (root `Cargo.toml:6`), so the few plain `-` and `<<` operations noted below would panic on overflow. All of them are unreachable given the earlier requires.

### 0.6 Helpers (exact semantics)

- `mul_div_floor(a,num,den)` (lib.rs:1836-1843): `u128(a)*u128(num)` checked → 6008; `/den` checked (den==0 → 6008); `u64::try_from` → 6008.
- `calc_multiplier(safe_reveals:u8, mine_count:u8, edge:u16) -> u64` (lib.rs:1790-1834):
  1. If `safe_reveals == 0`, return `BPS` (1792-1793).
  2. Require `mine_count as u64 + safe_reveals as u64 <= 16`, else 6000 (1794-1797).
  3. `num = den = 1u128`. For `i in 0..safe_reveals`:
     - `tiles_remaining = 16 - i` (checked → 6008)
     - `safe_remaining = 16 - mines - i` (checked → 6008)
     - require `safe_remaining > 0`, else 6000
     - `num = num.checked_mul(tiles_remaining)` and `den = den.checked_mul(safe_remaining)` (→ 6008)

     (Lines 1799-1819.)
  4. `raw = num*BPS / den` (checked; 1821-1825).
  5. `edge_factor = (BPS - edge as u64)`. This is a **plain u64 subtraction** (1826). It would panic if `edge > 10000`, but `update_vault` caps the edge at 1000.
  6. `final = raw*edge_factor / BPS` (checked), then `u64::try_from` → 6008 (1827-1833).

  Optional optimization: every intermediate value fits in u64. The largest `num*BPS` is 16!/1!·1e4 ≈ 2.09e17, and the largest `raw*edge_factor` is about 1.29e12. So u64 checked math gives bit-identical results, and keeping the u128 version is also fine.
- `worst_case_payout(bet, mine_count, edge)` (1846-1850): `worst_safe = 16u8.saturating_sub(mine_count)`, then `mul_div_floor(bet, calc_multiplier(worst_safe, mine_count, edge), BPS)`.
- `vault_assets(vault)` (1854-1857): `vault.lamports.saturating_sub(Rent.minimum_balance(428))`.
- `units_to_assets(units:u128, assets:u64, total_units:u128)` (1873-1883): returns 0 if `total_units==0 || units==0`. Otherwise `units*assets` (checked u128) `/ total_units`, then `u64::try_from`. Every failure → 6008.
- `calc_health_bps(v2, assets) -> u16` (1893-1909):
  1. If `assets == 0`, return 0.
  2. `pending = units_to_assets(v2.total_pending_units, assets, v2.total_units)`.
  3. `obligations = v2.total_outstanding_max_payout.checked_add(pending)` → 6008.
  4. `free = assets.saturating_sub(obligations)`.
  5. `h = free*BPS/assets` (u128 checked).
  6. Return `min(h, BPS) as u16`.
- `enforce_min_health(v2, assets)` (1911-1918): if `v2.min_health_bps == 0`, return Ok. Otherwise require `calc_health_bps(v2, assets) >= v2.min_health_bps`, else **6034**.

---

## 1. `start_game`

- Log: `Program log: Instruction: StartGame`
- Discriminator: `f92ffcacb8a2f50e` = `[249,47,252,172,184,162,245,14]` (IDL match)
- Args (Borsh, 41 bytes minimum, trailing bytes ignored): `mine_count: u8` @0 (1), `bet: u64` @1 (8), `commitment: [u8;32]` @9 (32).

### Accounts (lib.rs:2304-2334)

| # | name | signer | writable | constraints (in Anchor check order) |
|---|---|---|---|---|
| 0 | vault | no | yes | Phase A: `Account<Vault>` (3012/3007/3001/3002/3003). Phase B: seeds `["kaboom_vault"]` with `bump = vault.bump` via create_program_address → 2006; `mut` → 2000 |
| 1 | v2_state | no | yes | Phase A: `Account<VaultV2State>`. Phase B: seeds `["kaboom_v2_state"]`, `bump = v2_state.bump` → 2006; `mut` → 2000 |
| 2 | game | no | yes | `init`, payer = player, space = 180, seeds `["kaboom_game", player.key]`, canonical bump found → `bumps.game`. Full init sequence §0.5.3 (not if_needed), then mut (2000), then rent_exempt (2005) |
| 3 | player_stats | no | yes | `init_if_needed`, payer = player, space = 203, seeds `["kaboom_stats", player.key]`, canonical bump → `bumps.player_stats`. Full §0.5.3 including the if_needed checks (2019 / 2004 / 2005) and the 3002 discriminator check when it already exists |
| 4 | player | **yes** | yes | Phase A: Signer (3010). Phase B: mut (2000) |
| 5 | system_program | no | no | `Program<System>`: key == `11111111111111111111111111111111` (3008), executable (3009) |

Anchor run order:
1. Phase A over accounts 0, 1, 4, 5. Accounts 2 and 3 are only taken raw.
2. Init game: find_pda, then the create CPI(s).
3. Init_if_needed player_stats: find_pda, then create or load.
4. Non-init constraints: vault seeds and mut, v2 seeds and mut, player mut.

Consequence: a read-only `player` fails inside the create CPI (a runtime privilege error), not with 2000.

### Handler (lib.rs:265-372)

1. `require!(!vault.paused)` → 6012 VaultPaused (272).
2. `require!(1 <= mine_count <= 15)` → 6000 InvalidMineCount (273-276).
3. `require!(bet >= 1_000_000)` → 6004 BetTooLow (277).
4. `require!(commitment != [0;32])` → 6011 InvalidCommitment (278).
5. `vault_lamports = vault.lamports` (280; read **before** the bet transfer); `rent = Rent.minimum_balance(428)` (281); `available = vault_lamports.saturating_sub(rent)` (282).
6. `pre_health = calc_health_bps(v2_state, available)` (288; may raise 6008).
7. `effective_max_bet_bps = (vault.max_bet_bps as u64).checked_mul(pre_health as u64)` (→ 6008) `/ BPS` (289-292). `effective_max_payout_bps` uses the same formula with `vault.max_payout_bps` (293-296).
8. `max_bet = mul_div_floor(available, effective_max_bet_bps, BPS)` (297). `require!(bet <= max_bet)` → 6005 BetExceedsMax (298).
9. `worst_payout_u64 = worst_case_payout(bet, mine_count, vault.house_edge_bps)` (300; may raise 6000 or 6008).
10. `max_payout = mul_div_floor(available, effective_max_payout_bps, BPS)` (302). `require!(worst_payout_u64 as u128 <= max_payout as u128)` → 6006 VaultInsufficientFunds (303-306).
11. **CPI** `system_program::transfer(from = player, to = vault, lamports = bet)` (309-318). A plain transfer with no signer seeds. Insufficient player funds fails with the system program's error.
12. `clock = Clock::get()` (320).
13. If `player_stats.player == Pubkey::default()` (324), set `player_stats.player = player.key`, `player_stats.bump = bumps.player_stats` (canonical) and `player_stats.version = 1` (325-327). The other fields stay as they are (zero when the account is new).
14. Game field writes (330-347):
    - `player = player.key`, `bump = bumps.game` (canonical), `status = Playing (0)`, `bet = bet`, `mine_count = mine_count`, `commitment = commitment`
    - `revealed_mask = 0`, `revealed_safe_mask = 0`, `safe_reveals = 0`, `multiplier_bps = 10_000`
    - `start_slot = clock.slot`, `created_at = clock.unix_timestamp`, `settled = false`, `mine_layout = 0`, `salt = [0;32]`, `version = 1`, `max_payout = worst_payout_u64`
    - `_reserved` stays zero.
15. `vault.total_games = total_games.saturating_add(1)` and `vault.total_wagered = total_wagered.saturating_add(bet)` (349-351).
16. `v2.total_outstanding_max_payout = total_outstanding_max_payout.checked_add(worst_payout_u64)` → 6008 (354-358).
17. `new_assets = available.saturating_add(bet)` (360). Use this literal formula, computed from the pre-transfer `available`. Then `enforce_min_health(v2 /*post-increment*/, new_assets)` → 6034 (361).
18. **emit** GameStarted{ player: game.player, game: game.key, bet, mine_count, commitment, slot: clock.slot } (363-370).
19. Exit, in order: vault (serialize; total_games and total_wagered changed), v2_state (outstanding changed), game (full disc and struct), player_stats (disc and struct; written only if new or changed).

Lamport movements, in order:
1. player → game: rent for 180 bytes (init CPI).
2. player → stats: rent for 203 bytes, only when stats is created (init CPI).
3. player → vault: `bet` (handler CPI).

### Subtle points
- A second `start_game` while the previous game PDA is not closed fails inside the init CPI (`allocate`, system error 0). This is the "one active game per player" guard. Do not add a custom check that changes the failure mode silently; keeping it a failure is enough.
- Pre-funded game or stats PDA (lamports > 0 while still system-owned): use the transfer, allocate and assign path. Without it, anyone could permanently stop a player from starting a game by sending 1 lamport to the player's game PDA.
- `init_if_needed` reinit guard: an existing stats account is loaded with the full discriminator check, and its fields are only touched when `player == default`. In practice that never happens for an existing account, because every creation path sets `player`: lib.rs:238-242, lib.rs:324-328, vrf_mode.rs:312-316.
- CU: two `find_program_address` calls (game and stats) are unavoidable, because the canonical bump must be derived. For vault and v2, a cheaper equivalent check is acceptable instead of `create_program_address`: `key == const PDA && stored bump == const bump` (254 / 255). This is equal or stricter, because those accounts can only exist at the canonical address (`initialize_vault` and `initialize_v2` use `init`).

---

## 2. `reveal_tile`

- Log: `Program log: Instruction: RevealTile`
- Discriminator: `e16c2aa96fd40c67` = `[225,108,42,169,111,212,12,103]` (IDL match)
- Args (2 bytes minimum): `tile_index: u8` @0, `is_mine: bool` @1 (a byte other than 0 or 1 → 102).

### Accounts (lib.rs:2336-2350)

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | **no** | `Account<Vault>`; seeds `["kaboom_vault"]`, `bump = vault.bump` → 2006. No mut check |
| 1 | game | no | yes | `Account<GameSession>`; seeds `["kaboom_game", game.player]` (player read from the account data), `bump = game.bump` via create_program_address → 2006; mut → 2000 |
| 2 | house_authority | **yes** | no | Signer (3010); `constraint house_authority.key == vault.house_authority` → **6007 Unauthorized** |

All account checks (including 6007) run **before** the handler's `tile_index` check.

### Handler (lib.rs:375-442)
1. `require!(tile_index < 16)` → 6001 InvalidTileIndex (376).
2. `require!(game.status == Playing)` → 6003 GameNotPlaying (379-382).
3. `clock = Clock::get()`. `require!(clock.slot <= game.start_slot.saturating_add(300))` → 6013 GameExpired (384-388).
4. `tile_bit: u16 = 1 << tile_index` (390). `require!(game.revealed_mask & tile_bit == 0)` → 6002 TileAlreadyRevealed (391-394).
5. `game.revealed_mask |= tile_bit` (396).
6. If `is_mine` (398-416):
   - `game.status = Lost (2)`.
   - **emit** TileRevealed{ player: game.player, game: game.key, tile_index, is_mine: true, multiplier_bps: game.multiplier_bps (unchanged), safe_reveals: game.safe_reveals (unchanged), slot }.
   - Then **emit** GameLost{ player, game, bet: game.bet, tile_index, safe_reveals: game.safe_reveals, slot }.
7. Else (417-439):
   - `game.revealed_safe_mask |= tile_bit`
   - `game.safe_reveals = safe_reveals.saturating_add(1)` (u8)
   - `game.multiplier_bps = calc_multiplier(game.safe_reveals /*new*/, game.mine_count, vault.house_edge_bps)` (may raise 6000 or 6008)
   - `total_safe = 16 - game.mine_count` (a plain u8 subtraction; mine_count ≤ 15)
   - if `game.safe_reveals >= total_safe`, set `game.status = Won (1)`
   - **emit** TileRevealed{ player, game, tile_index, is_mine: false, multiplier_bps: <new>, safe_reveals: <new>, slot }.
8. Exit: game serialized (vault is not mut, so it is not written).

No lamport movement. No CPI.

### Subtle points
- When the full board is cleared, the status is set to `Won` **without paying anything**. `cash_out` then fails (it requires `Playing`), and `settle_game` books the payout in stats but moves no lamports. This is a parity quirk that must be **preserved**. The web server works around it by refusing to send the final safe reveal (`apps/web/src/app/api/reveal/route.ts:122-138`).
- `vault` is read-only here. Do not require writable.

---

## 3. `cash_out`

- Log: `Program log: Instruction: CashOut`
- Discriminator: `016e393a9f9df3c0` = `[1,110,57,58,159,157,243,192]` (IDL match)
- Args: none (trailing bytes ignored).

### Accounts (lib.rs:2352-2370)

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>`; seeds + stored bump → 2006; mut → 2000 |
| 1 | v2_state | no | yes | `Account<VaultV2State>`; seeds + stored bump → 2006; mut → 2000. **Validated but not modified** |
| 2 | game | no | yes | `Account<GameSession>`; seeds `["kaboom_game", game.player]` + `game.bump` → 2006; mut → 2000; `constraint game.player == player.key` → 6007 |
| 3 | player | **yes** | yes | Signer (3010); mut (2000) |

### Handler (lib.rs:445-499)
1. `require!(game.status == Playing)` → 6003 (447-450).
2. `require!(game.safe_reveals > 0)` → 6019 NoTilesRevealed (451).
3. `payout = (bet as u128).checked_mul(multiplier_bps as u128)` → 6008, then `.checked_div(10_000)` → 6008, then `u64::try_from` → 6008 (453-458).
4. `rent = Rent.minimum_balance(428)`. `available = vault.lamports.saturating_sub(rent)` (460-462). `require!(payout <= available)` → 6006 (463).
5. **Direct lamports** (466-474): `vault.lamports = vault.lamports.checked_sub(payout)` → 6008, then `player.lamports = player.lamports.checked_add(payout)` → 6008.
6. `game.status = Won (1)` (476).
7. `vault.total_payouts = total_payouts.saturating_add(payout)` (478-479).
8. **Do NOT** touch `v2.total_outstanding_max_payout` (481-487; it is released exactly once, later).
9. **emit** GameWon{ player: game.player, game: game.key, bet: game.bet, payout, multiplier_bps: game.multiplier_bps, safe_reveals: game.safe_reveals, slot: Clock.slot } (489-497).
10. Exit: vault (total_payouts), v2_state (unchanged, so it can be skipped), game (status).

### Subtle points
- **No expiry check**. A `Playing` game can be cashed out after the 300-slot expiry, so the player can choose between `refund_expired` (gets the bet) and `cash_out` (gets bet × multiplier). Preserve this.
- Lamports are moved directly: the vault is program-owned, and the player is only credited. No CPI.

---

## 4. `settle_game`

- Log: `Program log: Instruction: SettleGame`
- Discriminator: `603618bdefc6561d` = `[96,54,24,189,239,198,86,29]` (IDL match)
- Args (34 bytes minimum): `mine_layout: u16` @0 (2), `salt: [u8;32]` @2 (32).

### Accounts (lib.rs:2372-2406)

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | vault | no | yes | `Account<Vault>`; seeds + `vault.bump` → 2006; mut → 2000 |
| 1 | v2_state | no | yes | `Account<VaultV2State>`; seeds + `v2_state.bump` → 2006; mut → 2000 |
| 2 | game | no | yes | `Account<GameSession>`; seeds `["kaboom_game", game.player]` + `game.bump` → 2006; mut → 2000 |
| 3 | player_stats | no | yes | `Account<PlayerStats>` (must already exist: 3012 / 3007 / 3002); seeds `["kaboom_stats", game.player]` with **no bump target**, so `find_program_address` is used and the key must be the **canonical** PDA (2006); `bumps.player_stats = canonical`; mut → 2000 |
| 4 | house_authority | **yes** | no | Signer (3010); `constraint key == vault.house_authority` → 6007 |
| 5 | treasury | no | yes | `UncheckedAccount` (no owner or data checks); mut → 2000; `constraint key == vault.treasury` → 6007 |
| 6.. | remaining[0] (optional) | no | yes (not checked by Anchor; the runtime enforces it when written) | ReferralAccount of `player_stats.referrer`, validated inside the handler (step 12) |

### Handler (lib.rs:510-797)
1. `require!(status == Won || status == Lost)` → **6003 GameNotPlaying** (515-519; the error name is misleading, keep it).
2. `require!(!game.settled)` → 6017 GameAlreadySettled (520).
3. `computed = sha256(mine_layout.to_le_bytes() [2] ++ [game.mine_count] [1] ++ salt [32])`, which is 35 bytes. The port can use the `sol_sha256` syscall with three slices. `require!(computed == game.commitment)` → 6015 CommitmentMismatch (523-532).
4. `require!(mine_layout.count_ones() as u8 == game.mine_count)` → 6015 (534-538).
5. `require!(game.revealed_safe_mask & mine_layout == 0)` → 6016 RevealMismatch (539-542).
6. `revealed_mine_mask = revealed_mask & !revealed_safe_mask` (u16). `require!(revealed_mine_mask & mine_layout == revealed_mine_mask)` → 6016 (543-547).
7. If `status == Lost`, `require!(revealed_mine_mask != 0)` → 6016 (548-550).
8. `game.mine_layout = mine_layout`, `game.salt = salt`, `game.settled = true`. `max_payout_release = game.max_payout` (552-555).
9. `v2.total_outstanding_max_payout = total_outstanding_max_payout.saturating_sub(max_payout_release)` (559-564). This happens **before** the referral and treasury math.
10. Stats (567-575):
    - If `stats.player == default`, set `stats.player = game.player`, `stats.bump = bumps.player_stats` and `stats.version = 1`. This branch cannot be reached in practice, but keep it.
    - `games_played = games_played.saturating_add(1)`
    - `total_wagered = total_wagered.saturating_add(game.bet)`
    - `last_played = Clock.unix_timestamp`
11. `payout` (577-587):
    - If Won: `(bet as u128).checked_mul(multiplier_bps)` → 6008, `.checked_div(10_000)` → 6008, `try_into u64` → 6008.
    - Else: 0.

    Then (589-605):
    - If Won:
      - `games_won += 1` (saturating)
      - `total_payouts = total_payouts.saturating_add(payout)`
      - `net_win = payout.saturating_sub(bet)`; if `net_win > biggest_win`, set `biggest_win = net_win`
      - if `game.multiplier_bps > biggest_multiplier_bps`, set `biggest_multiplier_bps = game.multiplier_bps`
      - `current_streak = current_streak.saturating_add(1)` (u32); if `current_streak > best_streak`, set `best_streak = current_streak`
    - Else: `current_streak = 0`.

    **No lamports are paid here.** A cash-out win was already paid in `cash_out`, and a full-board auto-win is never paid (see §2).
12. **Referral** (614-680). Runs only if `stats.referrer == Some(referrer_key)` **and** `remaining_accounts` is non-empty (only `[0]` is used; extra accounts are ignored).
    - a. `expected = find_program_address(["kaboom_referral", referrer_key], program_id).0`. `require!(remaining[0].key == expected)` → 6022 ReferralMismatch (616-623). This happens **before** any load.
    - b. Load with `Account::<ReferralAccount>::try_from(remaining[0])`: 3012 if system-owned with 0 lamports, 3007 for the wrong owner, 3001 / 3002 / 3003 (624). `require!(ra.referrer == referrer_key)` → 6022 (625).
    - c. `cut_bps: u16` is 50 for `tier == 0`, 60 for `tier == 1`, and 70 for anything else (627-631). `cut = mul_div_floor(game.bet, cut_bps, 10_000)` (632).
    - d. `vault_available = vault.lamports /*current*/ .saturating_sub(Rent.minimum_balance(428))`. `actual_cut = min(cut, vault_available)` (634-637).
    - e. If `actual_cut > 0`, move lamports directly: `vault.lamports.checked_sub(actual_cut)` → 6008, then `referral.lamports.checked_add(actual_cut)` → 6008 (639-648).
    - f. `ra.accrued_lamports += actual_cut`, `ra.total_earned += actual_cut` and `ra.referred_volume += game.bet` (all saturating) (650-652).
    - g. `new_tier` is 2 if `referred_volume >= 100e9`, else 1 if `>= 10e9`, else 0 (654-660). If `new_tier != ra.tier`, set `ra.tier = new_tier` and **emit** ReferralTierChanged{ referrer: ra.referrer, new_tier, slot } (661-668).
    - h. Persist the ReferralAccount now: `ra.exit` serializes disc and struct into remaining[0] (670). Fields written: tier, accrued_lamports, total_earned, referred_volume.
    - i. **emit** ReferralAccrued{ referrer: referrer_key, player: game.player, amount: actual_cut, tier: ra.tier, slot } (672-678). This is emitted **even when `actual_cut == 0`**.
    - If `stats.referrer == None`, remaining[0] is ignored even when it is present. If `referrer == Some` and there are no remaining accounts, the step is silently skipped.
13. **Treasury split** (708-758). `split = vault.treasury_split_bps` and `edge = vault.house_edge_bps`. Runs only if `split > 0`:
    - `edge_share = mul_div_floor(game.bet, edge, 10_000)`
    - `treasury_cut = mul_div_floor(edge_share, split, 10_000)`
    - `assets_now = vault.lamports /*after the referral debit*/ .saturating_sub(Rent.minimum_balance(428))`
    - `pending_value = units_to_assets(v2.total_pending_units, assets_now, v2.total_units)` (may raise 6008)
    - `liquidity = assets_now.saturating_sub(v2.total_outstanding_max_payout /*post-release, step 9*/).saturating_sub(pending_value)`
    - `actual = min(treasury_cut, liquidity)`
    - If `actual > 0`:
      - `vault.lamports.checked_sub(actual)` → 6008, then `treasury.lamports.checked_add(actual)` → 6008 (direct lamport moves)
      - **emit** TreasuryAccrued{ vault: vault.key, treasury: treasury.key, from_game: game.key, bet: game.bet, amount: actual, slot }
14. **emit** GameSettled{ player: game.player, game: game.key, mine_count: game.mine_count, mine_layout (arg), salt (arg), commitment: game.commitment, verified: true, slot } (760-769).
15. `assets_now = vault_assets(vault)` (after all debits). `h = calc_health_bps(v2 /*post-release*/, assets_now)`. **emit** VaultUnitValueUpdated{ vault: vault.key, vault_assets: assets_now, total_units: v2.total_units, health_bps: h, slot } (772-784).
16. **emit** StatsUpdated{ player: stats.player, games_played, games_won, total_wagered, total_payouts, biggest_win, current_streak, slot } (786-795).
17. Exit, in order: vault (data unchanged, so it can be skipped), v2_state (outstanding), game (mine_layout, salt, settled), player_stats (step 10/11 fields). The treasury has no exit.

Event order: `[ReferralTierChanged]`, `[ReferralAccrued]`, `[TreasuryAccrued]`, `GameSettled`, `VaultUnitValueUpdated`, `StatsUpdated`.

Lamport moves, in order: vault → referral PDA (`actual_cut`), then vault → treasury (`actual`). Both are direct, with no CPI.

### Subtle points
- All `Clock::get()` calls in one instruction return the same slot, so reading the clock once is fine.
- Hot path (200k CU): one `find_program_address` for stats, and one for the referral when there is a referrer. They cannot be removed without a semantic change.
  - Optional stats optimization: `create_program_address(["kaboom_stats", game.player, [stats.bump]])` and require that it equals the key. This is equivalent **only** because every creation path stores the canonical bump (lib.rs:240, lib.rs:326, vrf_mode.rs:314). If it is used, do the `stats.player == default` fallback (step 10) with a real `find_program_address`.
  - The referral `find_program_address` happens before the account is loaded. Swapping it for the stored-bump form would change which error fires first. Keep `find` unless CU measurement forces otherwise.
  - Vault and v2 can use the constant-PDA check from §1.
- Each account's lamports are debited before the next is credited. The vault always keeps at least the rent minimum, because both cuts are capped below `lamports - rent`.
- If the treasury is a fresh 0-lamport system account and the credit is below its rent minimum, the runtime rejects the transaction. That is the same outcome as on the Anchor build.
- remaining[0] cannot alias a named account, because the PDA check pins it to the referral seed. Pinocchio duplicate-account handling still applies if a client passes the same key twice. Never hold a data borrow on one view while writing through another view of the same account.
- remaining[0] writability is not checked explicitly. Writing to a read-only account fails at the runtime level on both builds. Adding an explicit `is_writable` check is optional.

---

## 5. `refund_expired`

- Log: `Program log: Instruction: RefundExpired`
- Discriminator: `7699a4f42880f2fa` = `[118,153,164,244,40,128,242,250]` (IDL match)
- Args: none.

### Accounts (lib.rs:2446-2464)
These are identical to `cash_out`: vault (mut, seeds + stored bump), v2_state (mut, seeds + stored bump), game (mut, seeds `["kaboom_game", game.player]` + `game.bump`, `constraint game.player == player.key` → 6007), player (Signer, mut).

### Handler (lib.rs:862-906)
1. `require!(status == Playing)` → 6003 (864-867).
2. `clock = Clock::get()`. `require!(clock.slot > start_slot.saturating_add(300))` → 6014 GameNotExpired (869-873). This is the exact complement of reveal_tile's `<=`.
3. `available = vault.lamports.saturating_sub(Rent.minimum_balance(428))`. `refund = min(game.bet, available)` (875-878). No require: a partial refund is allowed, and so is a zero refund.
4. Direct lamports: `vault.checked_sub(refund)` → 6008, then `player.checked_add(refund)` → 6008 (880-888). Do it even when `refund == 0`; it is a no-op.
5. `game.status = Expired (3)`. `max_payout_release = game.max_payout` (890-891). `settled` stays false.
6. `v2.total_outstanding_max_payout = total_outstanding_max_payout.saturating_sub(max_payout_release)` (893-896).
7. **emit** GameRefunded{ player: game.player, game: game.key, bet: game.bet, refund, slot: clock.slot } (898-904).
8. Exit: vault (data unchanged), v2_state, game.

Notes:
- `vault.total_payouts` is **not** incremented by a refund.
- The game account stays open (status Expired). The player closes it later with `close_game`.

---

## 6. `close_game`

- Log: `Program log: Instruction: CloseGame`
- Discriminator: `edec9dc9fd14f843` = `[237,236,157,201,253,20,248,67]` (IDL match)
- Args: none.

### Accounts (lib.rs:2466-2479)

| # | name | signer | writable | constraints (order) |
|---|---|---|---|---|
| 0 | game | no | yes | `Account<GameSession>`; seeds `["kaboom_game", game.player]` + `game.bump` → 2006; mut → 2000; `constraint game.player == player.key` → 6007; `close = player`: `game.key == player.key` → 2011 |
| 1 | player | **yes** | yes | Signer (3010); mut (2000) |

### Handler (lib.rs:908-917)
1. `require!(status == Expired || (settled && (status == Won || status == Lost)))` → 6018 GameNotFinished (910-915).
2. Exit, which is the close (`common.rs:6-15`):
   1. `player.lamports = player.lamports + game.lamports` (Anchor unwraps, which cannot overflow)
   2. `game.lamports = 0`
   3. assign game to `11111111111111111111111111111111`
   4. resize game data to 0

No events, no msg!.

---

## 7. `close_unsettled_game`

- Log: `Program log: Instruction: CloseUnsettledGame`
- Discriminator: `af122fa8bc5d1091` = `[175,18,47,168,188,93,16,145]` (IDL match)
- Args: none.

### Accounts (lib.rs:2481-2497)

| # | name | signer | writable | constraints |
|---|---|---|---|---|
| 0 | v2_state | no | yes | `Account<VaultV2State>`; seeds `["kaboom_v2_state"]` + `v2_state.bump` → 2006; mut → 2000 |
| 1 | game | no | yes | same as close_game: seeds + `game.bump` → 2006, mut → 2000, `game.player == player.key` → 6007, close target check → 2011 |
| 2 | player | **yes** | yes | Signer (3010); mut (2000) |

### Handler (lib.rs:929-946)
1. `require!(status == Won || status == Lost)` → 6018 GameNotFinished (931-934).
2. `require!(!game.settled)` → 6017 GameAlreadySettled (935).
3. `clock = Clock::get()`. `require!(clock.slot > start_slot.saturating_add(38))` → 6014 GameNotExpired (936-940).
4. `v2.total_outstanding_max_payout = total_outstanding_max_payout.saturating_sub(game.max_payout)` (941-944).
5. Exit, in order: v2_state serialized first, **then** the game is closed to the player (same close sequence as §6).

No events, no msg!, and no vault lamport movement. The only lamports returned are the game account's rent.

---

## 8. Cross-instruction invariants to keep

- `total_outstanding_max_payout` increases once (`start_game`) and decreases exactly once per game, in exactly one of `settle_game`, `refund_expired` or `close_unsettled_game`. `cash_out` and `close_game` never touch it.
- The status machine:
  - `Playing → Lost` (reveal_tile, mine)
  - `Playing → Won` (reveal_tile full board, or cash_out)
  - `Playing → Expired` (refund_expired)
  - `Won/Lost + !settled → settled` (settle_game), or closed by close_unsettled_game after 38 slots
  - `(Won/Lost + settled) or Expired → closed` (close_game)
- The new program ID means every account is fresh. Legacy-data cases (for example old games with `max_payout == 0`, lib.rs:2127-2129) are unreachable, but the saturating math already handles them.

## 9. Open questions

1. A full-board win flips the game to `Won` and never pays (§2). The port keeps this for parity. Confirm that keeping it is intended rather than fixing it in the rewrite.
2. Error-order fidelity: Anchor checks owner and discriminator for every account before any seeds, mut or raw constraint, and runs init before the other constraints. Should the port copy that two-phase order exactly, or only guarantee that the same invalid input fails (possibly with a different code)? Example: a read-only `player` fails with a runtime privilege error, not 2000.
3. CU optimizations that are equivalent only under program invariants. Decide whether they are allowed:
   - (a) constant vault and v2 PDA plus bump compare instead of `create_program_address`
   - (b) stored-bump `create_program_address` for `player_stats` in settle_game instead of `find_program_address`

   Both rely on every creation path storing the canonical bump, which is verified in lib.rs and vrf_mode.rs.
4. Anchor's failure logs ("AnchorError caused by account: … Error Code: … Error Number: …") are not part of the ABI. Assumed: not reproduced, only the numeric code is matched. Confirm that no indexer or client greps them.

## F-fix deviations (2026-11-04, binding spec `FIXES.md`)

- F2: new permissionless `expire_game` (disc `d0155783f22bfc90`, no args, accounts `vault W, v2_state W, game W, player W` not signer). Checks as `refund_expired` minus the signer. Playing (6003) and `slot > start_slot + 300` (6014); refund branch if `safe_reveals == 0 || multiplier_bps < 10_000` (full bet only, 6006 otherwise; Expired; reservation released; `GameRefunded`), else cash branch (`bet*mult/BPS`, 6006 if short; Won; `total_payouts +=`; `GameWon`; release left to `settle_game`). The four existing instructions are unchanged.
- F5: `settle_game` keeps the referral account optional (house-gated; see FIXES.md section 6).
