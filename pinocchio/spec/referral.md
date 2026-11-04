# Referral instructions: Pinocchio port spec

Scope: `set_referrer`, `claim_referral`, `repair_referral`.
Source of truth: `programs/kaboom/src/lib.rs` @ e82f2c5 (line numbers below refer to it), Anchor 0.31.1
codegen (`anchor-syn-0.31.1/src/codegen/accounts/{try_accounts,constraints}.rs`,
`anchor-lang-0.31.1/src/accounts/account.rs`). Cross-checked against `target/idl/kaboom.json`:
all discriminators below match the IDL byte-for-byte.

Program ID (new): `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`. Every PDA below derives from it.
(The IDL still says `9Xip2L...`; only the address changes.)

---

## 0. Shared definitions

### Seeds (lib.rs:129, 136, 137)
| const | bytes |
|---|---|
| `VAULT_SEED` | `b"kaboom_vault"` |
| `STATS_SEED` | `b"kaboom_stats"` |
| `REFERRAL_SEED` | `b"kaboom_referral"` |

### Errors used (custom = 6000 + index in `KaboomError`, lib.rs:2711-)
| name | code | msg |
|---|---|---|
| `Unauthorized` | 6007 | "Unauthorized." |
| `MathOverflow` | 6008 | "Arithmetic overflow." |
| `SelfReferral` | 6020 | "Cannot refer yourself." |
| `ReferrerAlreadySet` | 6021 | "Referrer already set." |
| `NothingToClaim` | 6023 | "Nothing to claim." |

Anchor framework codes that these instructions can raise:
2000 ConstraintMut, 2004 ConstraintOwner, 2005 ConstraintRentExempt, 2006 ConstraintSeeds,
2019 ConstraintSpace, 3001 AccountDiscriminatorNotFound, 3002 AccountDiscriminatorMismatch,
3003 AccountDidNotDeserialize, 3004 AccountDidNotSerialize, 3005 AccountNotEnoughKeys,
3007 AccountOwnedByWrongProgram, 3008 InvalidProgramId, 3009 InvalidProgramExecutable,
3010 AccountNotSigner, 3012 AccountNotInitialized, 4101 TryingToInitPayerAsProgramAccount.

### Account layouts (Borsh, Anchor `#[account]`)

**PlayerStats** (lib.rs:2190-2216), disc `sha256("account:PlayerStats")[..8]` =
`a992f2b06676e7ac` = `[169,146,242,176,102,118,231,172]`, `SPACE = 203` (lib.rs:2209-2215).
| off | len | field | type |
|---|---|---|---|
| 0 | 8 | discriminator | |
| 8 | 32 | player | Pubkey |
| 40 | 1 | bump | u8 |
| 41 | 1 | version | u8 |
| 42 | 8 | games_played | u64 LE |
| 50 | 8 | games_won | u64 |
| 58 | 8 | total_wagered | u64 |
| 66 | 8 | total_payouts | u64 |
| 74 | 8 | biggest_win | u64 |
| 82 | 8 | biggest_multiplier_bps | u64 |
| 90 | 4 | current_streak | u32 |
| 94 | 4 | best_streak | u32 |
| 98 | 8 | last_played | i64 |
| 106 | 1 | referrer tag | Option tag (0 None / 1 Some) |
| 107 | 32 | referrer value | Pubkey (only meaningful when tag==1) |
| 139 | 64 | _reserved | [u8;64] |

Borsh `Option` subtlety: when the tag is 0, Anchor serializes `_reserved` right after the tag
(107..171) and leaves 171..203 alone. The fixed-offset layout above produces the same bytes
because (a) accounts start zeroed, (b) `_reserved` is never written by any instruction (grep:
no writes), and (c) `referrer` only ever goes None -> Some (lib.rs:244 is the only writer).
**Port invariant:** never write non-zero bytes to 107..203 except setting tag=1 + pubkey at
107..139 in set_referrer. When reading, tag 0 = None, 1 = Some, anything else = 3003
(unreachable, but cheap).

