# referral.rs implementation checklist

File: `pinocchio/kaboom-p/src/ix/referral.rs`

## Dispatch (all three)

| spec step | line |
|---|---|
| `Program log: Instruction: SetReferrer / ClaimReferral / RepairReferral` before any check | `src/lib.rs` `process_instruction` (`helpers::log(log_line)`), names in `src/ix/mod.rs:53-55` |
| Discriminators `73fb3700a6bd194a`, `dbf712943ff770c6`, `b4c188fcea8a80e5` | `src/ix/mod.rs:53-55` |
| No args, trailing bytes ignored | 18, 76, 118 (`_args` unused) |
| Remaining accounts ignored | 19, 77, 119 (`..` in the slice pattern) |
| Fewer accounts than declared -> 3005 | 19-21, 77-79, 119-121 |

## 1. set_referrer

| spec step | line |
|---|---|
| 1-3 player_stats, referrer, referral_account taken raw | 19 |
| 4 player signer -> 3010 | 23 |
| 5 system_program key 3008, executable 3009 | 24 |
| referrer key read from the AccountInfo (lib.rs:229) | 27 |
| 6 Rent sysvar, once | 30 |
| 7-11 player_stats init_if_needed: find 2006, create or pre-funded transfer+allocate+assign (4101), else typed load 3007/3001/3002/3003, 2019, 2004, 2005, 2000, 2005; canonical bump | 31 |
| 7-11 referral_account init_if_needed, same sequence | 32-33 |
| 12 player mut -> 2000 | 36 |
| H2 SelfReferral 6020 | 39 |
| H3 fresh stats: player, bump = canonical, version = 1 | 43-47 |
| H4 ReferrerAlreadySet 6021 | 48 |
| H5 referrer = Some(key): tag 106 = 1, 107..139 = key | 49-50 |
| H9 PlayerStats disc written | 51 |
| H6 fresh referral: referrer, bump = canonical, tier 0, version 1 | 56-61 |
| H7 referred_count saturating_add(1) | 62-63 |
| H9 ReferralAccount disc written | 64 |
| H8 emit ReferrerSet { player, referrer, slot } | 67 |

## 2. claim_referral

| spec step | line |
|---|---|
| referral_account Account<ReferralAccount> 3012/3007/3001/3002/3003 | 81 |
| referrer signer 3010 | 82 |
| referral_account seeds with stored bump 40 -> 2006 | 88 |
| referral_account mut 2000 | 89 |
| constraint referral.referrer == referrer @ 6007 | 90 |
| referrer mut 2000 | 93 |
| H1 amount = accrued_lamports | 91 |
| H2 NothingToClaim 6023 | 96 |
| H3 rent = minimum_balance(103) | 97 |
| H4 withdrawable = lamports - rent, saturating | 98 |
| H5 payout = min(amount, withdrawable), 0 allowed | 99 |
| H6-H7 debit checked_sub 6008, credit checked_add 6008 | 100 (`helpers::move_lamports`) |
| H8 accrued = accrued.saturating_sub(payout) | 104-105 |
| H9 emit ReferralClaimed { referral.referrer (data field), payout, slot } | 106, 109 |

## 3. repair_referral

| spec step | line |
|---|---|
| vault Account<Vault> 3012/3007/3001/3002/3003 (paused byte > 1 -> 3003) | 123 |
| referrer unchecked | 119 |
| referral_account Account<ReferralAccount> | 124 |
| owner signer 3010 | 125 |
| vault seeds 2006 (D2: const PDA + const bump 254) | 128 |
| constraint vault.owner == owner @ 6007 | 129 |
| referral_account seeds with stored bump 40 -> 2006 | 131-134 |
| referral_account mut 2000 | 135 |
| H1 referrer_key = referrer.key | 130 |
| H2 already equal -> Ok, no event | 141-143 |
| H3 referrer != default -> Unauthorized 6007 | 144 |
| H4 referral.referrer = referrer_key | 145 |
| H5 emit ReferralRepaired { referrer_key, slot } | 148 |

## Deviations

| item | detail |
|---|---|
| 3005 timing | The slice pattern returns 3005 before any other Pass A check. Anchor checks the count per field, so with too few accounts AND an earlier failing field (for example 4 accounts and an unsigned player in set_referrer) Anchor returns that field's code (3010) where the port returns 3005. Both fail. This is the crate-wide PORT_NOTES convention. |
| Vault seeds | D2: const VAULT_PDA + bump 254 instead of create_program_address with the stored bump. Same accept set for a canonical vault. |
| PlayerStats exit image | Only changed bytes are written (tag, key, player, bump, version, disc). Anchor re-serializes `_reserved` at 139..203 after setting Some. Byte-identical under the spec invariant that 107..203 are zero while the tag is 0. |
| Lamport-check vs data write order | claim_referral moves lamports (100) before writing accrued (105); Anchor does the same (data written at exit). |
| Spec vs source | No disagreement found between spec and lib.rs:222-262, 800-860, 2275-2300, 2408-2444. |
| Host test | No handler-level host test added; handlers need runtime AccountView buffers. Parity is tested against the Anchor build in the later workflow. |
