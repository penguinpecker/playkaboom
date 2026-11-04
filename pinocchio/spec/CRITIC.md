# Spec critic report (kaboom-p Pinocchio port)

Scope: every file in `pinocchio/spec/` checked against `programs/kaboom/src/lib.rs` + `vrf_mode.rs` at HEAD `e82f2c5`
(read in full), `target/idl/kaboom.json`, the Anchor 0.31.1 / ephemeral-rollups-sdk 0.15.5 / ephemeral-vrf-sdk 0.4.1 /
magicblock-magic-program-api 0.10.1 / borsh 0.10.4 / pinocchio 0.11.2 sources in `~/.cargo/registry`, and the vendored
`ephemeral-rollups-pinocchio-0.17.3`. Nothing was built, deployed or signed. The only network call was one read-only RPC
read of the mainnet Rent sysvar.

## 1. How each check was done

| check | method | result |
|---|---|---|
| (a) 41 + 1 instructions, each specified once | Matched every IDL instruction name against the `## N. <name>` headings in all spec files (script). | 42/42, each exactly once: house 4, referral 3, legacy-game 7, v2-lp 7, vault-admin 10, vrf 11 (incl. `process_undelegation`). `#[ephemeral]` 0.15.5 injects only `process_undelegation` (checked the macro). |
| (b) every `require!` / constraint / error at the right step | Read every handler and context by hand. Then a script collected each handler's `KaboomError::*` (plus the errors of the helpers it calls) and checked that its spec section names each one. | All present. The only gaps were three VRF steps that call helpers without naming their codes; annotated (see §2). The remaining script hits are sections that reuse another section's account table by reference, which is fine. |
| (c) account types, events, errors in shared.md vs IDL | Script: field offsets/sizes of all 8 accounts and 34 events computed from IDL types and compared with the shared.md tables; error table compared row by row (code, hex, name, message). The §9 index was compared with IDL account order and W/S flags. | All match: 8 accounts, 34 events, 55 errors, 42 index rows. |
| (d) discriminators | Recomputed `sha256("global:"/"account:"/"event:" + name)[..8]` with python3 and checked every 16-hex token and every 8-byte decimal array in every spec file, including that each sits next to its own name. | All correct. The 32-byte decimal arrays in vault-admin.md are pubkeys; checked them separately. |
| PDAs / bumps | Pure-Python `find_program_address` (ed25519 on-curve test), checked against an old-ID vault address that appears in the repo. | vault `7dPQVB4…` bump 254, v2 `Gtkn8Te…` 255, identity `7LmGUyc…` 253, scoped VRF identity `DypFSEH…` 255: all as specified. |
| `Instruction: <Name>` log lines | Checked that all 42 PascalCase strings are in `target/deploy/kaboom.so`. | All present. |
| (e) lamport flows, init / close / exit | Compared with anchor-syn `constraints.rs` (`generate_constraint_init_group`, `generate_create_account`, `linearize`), `try_accounts.rs`, anchor-lang `common.rs::close` and `Account::exit`; sdk 0.15.5 `create_pda`, `delegate_account_inner`, `close_pda_with_system_transfer`, `undelegate_account`; pinocchio `AccountView::close`. | Correct except the two shared.md items in §2. |
| MagicBlock wire bytes | Rebuilt from source: Delegate CPI (8-byte disc 0, borsh `DelegateAccountArgs`, 7 metas), VRF scoped request (126 bytes, 5 metas, disc byte 10), ScheduleIntentBundle (variant 11, bincode 1, 33 bytes, metas `[payer W S, magic_context W, game]`). | All three match vrf.md / shared.md §6 byte for byte. |
| Rent | Read the live Rent sysvar and called `getMinimumBalanceForRentExemption(428)` (read-only RPC). Read pinocchio 0.11.2 `sysvars/rent.rs`. | Sysvar = `(5080, 1.0, 50)`; RPC = 2,824,480. pinocchio reads only the first u64 and computes `(128+n)*5080`, which is the same number. |

## 2. What I changed

