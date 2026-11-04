# kaboom-p status (integration, 2026-11-04)

Pinocchio port of `programs/kaboom` (Anchor 0.31.1, git `e82f2c5`). New program id
`Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`. Nothing is deployed, signed or committed.

## What builds

| check | result |
|---|---|
| `cargo-build-sbf --manifest-path pinocchio/kaboom-p/Cargo.toml` (3.1.14) | builds, 0 warnings, 0 `Stack offset` lines |
| `cargo test --manifest-path pinocchio/kaboom-p/Cargo.toml` | 20/20 pass (17 `tests/abi.rs`, 3 in `src/ix/vrf.rs`) |
| handlers | 42/42 ported (41 `#[program]` + `process_undelegation`); `NOT_PORTED` removed |
| allocator (D13) | `no_allocator!()`; nothing uses the heap |
| PDA syscalls (D14) | only `sol_try_find_program_address` and `sol_create_program_address` are linked |
| security.txt (D7) | `auditors` = `None. Unaudited Pinocchio port` |

`tests/abi.rs` checks every instruction discriminator and log name, every account discriminator and
`SPACE`, every event discriminator, every error code, all fixed PDAs/bumps (vault 254, v2 255,
identity 253, scoped VRF identity 255) under the new id, dispatcher framework codes, the Borsh arg reader,
and the shared `calc_multiplier` fixture. `vrf.rs` tests: the 33-byte ScheduleIntentBundle payload
(D12), the 104-byte DLP Delegate data, and `Vec<Vec<u8>>` seed parsing (D9).

## Size and rent

| item | value |
|---|---|
| `target/deploy/kaboom.so` | **195,800 bytes after the VRF-only upgrade** (202,904 after Fixes F1-F6 + skeptic round 2, the deployed build; 202,728 before round 2; 195,848 before the fixes) |
| sha256 | `bb291333046c3c16f4c73f7bbb7f0332c97c2d448135ee9b17f9a57d9732023c` (was `671491e84b44ad706fa927f1f122035ddc6adee4faad9d696fc2a930d15e3d13`) |
| mainnet Rent sysvar (read 2026-11-04) | 5080 lamports/byte, threshold 1.0 |
| ProgramData rent for this size = (195,800 + 45 + 128) x 5080 | 995,542,840 lamports = 0.99554284 SOL (202,904: 1,031,631,160 = 1.03163116 SOL) |

The deploy also needs a buffer account of the same size for the duration of the deploy (refunded on
completion) plus fees. Any later upgrade that grows the `.so` needs `solana program extend` first.
The VRF-only build is 7,104 bytes smaller than the deployed 202,904-byte program, so its upgrade fits
the existing ProgramData without `extend`.

## Integration changes

- `helpers.rs`: added `check_vault_v2_mut` and `release_outstanding` (they were private copies in
  `vrf.rs` and `legacy_game.rs`) and removed `NOT_PORTED`. `legacy_game::win_payout` is gone; it was
  the same function as `mul_div_floor(bet, mult, BPS)`.
- `helpers::Args::take` and `state::rd_pk` no longer call `try_into().unwrap()`, which pulled the
  Debug/fmt code into the binary. The behaviour is unchanged: short args still return 102, and a bad
  offset still panics.
- `Cargo.toml`: **`opt-level = 3`, not the `"z"` in the binding decision.** Measured on this crate:
  `z` gives about 292 KB, `s` about 214 KB, `3` gives 195 KB. Under `z`, `copy_from_slice` and
  `RefMut::deref_mut` stay as out-of-line calls at about 350 sites each, so `z` missed the 150-220 KB
  target and costs more CU on every account access. The rest of the profile is unchanged (lto fat,
  codegen-units 1, strip, panic abort, overflow-checks true). To go back to `z`, change one line;
  that build is about 292 KB, about 0.48 SOL more rent.

## Spot checks against lib.rs / vrf_mode.rs (no mismatch found)

1. settle_vrf: replay pins, release of the reserved amount, payout cap, vault to player, stats,
   referral PDA, load and cut, treasury split liquidity, then closing the claim and the game.
2. refund_stalled_vrf: caller gate, stall window, ownership guard before the raw reads, refund
   vault to player, manual zero-close of the game (owner and length kept, D11), claim closed to player.
3. reveal_callback_vrf: the signer must be the scoped identity
   `PDA(["identity", ID], VRF program)` (address check gives 2012, signer check gives 3010), as the
   ephemeral-vrf-sdk 0.4.1 `#[vrf_callback]` injection does.