**ReferralAccount** (lib.rs:2218-2237), disc `sha256("account:ReferralAccount")[..8]` =
`eda2504ec4e95b02` = `[237,162,80,78,196,233,91,2]`, `SPACE = 103` (lib.rs:2232-2236).
| off | len | field | type |
|---|---|---|---|
| 0 | 8 | discriminator | |
| 8 | 32 | referrer | Pubkey |
| 40 | 1 | bump | u8 |
| 41 | 1 | version | u8 |
| 42 | 1 | tier | u8 (0 bronze/1 silver/2 gold) |
| 43 | 8 | accrued_lamports | u64 |
| 51 | 8 | total_earned | u64 |
| 59 | 4 | referred_count | u32 |
| 63 | 8 | referred_volume | u64 |
| 71 | 32 | _reserved | [u8;32] |

**Vault** (lib.rs:1971-2005), disc `d308e82b02987577` = `[211,8,232,43,2,152,117,119]`,
`SPACE = 428`. Only fields used here: `owner` @ 8..40, `bump` @ 104. (Full map: owner 8,
house_authority 40, treasury 72, bump 104, house_edge_bps 105, max_bet_bps 107, max_payout_bps
109, treasury_split_bps 111, total_games 113, total_wagered 121, total_payouts 129, paused 137
(bool), version 138, allowlist_count 139, withdraw_allowlist 140..396, pending_owner 396..428.)

Rent minimums on live mainnet (Rent sysvar 2026-11-04: `lamports_per_byte_year = 5080`, threshold 1.0, so
`(128+len)*5080`): 203 B -> 1,681,480; 103 B -> 1,173,480. (The old default-rent figures 2,303,760 / 1,607,760 =
`(128+len)*6960` are stale.)
Always read Rent via the sysvar (`Rent::get` / pinocchio `Rent::get()` + `try_minimum_balance`),
never hardcode.

### Events (Anchor `emit!` = `sol_log_data(&[disc ++ borsh])` -> "Program data: <base64>")
| event | disc hex | disc array | payload (after disc) | total |
|---|---|---|---|---|
| `ReferrerSet` (lib.rs:3080-3085) | `41bb1dcd74e5459a` | `[65,187,29,205,116,229,69,154]` | player Pubkey(32), referrer Pubkey(32), slot u64(8) | 80 B |
| `ReferralClaimed` (lib.rs:3103-3108) | `c36d4dc486e24e6c` | `[195,109,77,196,134,226,78,108]` | referrer Pubkey(32), amount u64(8), slot u64(8) | 56 B |
| `ReferralRepaired` (lib.rs:3110-3114) | `9a450a635a8607c1` | `[154,69,10,99,90,134,7,193]` | referrer Pubkey(32), slot u64(8) | 48 B |

`slot` = `Clock::get()?.slot` read at emit time (sysvar syscall; no Clock account passed).

### Anchor dispatch order (handlers.rs:116-163), applies to all three
1. `msg!("Instruction: <PascalName>")` -> log line `Program log: Instruction: <PascalName>`.
   Emitted BEFORE any account check, so it appears even on failure.
2. Args deserialize (no args here; trailing ix bytes after the 8-byte disc are ignored because
   Anchor uses `deserialize`, not `try_from_slice`).
3. `try_accounts`: (a) walk fields in declaration order: non-init fields get their type check
   (`Account::try_from`, `Signer`, `Program`); init fields just take the AccountInfo.
   Fewer accounts than fields -> 3005. (b) run constraints of all **init** fields in order.
   (c) run constraints of all **non-init** fields in order. Per field, constraint order is
   Init, Seeds, Mut, Signer, HasOne, Raw(constraint=), Owner, RentExempt, ... (linearize,
   constraints.rs:71-131).
4. Handler body.
5. `exit`: for every field marked `mut` (init counts as mut) of type `Account<T>`, if still
   owned by the program and not closed, re-serialize the WHOLE struct (disc + Borsh) into the
   data. This is where an init'd account's discriminator first gets written. Non-mut accounts
   are never written.
6. Extra accounts beyond the declared list = `remaining_accounts`; all three handlers ignore
   them. Port: accept and ignore.
On error Anchor logs `AnchorError ... Error Code: X. Error Number: N. Error Message: M.`;
matching the numeric code is what matters, the log text is nice-to-have.

Global (not per-instruction): entry rejects `program_id != ID` with 4100.

---

## 1. `set_referrer`

- Snake: `set_referrer`; log: `Program log: Instruction: SetReferrer`
- Discriminator `sha256("global:set_referrer")[..8]` = `73fb3700a6bd194a` =
  `[115, 251, 55, 0, 166, 189, 25, 74]` (matches IDL)
- Args: none. Ix data = 8 bytes (extra bytes ignored).