| file | change | why |
|---|---|---|
| shared.md §5.4 step 4 | Reordered the `init_if_needed` post-checks to **2019 space → 2004 owner → 2005 rent**, and noted that Anchor's owner read sees the post-CPI owner. | The old text listed owner (2004) first. `constraints.rs:1107-1123` checks space first. referral.md, legacy-game.md, v2-lp.md and vrf.md already had the correct order. |
| shared.md §5.6 | Exit gate corrected: Anchor checks `T::owner() == program_id` (always true) and `!is_closed`, NOT the account's live owner. | `account.rs:357-359`. No behaviour change for the port, since the write is byte-identical (e.g. `settle_and_undelegate_vrf.game`), but the old wording implied the write is skipped when the owner changed. |
| referral.md, legacy-game.md §0.2, v2-lp.md §0.5 / §1 / §3 / open Q5, vrf.md §0.6 | Replaced stale rent figures based on the old default rent (6960 per byte = 3480 × 2.0) with live mainnet values (5080 per byte, threshold 1.0). Examples: Vault 2,824,480; V2 1,620,520; LpPosition 1,264,920; GameSession 1,564,640; PlayerStats 1,681,480; ReferralAccount 1,173,480; VrfClaim 1,000,760; VrfGame 3,804,920. | shared.md, house.md and vault-admin.md already used 5080. The others contradicted them, and v2-lp.md open Q5 asked to "confirm 6960", which is false. These are sanity values only; the port reads the sysvar. |
| legacy-game.md §0.2 | "borsh 1.x" → "borsh 0.10.4". | anchor-lang 0.31.1 depends on borsh 0.10.3 (lock: 0.10.4). Its bool/Option/enum decode is strict too, so no rule changes. |
| vrf.md §1 step 23, §4 step 8, §7 step 11 | Named the error codes the called helpers can return (`enforce_min_health` → 6034/6008; `calc_multiplier` → 6000/6008/panic). | Completeness for check (b). |
| house.md §5.9 | Changed "keep stored-bump `create_program_address` for parity" to "either form; use the shared loader's". | It contradicted shared.md §0 and vault-admin.md §0.4, which recommend the const compare. The two forms accept and reject the same inputs (§3, Q-B). |

Everything else checked out: account orders and flags, arg offsets and lengths, constraint order per field, handler
step order, saturating vs checked arithmetic, event payloads and order (including settle_game's
TierChanged → Accrued → TreasuryAccrued → GameSettled → VaultUnitValueUpdated → StatsUpdated, and the absence of any event
in the VRF instructions), close targets and the order of exits, the manual zero-closes, and the pre-funded PDA branches
(init/init_if_needed: `max(rent,1) − lamports` top-up; delegate buffer: no top-up; undelegate re-create: `rent − lamports`, no `max(1)`).

## 3. Open questions from the spec writers: what is now settled, and what is still open

### Settled by evidence (no owner decision needed)

- **Rent value (several Qs).** Live mainnet is 5080 per byte with threshold 1.0, not 6960. pinocchio and solana-rent give identical results today (RPC confirms 2,824,480 for 428 bytes). Only the policy question below is left.
- **Q-B: const-PDA seeds check** (`key == VAULT_PDA && bump == 254`, `key == V2_PDA && bump == 255`). It accepts and rejects exactly what Anchor does, with the same code (2006). A different stored bump derives a different address. A program-owned Vault or V2 can never sit at a non-canonical-bump address, because this program only ever signs with the canonical bump. Safe to adopt everywhere.
- **Account data length rule.** Anchor decodes with borsh `deserialize`, not `try_from_slice`, so longer data is accepted and only a short body fails (3003). The exact-length check (2019) exists only on `init_if_needed`. The `>=` rule in v2-lp.md / house.md / vrf.md §0.7 is correct.
- **repair_referral Vault parsing.** Anchor loads `Account<Vault>` with a full borsh decode, so `data_len < 428` and `paused > 1` both fail with 3003 there. A shared loader (len ≥ SPACE + bool-byte check) covers this automatically.
- **Shared math helpers.** The definitions in shared.md §4.3, v2-lp.md §0.8, house.md §0.4, vault-admin.md §0.5, legacy-game.md §0.6 and vrf.md §0.10 agree with each other and with `lib.rs:1790-1967`. Implement them once.
- **ScheduleIntentBundle bytes.** The 33-byte payload in vrf.md §6 matches sdk 0.15.5 + magic-program-api 0.10.1 (variant 11; commit None; commit_and_undelegate Some(Standalone([2]), Standalone); finalize None ×2; empty actions). Either the hard-coded constant or the vendored builder is fine, provided there is a byte-equality test.
- **Vendored undelegate.** It does validate the canonical undelegate buffer (`is_canonical_undelegation_buffer`, InvalidSeeds), which is the 0.16.2 fix. It still uses the panicking `Address::find_program_address` (vendored `pda.rs:5`), so the task's no-panicking-variants rule still means replacing that call.
- **Off-chain error parsing.** `packages/sdk/src/errors.ts:88,170` and `apps/web/src/lib/program-errors.ts:88-90` all fall back to the runtime's `custom program error: 0x…` / `"Custom":N`. Codes-only is enough for every in-repo consumer. Whether to print Anchor's text lines is cosmetic (still listed below).
- **Full-board win not paid.** Confirmed in the source (`lib.rs:425-428`; cash_out needs Playing; settle_game moves no lamports) and confirmed that the web workaround exists (`apps/web/src/app/api/reveal/route.ts:120-138`). Parity keeps it.
- **admin_close_orphaned_game_v2 is vestigial.** True: only this program can sign for `["game_v2", player]` under the new ID, and nothing creates it.