4. process_undelegation: buffer must be a signer, owned by the DLP, and equal to the canonical
   `["undelegate-buffer", base]` PDA under the DLP (the 0.16.2 fix). Then create, or for a pre-funded
   account transfer the shortfall, allocate and assign, then copy.
5. delegate_vrf: buffer created with 0 lamports (or allocate and assign if pre-funded), copy, zero,
   assign to system, assign to DLP, Delegate CPI, buffer closed to the player. Same end state as sdk
   0.15.5 `delegate_account_inner`.
6. settle_and_undelegate_vrf: payload checked against magic-program-api 0.10.1 (variant 11, bincode-1)
   with metas payer (writable, signer), magic_context (writable), game (writable), the same as the
   sdk 0.15.5 `MagicIntentBundleBuilder::build`.
7. lp_deposit: units priced on assets before the transfer, position initialised on first deposit,
   then house floor, position cap and health checked on the state after the deposit.
8. complete_withdraw: total_units read before the burn, `assets_out <= assets_pre`, burn, vault to
   user only when > 0, and the event carries total_units after the burn.
9. settle_game: commitment and mask checks, obligation released before referral and treasury, event
   order, referral PDA checked before the load.
10. unlock_operator_position: burn before the transfer, health checked on the vault after the
    transfer; withdraw_to_treasury allowlist gate; claim_referral payout capped at rent-exempt surplus.

Also confirmed: mainnet `Rent` is 5080 per byte with threshold 1.0, so pinocchio
`try_minimum_balance` equals Anchor's `minimum_balance` (D1).

## Deviations from Anchor behaviour (all fail where Anchor fails; no success-path difference)

| where | Anchor | port | why it is acceptable |
|---|---|---|---|
| 3005 timing, every group except house | checks the account count per field, so an earlier bad field reports its own code | slice pattern returns 3005 before any other check when accounts are short | both fail; house.rs uses lazy per-field `nth` (exact). Unify if the differential test asserts codes for short account lists |
| `reveal_request_vrf` identity | runtime find | const `IDENTITY_PDA`, 2006 | same address |
| `find` with no valid bump (referral PDA in settle_game / settle_vrf, `process_undelegation` > 15 seeds) | panics | 2006 / `InvalidSeeds` | both fail; unreachable in practice |
| `reveal_callback_vrf` tile >= 16 | panics on `1u16 << tile` | `ArithmeticOverflow` | both fail |
| `allowlist_remove` with corrupt count > 8 | panics | `InvalidAccountData`, loop clamped (D10) | unreachable: add caps at 8 |
| `close_to` lamport overflow | panics | `ArithmeticOverflow` | unreachable |
| full images on init | serializes the whole struct at exit | writes disc + non-zero fields into freshly zeroed data; PlayerStats/LpPosition disc re-stamped every call | byte-identical results |
| sysvar reads | `Clock::get` at each use | once per handler | same values within one tx |
| `delegate_vrf` buffer close | resize, assign, system Transfer CPI | direct lamport move + `close()` | same end state |
| `delegate_vrf` Delegate CPI | sdk `cpi_delegate` | hand-built 104 bytes, tested against the vendored args encoder | same bytes |
| D12 test baseline | sdk 0.15.5 builder | test compares with the vendored 0.17.3 pinocchio builder; the 0.15.5 / api 0.10.1 layout was checked by reading the source | sdk 0.15.5 is not a dev-dependency (it pulls solana-program 2.x) |
| error text (D5) | `AnchorError ... Error Number` log lines | numeric code only | decision D5 |
| IDL management ixs (D6) | handled | 101 | decision D6 |
| profile | opt-level `"z"` (binding decision) | opt-level 3 | see Integration changes; one-line revert |

Parity quirks kept on purpose (D11): a full board sets Won without paying; cash_out has no expiry
check; manual zero-close in refund_stalled_vrf and admin_close_orphaned_game_v2;
initialize_vault was permissionless (D15; closed by F1 below).

## Unimplemented

None.

## What the differential test workflow must cover

Run the same transactions against the Anchor build (old id, rebuilt) and this build (new id), and
compare: return code, every `Program log:` / `Program data:` line, every account's lamports, owner,
data length and data bytes, and CU.

- All 42 instructions on the happy path, including init and init_if_needed on a pre-funded PDA
  (transfer top-up, allocate, assign), and a second `init`, which must fail.
- Every `require!` / constraint failure per handler (6000+ codes) and the framework codes: 3012, 3007,
  3001, 3002, 3003 (bad bool/enum/Option bytes, D3), 3010, 3008/3009, 2006, 2000, 2001/6007, 2011,
  2012, 2019, 2004, 2005, 3005 (note the deviation above), 101, 102, 4100, 1500.