### Accounts (lib.rs:2275-2300)
| # | name | signer | writable | optional | constraints |
|---|---|---|---|---|---|
| 0 | `player_stats` | no | yes | no | `init_if_needed`, `payer = player`, `space = PlayerStats::SPACE` (203), `seeds = [STATS_SEED, player.key()]`, `bump` (canonical, found via find_program_address; written to `bumps.player_stats`). Type `Account<PlayerStats>`. |
| 1 | `referrer` | no | no | no | `UncheckedAccount`: NO checks at all (any pubkey, any owner, may even be non-existent). |
| 2 | `referral_account` | no | yes | no | `init_if_needed`, `payer = player`, `space = ReferralAccount::SPACE` (103), `seeds = [REFERRAL_SEED, referrer.key()]`, `bump` (canonical -> `bumps.referral_account`). Type `Account<ReferralAccount>`. |
| 3 | `player` | yes | yes | no | `Signer` (3010 if not signer, checked in deser phase), `mut` (2000, checked in non-init phase, i.e. after the inits). |
| 4 | `system_program` | no | no | no | `Program<System>`: key == `11111111111111111111111111111111` else 3008; `executable` else 3009 (deser phase). |

### Exact check sequence (Anchor 0.31.1 try_accounts)
Deser phase (field order):
1. acct0 taken raw (init field). 2. acct1 raw. 3. acct2 taken raw (init). 4. `player`:
   `is_signer` else 3010. 5. `system_program`: key check 3008, executable 3009.

Init phase, field `player_stats` (constraints.rs:470-560, 1068-1127, 1621-1673):
6. `rent = Rent::get()`.
7. `(pda, bump) = find_program_address([b"kaboom_stats", player.key], program_id)`;
   `bumps.player_stats = bump`; `if player_stats.key != pda -> 2006 ConstraintSeeds`.
8. Capture owner. If `owner == SystemProgram` (if_needed path; also true for a never-touched
   address):
   - 8a. If `player_stats.lamports == 0`: CPI `system_program::create_account(from = player,
     to = player_stats, lamports = rent.minimum_balance(203), space = 203, owner = program_id)`
     signed with seeds `[b"kaboom_stats", player.key, &[bump]]`.
   - 8b. Else (pre-funded PDA): `if player.key == player_stats.key -> 4101`;
     `required = rent.minimum_balance(203).max(1).saturating_sub(current_lamports)`;
     if `required > 0` CPI `system_program::transfer(player -> player_stats, required)`
     (no PDA signer needed); CPI `allocate(player_stats, 203)` signed by PDA seeds; CPI
     `assign(player_stats, program_id)` signed by PDA seeds.
   - 8c. Load WITHOUT discriminator check (`try_from_unchecked`): if owner==System &&
     lamports==0 -> 3012; owner != program_id -> 3007; Borsh-deserialize data[8..] (all zeros
     => default struct; error -> 3003).
   Else (owner != System): `Account::try_from`: owner != program_id -> 3007; data.len < 8 ->
   3001; disc != PlayerStats disc -> 3002; Borsh deserialize -> 3003 on failure (e.g. tag>1).
9. (if_needed asserts, run in both branches) `if data_len != 203 -> 2019 ConstraintSpace`;
   `if owner != program_id -> 2004 ConstraintOwner` (owner is re-read; after the CPI it is the
   program); `if lamports < rent.minimum_balance(203) -> 2005 ConstraintRentExempt`.
10. `mut`: `!is_writable -> 2000`.
11. Implicit rent_exempt Enforce: `!rent.is_exempt(lamports, data_len) -> 2005`.

Init phase, field `referral_account`: identical steps 6-11 with seeds
`[b"kaboom_referral", referrer.key]`, space 103, bump -> `bumps.referral_account`,
disc ReferralAccount.

Non-init phase:
12. `referrer`: none. `player`: `mut` -> `!is_writable -> 2000`. `system_program`: none.

Port note: the order only changes WHICH error is returned; failure itself is what matters.
A shared `init_if_needed(acct, payer, seeds, bump, space, disc)` helper covers both fields and
is reused by start_game / start_game_vrf (same PlayerStats init).

### Handler (lib.rs:222-262)
1. L229: `referrer_key = referrer.key` (from the AccountInfo, NOT from referral_account data;
   see the FIX comment L223-228).