### Still open: owner / lead decisions

1. **Rent policy:** accept `try_minimum_balance` as is (recommended; identical today), or also read the threshold (`sol_get_sysvar` bytes 8..16) and fail closed if it is ever not 1.0. Decide this once, in the shared `vault_assets` helper.
2. **initialize_vault is permissionless:** the first caller after deploy becomes owner, as in Anchor. Plan to land deploy and `initialize_vault` back to back from the owner key. Parity forbids hardcoding an owner.
3. **Bool-byte 3003 checks** (Vault.paused@137, V2.vrf_mode_enabled@127, VrfClaim.settled@67, VrfGame.pending@79, GameSession.settled@112, GameStatus ≤ 3, PlayerStats referrer tag ≤ 1). Recommended: include them in the shared loaders. VrfGame bytes come back from the rollup, so for VrfGame the check is not dead code.
4. **Error order fidelity:** the specs give Anchor's order (typed loads → init fields → other fields' seeds/mut/raw/close/address). Failing at all is mandatory; matching the exact code is "where cheap". Lead to confirm that one shared loader reproduces the order.
5. **Anchor error text lines** (`AnchorError … Error Number: N`): codes only (recommended) or print them for explorers (about 3-4 KB).
6. **IDL management instructions** (`40f4bc78a7e9690a`): drop them (they then fail with 101; publish the IDL off-chain or through Program Metadata), or port them. Recommended: drop.
7. **security.txt `auditors` text:** keep the bytes identical, or say the Pinocchio port is unaudited. Owner's call under the audit-claims rule.
8. **Pre-funded PDA handling:** hand-write the transfer+allocate+assign branch for our init/init_if_needed accounts and for the delegate buffer. The vendored `delegate_account` lacks it, so a donated lamport would block `delegate_vrf`. The vendored undelegate's CreateAccount-only path is acceptable (lamports are 0 at that point); confirm.
9. **process_undelegation parsing:** Anchor-tolerant (accept 0 seeds and trailing bytes; 102 on short data) or the vendored strict parser. Only the DLP calls it, so either is safe.
10. **settle_vrf / settle_game referral PDA:** keep `try_find_program_address` (spec default; keeps 6022 before 3007) or switch to stored-bump `create_program_address` (saves ~1.5-3k CU, changes which error fires for bogus accounts).
11. **allowlist_remove with a corrupt count > 8:** unreachable. Clamp to `min(count, 8)` (vault-admin.md) or error; both fail or match on every reachable state.
12. **Parity quirks the owner may want to change later** (all kept for now): the full-board win is never paid; cash_out has no expiry check; the manual zero-close in refund_stalled_vrf / admin_close_orphaned_game_v2 leaves the owner and length in place, so a re-init in the same tx fails.
13. **Allocator** (`no_allocator!` vs bump) and **ER loadability** of the .so: settle at build time / in the test workflow.
14. **Housekeeping:** the vendored crate's own `#[cfg(test)]` no longer compiles after the `vrf/instruction.rs` patch. The IDL still embeds the old program ID in `delegate_vrf.buffer_game.pda.program` / `owner_program`, so clients must derive these under the new ID.

## 4. Notes for the implementer (not spec errors)

- pinocchio `AccountView::close()` zeroes owner, lamports and data_len but not the data bytes. Credit the target **before** calling it (it zeroes lamports). The end state equals Anchor's `close` (assign System + realloc 0).
- Anchor's `actual_owner` in `init_if_needed` is a live reference. A port that caches the owner value before the create CPI must re-read it, or it will raise a false 2004.
- `target/deploy/kaboom.so` is dated 2026-07-28; the log-string check used it. The IDL is the HEAD build (it has `vrf_max_payout_bps`).