- Lamport conservation in settle_game, settle_vrf (win/loss, with and without a referral account,
  treasury split 0 and > 0), cash_out, refund_expired, refund_stalled_vrf (player and house caller),
  admin_release_vrf_claim, admin_close_orphaned_game_v2 (owned and DLP-owned game), claim_referral,
  withdraw_to_treasury, unlock_operator_position, complete_withdraw, house_complete_withdraw.
- Closes: closed accounts end with 0 lamports, owner System and length 0; zero-closed ones keep
  owner and length with data zeroed, and the runtime removes them at the end of the tx.
- LP math edges: first deposit (total_units 0), zero assets with live units, house floor, position
  cap, health floor, cooldowns.
- VRF on a local validator with the DLP / VRF / magic programs loaded: start, delegate (empty and
  pre-funded buffer), reveal request bytes (126-byte scoped request, disc 10), a callback from a wrong
  signer (must fail) and the scoped signer, cash_out_vrf, settle_and_undelegate CPI bytes, and
  process_undelegation with a non-canonical buffer, a non-DLP-owned buffer, and an unsigned buffer
  (all must fail).
- Event bytes (`Program data:` base64) for every emit, in order, compared with the Anchor IDL
  decoder; `Instruction: <Name>` line for every instruction (`/api/verify` greps `SettleVrf`).
- CU under the fixed 200,000 limit for settle_game (with a referral account), settle_vrf,
  start_game_vrf, lp_deposit and reveal_*, especially the canonical `try_find` calls (settle_game
  player_stats, lp_deposit position, start_game_vrf inits).
- The web client and SDK against the new id with only the program id swapped.

## Differential-test fixes (2026-11-04, verification gate)

All diffs from the differential workflow are closed; every test file passes
(smoke 8, spec_table 2, referral 138, house 22, v2-lp 79, vault-admin 26, vrf 113, legacy-game 269;
`cargo test` on this crate 20/20). Build: 0 warnings, 0 `Stack offset` lines.

- **D2 removed (helpers.rs `check_vault_seeds` / `check_v2_seeds`).** Now `create_program_address([seed, stored_bump])`
  == key, as Anchor's `seeds = [..], bump = x.bump`; the canonical (PDA, 254/255) pair takes a no-syscall fast path.
  A program-owned Vault/VaultV2State at a non-canonical PDA (unreachable on chain) is now accepted exactly as
  Anchor accepts it, in every instruction that checks vault/v2 seeds.
- **set_referrer (referral.rs).** None -> Some now moves the 64-byte `_reserved` from 107..171 to 139..203 before
  writing tag + referrer, matching Anchor's full Borsh re-serialize (old bytes in 171..203 are overwritten).
  Length is already pinned to 203 by init_if_needed (2019), so the shift always fits.
- **process_undelegation (vrf.rs), sdk 0.16.2 `InitializeAfterUndelegation`.** Account validation in field order:
  base mut (2000); buffer == canonical `["undelegate-buffer", base]` PDA under the DLP (2006, was handler
  `InvalidSeeds`); payer mut (2000); system_program `address = 11111111111111111111111111111111` (2012, was unchecked).
  Then the handler's signer and owner checks. `spec/vrf.md` section 11 still describes the 0.15.5 + fix order.
- **ELF EI_OSABI (lib.rs).** `#[used]` on `SECURITY_TXT` set SHF_GNU_RETAIN, so lld wrote EI_OSABI = 3 (GNU) and
  the sbpf loader would refuse the deploy ("wrong ABI"); `smoke.rs port_elf_is_deployable` caught it. Dropped
  `#[used]`, as `solana-security-txt` does; `#[no_mangle]` keeps `SECURITY_TXT` exported and the
  security.txt bytes are still in the .so. EI_OSABI is now 0.
- **Test fix (difftest/tests/house.rs `DIFF_all_noncanonical_bump_pda`).** It expected 2006 on both sides (written to
  stay failing on D2). Now it expects Anchor's outcomes: deposit ok, request 6035, cancel ok, complete 6036.

## Fixes F1-F6 (2026-11-04, owner decision "fix all six first")

Spec: `pinocchio/spec/FIXES.md` (binding), designs in `spec/design-F{2,3,4,6}.md`. These are deliberate
deviations from the Anchor reference; the differential tests mark each changed expectation `INTENDED: Fn`.
No account layout, size, offset or reserved byte changed; no event added. Discriminators, args and account
order of every Anchor instruction are unchanged. Instructions: 42 Anchor + `ExpireGame` + `ForceUndelegateVrf`
= 44. Errors: 6000-6054 unchanged, then 6055 `NotDeployer`, 6056 `WithdrawWindowExpired`.