2. L230-233: `require!(referrer_key != player.key, SelfReferral /*6020*/)`. Note this runs
   AFTER both inits; the whole tx reverts so the rent spent is refunded.
3. L238-242: if `player_stats.player == Pubkey::default()` (fresh account):
   `player_stats.player = player.key`; `player_stats.bump = bumps.player_stats` (canonical);
   `player_stats.version = 1`. (Other fields stay 0.)
4. L243: `require!(player_stats.referrer.is_none(), ReferrerAlreadySet /*6021*/)`.
5. L244: `player_stats.referrer = Some(referrer_key)` -> tag byte 106 = 1, bytes 107..139 =
   referrer_key.
6. L247-253: if `referral_account.referrer == Pubkey::default()` (fresh, or legacy-bugged):
   `referrer = referrer_key`; `bump = bumps.referral_account`; `tier = 0`; `version = 1`.
   (accrued_lamports / total_earned / referred_count / referred_volume NOT reset.)
7. L254: `referral_account.referred_count = referred_count.saturating_add(1)` (u32, saturating).
8. L256-260: emit `ReferrerSet { player: player.key, referrer: referrer_key, slot: Clock.slot }`.
9. Exit: write player_stats (disc + all fields) and referral_account (disc + all fields).
   Port: write the PlayerStats disc and ReferralAccount disc into bytes 0..8 (always, or at
   least on the fresh path; writing it always is byte-identical).

Lamport movements: only the system CPIs in the init path (player pays rent for any account
created). No direct lamport arithmetic.

### Subtleties
- Pre-funded PDA griefing: anyone can send lamports to an un-created `kaboom_stats` /
  `kaboom_referral` PDA. A bare `create_account` would then fail forever ("already in use").
  Port MUST implement the 8b transfer + allocate + assign path, exactly like Anchor.
- `referrer` is unchecked: it can be any key (even a PDA, program, or the player_stats address).
  Only self-referral is rejected. Keep it that way.
- No reinit guard beyond `stats.referrer.is_none()`: an existing PlayerStats (from start_game)
  is reused; only the `player == default` branch writes player/bump/version.
- Existing referral_account: Anchor validates its address with the CANONICAL bump
  (find_program_address), not the stored bump. Port should do the same (or prove the stored
  bump equals the canonical one) so a 2006 still fires for a wrong address.
- Two `find_program_address` calls; not a hot path, but use the non-panicking `try_` variant.
- The handler mutates the loaded copy; Anchor writes back only at exit. A port that writes
  directly into account data must still fail atomically (it does, tx reverts on any error).

---

## 2. `claim_referral`

- Snake: `claim_referral`; log: `Program log: Instruction: ClaimReferral`
- Discriminator `sha256("global:claim_referral")[..8]` = `dbf712943ff770c6` =
  `[219, 247, 18, 148, 63, 247, 112, 198]` (matches IDL)
- Args: none.

### Accounts (lib.rs:2408-2420)
| # | name | signer | writable | optional | constraints |
|---|---|---|---|---|---|
| 0 | `referral_account` | no | yes | no | `Account<ReferralAccount>` (owner==program 3007 / sys+0 lamports 3012 / disc 3001,3002 / deser 3003); `seeds = [REFERRAL_SEED, referrer.key()]`, `bump = referral_account.bump` (stored, byte 40) via `create_program_address` (error -> 2006, mismatch -> 2006); `mut` (2000); `constraint = referral_account.referrer == referrer.key() @ Unauthorized` (6007). |
| 1 | `referrer` | yes | yes | no | `Signer` (3010), `mut` (2000). |

Check order: deser: acct0 Account::try_from; acct1 is_signer. Then non-init constraints in
field order: referral_account Seeds (2006) -> Mut (2000) -> Raw (6007); referrer Mut (2000).

### Handler (lib.rs:800-828)
1. L802: `amount: u64 = referral_account.accrued_lamports`.
2. L803: `require!(amount > 0, NothingToClaim /*6023*/)`.
3. L806: `rent: u64 = Rent::get()?.minimum_balance(103)`.
4. L807: `withdrawable: u64 = referral_account.lamports.saturating_sub(rent)`.
5. L808: `payout: u64 = min(amount, withdrawable)`. **May be 0** (balance at or below rent):
   the instruction then still succeeds, moves 0, emits amount 0. Preserve; do NOT add an error.
