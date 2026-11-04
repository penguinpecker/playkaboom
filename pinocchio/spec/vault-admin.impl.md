# vault-admin implementation checklist

File: `pinocchio/kaboom-p/src/ix/vault_admin.rs`. "L" = line in that file. Dispatch (`src/lib.rs` `process_instruction`) logs `Instruction: <PascalName>` for all ten before the handler runs (names in `src/ix/mod.rs` table rows 1-10).

## Private helpers

| helper | L | spec |
|---|---|---|
| `is_allowlisted` | 16-19 | 0.5 is_allowlisted (scan `min(count, 8)`) |
| `vault_gate(vault, signer, key_off)` | 24-30 | 0.4 Phase A `Account<Vault>` 3012/3007/3001/3002/3003 (incl. paused byte 3003), `Signer` 3010; Phase B seeds 2006 (D2 const), mut 2000, `constraint = vault.<key> == signer @ Unauthorized` 6007 |

## 1. initialize_vault

| spec step | L |
|---|---|
| Args decode u16 x3 (102) | 35-38 |
| 3005 | 39-41 |
| Phase A owner signer 3010 | 42 |
| Phase A system_program 3008/3009 | 43 |
| 3a seeds: key == VAULT_PDA else 2006, bump 254 const (D2) | 45-47 |
| 3b rent | 48 |
| 3c/3d CreateAccount or Transfer top-up + Allocate + Assign, 4101 (helpers::create_pda) | 49 |
| 3f vault mut 2000 | 50 |
| 3f rent-exempt 2005 | 51-53 |
| 4 owner mut 2000 | 55 |
| handler 1 house_edge_bps <= 1000 | 57 |
| handler 2 max_bet_bps | 58 |
| handler 3 max_payout_bps | 59 |
| handler 4 full image (disc, keys, bump, bps, split 5000, version 1, rest zero) | 60-77 |
| handler 5 VaultInitialized | 78 |

## 2. fund_vault

| spec step | L |
|---|---|
| Args amount u64 | 85 |
| 3005 | 86-88 |
| Phase A vault load / funder signer / system_program | 89-91 |
| Phase B vault seeds / mut, funder mut | 92-94 |
| 1 amount > 0 InvalidAmount | 95 |
| 2 system Transfer CPI | 96 |
| 3 VaultFunded, new_balance read after CPI | 97 |

## 3. withdraw_to_treasury

| spec step | L |
|---|---|
| Args amount u64 | 104 |
| 3005 | 105-107 |
| Phase A + vault seeds / mut / treasury constraint 6007 | 108 |
| destination mut 2000 | 109 |
| 1 amount > 0 | 110 |
| 2 dest_key | 111 |
| 3 !executable InvalidAmount | 112 |
| 4 dest != vault InvalidConfig | 113 |
| 5 allowlisted DestinationNotAllowlisted | 114 |
| 6-8 rent(428), available, min (may be 0) | 115-116 |
| 9 direct lamports, checked 6008 | 117 |
| 10 TreasuryWithdrawal | 118 |

## 4. unlock_operator_position

| spec step | L |
|---|---|
| 3005 | 125-127 |
| Phase A vault, v2_state (incl. byte 127 3003), owner | 129-131 |
| Phase B vault seeds / mut / owner constraint 6007 | 133-135 |
| Phase B v2 seeds (D2 const) / mut | 136-137 |
| destination mut | 138 |
| 1 burn_units checked_add 6008 | 142-148 |
| 2 burn_units > 0 NoOperatorUnitsToUnlock | 149 |
| 3 !executable InvalidAmount | 150 |
| 4 dest != vault InvalidConfig | 151 |
| 5 allowlisted | 152 |
| 6 rent, assets | 153-154 |
| 7 payout_lamports | 155-156 |
| 8 user_pending_value | 157 |
| 9 withdrawable | 158-160 |
| 10 actual | 161 |
| 11 actual > 0 InsufficientLiquidity | 162 |
| 12 burned_* captured | 142-144 |
| 13 total_units checked_sub 6008 | 163 |
| 14 zero seed/house/pending units + unlock slot | 164-167 |
| 15 direct lamports | 168 |
| 16-17 assets_after + enforce_min_health 6034 (post-burn v2 bytes) | 169 |
| 18 OperatorUnitsUnlocked | 171-179 |