| # | change (file) | intended divergence from Anchor |
|---|---|---|
| F1 | `consts::DEPLOYER` = `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG`; `initialize_vault` requires `owner == DEPLOYER` after Pass C (`vault_admin.rs`) | a non-deployer init that would succeed on Anchor fails 6055 (D15 "permissionless init" is gone) |
| F2 | new permissionless `expire_game` (`legacy_game.rs`), disc `d0155783f22bfc90`, accounts `vault W, v2 W, game W, player W` | new instruction (Anchor 101). Expired Playing game: refund branch (0 reveals or mult < 1x, full bet, Expired, reservation released) or cash branch (bet x mult, Won, released later by `settle_game`) |
| F3 | `consts::VRF_VOID = 3`; new house-only ER `force_undelegate_vrf` (`vrf.rs`), disc `da30a3da54f8e465`, accounts `house WS, game W, magic_program, magic_context W, vault`; `schedule_undelegate` extracted from `settle_and_undelegate_vrf` (CPI bytes unchanged, `sau_*` `assert_cpi_same` green); `refund_stalled_vrf` accepts VOID | new instruction (Anchor 101); refund of a status-3 game: Anchor 6050, port pays; round 2: `settle_and_undelegate_vrf` ends a PLAYING game first (`end_playing`, shared with the force): pending 6044, progress WON, none VOID (Anchor commits PLAYING as-is) |
| F4 | `consts::WITHDRAW_CLAIM_WINDOW_SLOTS = 9_000`; `complete_withdraw` no longer checks the user signature and fails 6056 after `unlock + 9_000` (checked last) (`v2_lp.rs`) | unsigned complete: Anchor 3010, port proceeds; complete after the window: Anchor ok, port 6056 |
| F5 | `settle_vrf`: referred player (`player_stats.referrer` Some) requires `remaining_accounts[0]`, else 6022 (`vrf.rs`). Legacy `settle_game` deliberately unchanged (house-gated) | referred settle without the PDA: Anchor ok (cut skipped), port 6022 |
| F6 | `start_game_vrf` reuses an orphaned VrfGame (program-owned, VrfGame disc, claim `init` already succeeded), wiping it (`vrf.rs::reuse_orphan_game`) | start on an orphan: Anchor fails (Allocate in use), port ok |

Tests: new `difftest/tests/fix_f1.rs` (3), `fix_f2.rs` (12), `fix_f3.rs` (10), `fix_f4.rs` (7), `fix_f5.rs` (4),
`fix_f6.rs` (6). Flipped to assert the exploit fails on the port: `audit_auth` (init front-run, settle_vrf
referral skip), `audit_pinocchio` (init front-run), `audit_money` (init front-run), `audit_magicblock` (MB-6).
Existing expectations changed (`INTENDED`): `v2-lp.rs::user_lp_action_attacks` (complete unsigned: Anchor
3010 / port 6037), `v2-lp.rs::complete_user_is_vault_alias` (fixture unlock START_SLOT), `vrf.rs::
sv_referral_loss_and_missing_remaining` (port 6022), `vrf.rs::ar_happy_and_boundary` (restart after release:
port ok; not listed in FIXES.md, same F6 case as MB-6). Harness: `DEPLOYER` + `Pair::deployer()`, used by
`init_vault` and the 11 former `p.user("owner")` sites. Host ABI test: 44 instructions (two appended, checked
against `sha256("global:<name>")`), IDL errors are a prefix of `KaboomError::ALL` plus the two appended codes,
`DEPLOYER` decodes to the base58 above.

Results: build 0 warnings, 0 `Stack offset` lines, EI_OSABI 0; `cargo test` here 20/20; difftest 726/726
(684 before + 42 new), every file run on its own. CU (port): `force_undelegate_vrf` 4,073
(`settle_and_undelegate_vrf` 3,879); 10 x `expire_game` in one tx 31,460 CU, 1,020 bytes;
`[expire_game, settle_game]` with referral 13,201; `start_game_vrf` reusing an orphan 18,640.

Owner/relay follow-ups (not in this crate): sign `initialize_vault` with the deployer key; keep
`withdraw_cooldown_slots >= 450,000`; run a minimum-bet mainnet check of F3 on the real ER; SDK builders
and the house cron passes listed in FIXES.md section 9; residual cycling risk in section 10 needs a decision.

## Skeptic round 2 (2026-11-04)