6. L810-813: direct lamport debit: `referral_account.lamports =
   referral_account.lamports.checked_sub(payout)` else MathOverflow 6008.
7. L814-818: direct lamport credit: `referrer.lamports = referrer.lamports.checked_add(payout)`
   else MathOverflow 6008. (No CPI; program owns referral_account so it may debit it.)
8. L820: `accrued_lamports = accrued_lamports.saturating_sub(payout)`. `total_earned`,
   `tier`, counters untouched.
9. L822-826: emit `ReferralClaimed { referrer: referral_account.referrer (data field; equals
   signer key by constraint), amount: payout, slot: Clock.slot }`.
10. Exit: re-serialize referral_account (only `accrued_lamports` changed).

### Subtleties
- Balance stays >= rent by construction (payout <= lamports - rent), so the runtime
  rent-state check passes. Donated lamports above `rent + accrued` are not claimable.
- `referrer` and `referral_account` cannot alias (a PDA cannot sign). No CPI, so no
  reentrancy. Order "debit then credit then write data" is irrelevant to the result but keep it.
- Pinocchio: lamport writes via `set_lamports`/borrow_mut_lamports; do them before or after
  the data write, both are fine, but do not hold a data borrow across the lamport borrow
  checks if the API forbids it.

---

## 3. `repair_referral`

- Snake: `repair_referral`; log: `Program log: Instruction: RepairReferral`
- Discriminator `sha256("global:repair_referral")[..8]` = `b4c188fcea8a80e5` =
  `[180, 193, 136, 252, 234, 138, 128, 229]` (matches IDL)
- Args: none.

### Accounts (lib.rs:2422-2444)
| # | name | signer | writable | optional | constraints |
|---|---|---|---|---|---|
| 0 | `vault` | no | no | no | `Account<Vault>` (3012/3007/3001/3002/3003; full Borsh deser so data_len < 428 -> 3003, `paused` byte > 1 -> 3003); `seeds = [VAULT_SEED]`, `bump = vault.bump` (stored, byte 104) via create_program_address (2006); `constraint = vault.owner == owner.key() @ Unauthorized` (6007). NOT mut: never written. |
| 1 | `referrer` | no | no | no | `UncheckedAccount`, no checks (bound only via referral_account seeds). |
| 2 | `referral_account` | no | yes | no | `Account<ReferralAccount>` (3012/3007/3001/3002/3003); `seeds = [REFERRAL_SEED, referrer.key()]`, `bump = referral_account.bump` (stored, byte 40) via create_program_address (2006); `mut` (2000). |
| 3 | `owner` | yes | no | no | `Signer` (3010). |

Check order: deser: vault try_from, referrer none, referral_account try_from, owner
is_signer. Then: vault Seeds (2006) -> Raw (6007); referral_account Seeds (2006) -> Mut (2000).

### Handler (lib.rs:839-860)
1. L841: `referrer_key = referrer.key`.
2. L843-845: if `referral_account.referrer == referrer_key` -> return Ok (no event; exit still
   re-serializes referral_account with unchanged bytes, so a port can simply return).
3. L847-850: `require!(referral_account.referrer == Pubkey::default(), Unauthorized /*6007*/)`.
4. L852: `referral_account.referrer = referrer_key`.
5. L854-857: emit `ReferralRepaired { referrer: referrer_key, slot: Clock.slot }`.
6. Exit: re-serialize referral_account.

No lamport movement, no CPI.

### Subtleties
- On the new program ID no legacy (referrer==default) accounts can exist, because the fixed
  set_referrer (L229, L248-249) always writes the field. The instruction is kept for full
  parity; in practice it only ever takes the early-return path.
- Seeds-with-stored-bump: use `create_program_address` with the stored bump (non-panicking
  variant), compare to the passed key, 2006 on error or mismatch.

---

## Cross-instruction notes
- `settle_game` (lib.rs:607-680) and `settle_vrf` (vrf_mode.rs:660-700) credit
  ReferralAccount via `remaining_accounts[0]` with direct lamport moves from the vault and
  bump `accrued_lamports`/`total_earned`/`referred_volume`/`tier`; that is what
  `claim_referral` pays out. Their spec lives with those instructions; the layout above is
  shared.
- PlayerStats is also init_if_needed in `start_game` (lib.rs:2320-2327) and vrf_mode.rs:1022-1027, 1119-1124;
  reuse the same init helper and the same layout invariant (no writes to 107..203 except here).