## 5. update_vault

| spec step | L |
|---|---|
| Args 7 Options (tag / bool 102) | 186-193 |
| 3005 | 194-196 |
| UpdateVault gate | 197 |
| 1 house_edge_bps | 201-204 |
| 2 max_bet_bps | 205-208 |
| 3 max_payout_bps | 209-212 |
| 4 treasury_split_bps <= 10000 | 213-216 |
| 5 paused | 217-219 |
| 6 new_house_authority != 0 | 220-223 |
| 7 new_treasury != 0 | 224-227 |
| 8 VaultUpdated (always) | 229 |

## 6. allowlist_add

| spec step | L |
|---|---|
| Args address | 236 |
| 3005 + gate | 237-240 |
| 1 count < 8 AllowlistFull | 245 |
| 2 not present AlreadyAllowlisted | 246 |
| 3 write slot | 247 |
| 4 count saturating_add | 248 |
| 5 AllowlistChanged added=true | 250 |

## 7. allowlist_remove

| spec step | L |
|---|---|
| Args address | 257 |
| 3005 + gate | 258-261 |
| 1 count | 265 |
| 2 first match in `0..min(count, 8)` (D10), AddressNotInAllowlist | 267-269 |
| 3 last | 270 |
| count > 8 guard (Anchor panics) | 272-274 |
| 4 swap last into idx | 275-278 |
| 5 zero last | 279 |
| 6 count - 1 | 280 |
| 7 AllowlistChanged added=false | 282 |

## 8. propose_owner

| spec step | L |
|---|---|
| Args new_owner | 289 |
| 3005 + gate | 290-293 |
| 1 != zero InvalidConfig | 297 |
| 2 != owner InvalidConfig | 298 |
| 3 pending_owner = new_owner | 299 |
| 4 OwnerProposed | 302 |

## 9. cancel_proposed_owner

| spec step | L |
|---|---|
| 3005 + gate | 309-312 |
| 1 pending != zero NoPendingOwner | 316 |
| 2 pending = zero | 317 |
| 3 OwnerProposalCancelled | 319 |

## 10. accept_ownership

| spec step | L |
|---|---|
| 3005 + gate (pending_owner == new_owner @ 6007 before handler) | 326-329 |
| 1 pending != zero NoPendingOwner | 335 |
| 2 pending == new_owner Unauthorized | 336 |
| 3 old_owner, owner = pending, pending = zero | 337-339 |
| 4 OwnerAccepted (new_owner = vault.owner after write) | 342 |

## Deviations

| item | Anchor | port |
|---|---|---|
| allowlist_remove with corrupt `allowlist_count > 8` and a match in the first 8 | panics on `withdraw_allowlist[last]` | `ProgramError::InvalidAccountData` (L272-274); unreachable because allowlist_add caps at 8 |
| initialize_vault seeds check | `find_program_address` | const `VAULT_PDA` / `VAULT_BUMP` compare (D2); same accept set |
| Spec vs source | no disagreement found in lib.rs 148-214, 948-1301, 2241-2273, 2499-2564 | none |

## F-fix deviations (2026-11-04, binding spec `FIXES.md`)

- F1 (`initialize_vault`): after Pass C (`check_mut(owner)`) and before the `InvalidConfig` checks, the port requires `owner == DEPLOYER` (`qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG`), else 6055 `NotDeployer`. Every Anchor error path keeps its code; a non-deployer init that Anchor accepts fails on the port.