Verdicts and reasoning: `spec/FIXES.md` section 12.

- **F3-0 / F3-1 confirmed, fixed.** A player could self-undelegate a PLAYING game with a pending reveal or with
  progress and leave it on L1 out of every crank's reach. `vrf.rs::settle_and_undelegate_vrf` now runs
  `end_playing` (the force's mapping, extracted): pending 6044, progress WON, none VOID. CPI bytes unchanged.
  `challenge_F3_0.rs` (2) and `challenge_F3_1.rs` (2) rewritten to assert the fix. Changed expectations
  (`INTENDED: F3`): `vrf.rs::sau_happy`, `life_two_games_streak_and_refund_after_undelegate`,
  `life_redelegate_after_undelegate`, `fix_f3.rs::f3_force_cu`.
- **F4-0 confirmed, NOT fixed.** An LP that also plays can time its own win into its exit; no on-chain fix fits the
  binding constraints (owner decision, FIXES.md section 10). The 1.37% / 0.03% bound is withdrawn.
  `challenge_F4_0.rs` stays as a passing record of the residual.
- **F4-1 confirmed, keeper-spec fix** (one completion per tx, FIXES.md 9.3.f). No program change.

Results after round 2: build 0 warnings, 0 `Stack offset` lines, EI_OSABI 0; `cargo test` here 20/20; difftest
753/753, every file run on its own (29 files incl. all `challenge_*.rs`). CU (port): `settle_and_undelegate_vrf`
on a PLAYING game 3,909, `force_undelegate_vrf` 4,075. Test-only warnings: `v2-lp.rs` has two unused helpers
(`vault`, `set_vault`), not touched here.

## VRF-only upgrade (2026-11-04, owner decision: raw house key, MagicBlock VRF only)

Why: with a raw `HOUSE_SECRET_KEY` on the web server, commit-reveal `start_game` lets a key thief drain the
vault (the player supplies the commitment, the house key reveals and settles). The legacy start is therefore
switched off on chain; every other legacy instruction stays so stray games can still wind down.

- `legacy_game.rs::start_game` now returns **6057 `LegacyModeDisabled`** before reading any account or arg
  (the body is gone). The dispatcher still logs `Program log: Instruction: StartGame` first. Discriminator,
  IDL account list and args are unchanged, so old clients get a clean custom error. Port CU: under 1,000.
- `error.rs`: `LegacyModeDisabled` appended after `WithdrawWindowExpired` (6000-6056 unchanged).
- Unchanged: `reveal_tile`, `cash_out`, `settle_game`, `refund_expired`, `close_game`, `close_unsettled_game`,
  `expire_game` (F2). No account layout, event or other instruction changed.
- `tests/abi.rs::errors_match_idl`: IDL prefix 55, then `NotDeployer`, `WithdrawWindowExpired`,
  `LegacyModeDisabled`; `LegacyModeDisabled.code() == 6057`.
- difftest (`INTENDED: VRF-only`): new harness `Pair::run_legacy` / `Diff::vrf_only|anchor_ok|anchor_err|anchor_failed`
  (HARNESS.md). A legacy start asserts port 6057 and copies Anchor's post-state onto the port (set_account), so
  every reveal / cash_out / settle / refund / close / expire test still runs on both sides from a real
  GameSession. `Pair::start_game` uses it. Changed expectations: all `sg_*` tests in `legacy-game.rs` (port
  6057; Anchor's own result still checked), `flow_refund_close_restart`, `flow_unsettled_close_restart`,
  `flow_settle_close_restart_same_tx` and `flow_start_reveal_same_tx` (start split into its own tx; the rest of
  the tx still runs on both), `st_popcount_mismatch_6015`; `audit_money` and `fix_f2` griefer loops;
  `fix_f2::f2_cash_branch_pays_cash_value_then_house_settles` (player2's game started before the port-only
  `expire_game` divergence); `fix_f2::f2_garbage_games_cleared_by_stranger`, `audit_magicblock::mb1_*` and
  `fix_f3::f3_mb1_cleared` (a legacy start after the attack is now 6057 on the port, not "unfrozen").
  New test `legacy-game.rs::sg_vrf_only_6057_any_input` (full ix, no accounts, data cut to the disc: all 6057,
  port CU < 1,000).

Results: build 0 warnings, 0 `Stack offset` lines, EI_OSABI 0; `cargo test` here 20/20; difftest 754/754 (753 + 1),
every file run on its own with `--test-threads=2` (29 files). Test-only warnings unchanged (`v2-lp.rs` `vault`,
`set_vault`).
