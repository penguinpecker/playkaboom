# vrf.impl.md: spec `vrf.md` to `kaboom-p/src/ix/vrf.rs`

Lines are in `pinocchio/kaboom-p/src/ix/vrf.rs`. The dispatcher prints `Instruction: <Name>` for all 11 instructions (`ix/mod.rs` table; `lib.rs` `process_instruction`, before the handler runs). These handlers emit no events and log nothing else.

## 1. start_game_vrf

| spec step | line |
|---|---|
| args mine_count u8, bet u64, session_key (102) | 84-87 |
| account count (3005) | 88-90 |
| A: player Signer 3010, vault/v2 load, system_program 3008/3009 | 92-95 |
| B: claim init (find 2006, create/pre-funded, mut, rent) | 99 |
| B: game init | 100 |
| B: player_stats init_if_needed | 101-102 |
| C: player mut, vault seeds+mut, v2 seeds+mut | 104-105 |
| 1-3 VrfModeDisabled, VrfValidatorNotSet x2 | 111-113 |
| 4-6 VaultPaused, InvalidMineCount, BetTooLow | 114-116 |
| 7 available before transfer | 117 |
| 8-11 pre_health, effective bet/payout bps | 118-121 |
| 12 max_bet / BetExceedsMax | 122-123 |
| 13-14 worst / VaultInsufficientFunds | 124-127 |
| 16 system Transfer player->vault | 131 |
| 17 Clock | 132 |
| 18 claim full image incl. disc | 134-145 |
| 19 game image (disc + non-zero fields) | 146-158 |
| 20 stats first-time init (+disc if created) | 159-169 |
| 21 total_games / total_wagered saturating | 170-176 |
| 22 outstanding checked_add (6008) | 177-179 |
| 23 enforce_min_health(new_assets) | 180 |

## 2. delegate_vrf

| spec step | line |
|---|---|
| account count, remaining | 191-193 |
| A: player 3010, v2 load, system_program | 195-197 |
| C: player mut | 199 |
| C: buffer_game seeds (find, our id) + mut | 201-202 |
| C: delegation_record seeds under passed DLP + mut | 203-204 |
| C: delegation_metadata seeds under passed DLP + mut | 205-206 |
| C: game seeds (find) + mut | 208-209 |
| C: v2 seeds (no mut) | 210 |
| C: owner_program / delegation_program address 2012 | 211-212 |
| 1 pinned != default | 215-216 |
| 2 remaining[0] == pinned (6054) | 217-219 |
| 3 check_vrf_game_delegable a-e | 220-223 |
| 4a bumps reused from seed checks | 224 |
| 4b data_len | 259 |
| 4c buffer CreateAccount(0) or pre-funded Allocate+Assign | 264-270 |
| 4d copy game->buffer | 271-275 |
| 4e zero game | 276 |
| 4f direct assign System | 277-280 |
| 4g Assign CPI to DLP, game-signed | 281-286 |
| 4h DLP Delegate CPI, 104-byte data, 7 metas | 229-241, 287-302 |
| 4i buffer close to player | 305-307 |

## 3. reveal_request_vrf

| spec step | line |
|---|---|
| args tile_index, client_seed (102) | 318-320 |
| A: session 3010, game load, vrf_program 3008/3009, system_program | 326-329 |
| C: session mut, game seeds (stored bump) + mut | 331-333 |
| C: oracle_queue mut, address @ 6054 | 334-335 |
| C: program_identity == IDENTITY_PDA (2006) | 336-338 |
| C: slot_hashes address 2012 | 339 |
| 1-5 BadSessionKey, GameNotPlaying, InvalidTileIndex, RevealPending, TileAlreadyRevealed | 344-349 |
| 6 pending = 1, pending_tile | 350-351 |
| 7 scoped VRF CPI (disc 10, 126 bytes, callback meta game w, signer identity/253) | 353, 360-391 |

## 4. reveal_callback_vrf

| spec step | line |
|---|---|
| args randomness [u8;32] (102) | 401 |
| A: identity 3010, game load | 406-407 |
| C: identity address 2012, game mut | 409-410 |
| 1 NoRevealPending | 414 |
| 2 bit = 1 << tile, fails if tile >= 16 | 415-417 |
| 3 TooManyReveals | 418-419 |
| 4 reveals[idx], reveal_count saturating | 420-423 |
| 5 decide_mine with pre-increment safe_reveals | 425-426 |
| 6 revealed_mask, pending 0, pending_tile 255 | 427-430 |
| 7 mine: mine_mask, status 2 | 431-434 |
| 8 safe: safe_reveals, multiplier, status 1 on full clear | 435-444 |

## 5. cash_out_vrf

| spec step | line |
|---|---|
| A + C | 459-463 |
| 1-4 BadSessionKey, GameNotPlaying, RevealPending, NoTilesRevealed | 467-470 |
| 5 status 1 | 471 |

## 6. settle_and_undelegate_vrf

| spec step | line |
|---|---|
| A: payer 3010, game load, magic_program 3008/3009 | 503-505 |
| C: payer mut, game seeds + mut, magic_context mut + address | 507-511 |
| 1 BadSessionKey | 514-518 |
| 2 ScheduleIntentBundle 33-byte payload, metas payer ws / ctx w / game w | 480-492, 519-525 |
| D12 byte test vs vendored builder | tests::schedule_cau_bytes_match_builder |
| 3 no write to game after CPI | 525 |

## 7. settle_vrf

| spec step | line |
|---|---|
| account count, remaining | 630-632 |
| A: payer, claim/game/vault/v2/stats load, system_program | 634-640 |
| C: payer mut, player mut | 642-643 |
| C: claim seeds/mut/Unauthorized/close 2011 | 645, 40-49 |
| C: game seeds/mut/Unauthorized/close 2011 | 646-652 |
| C: vault seeds+mut, v2 seeds+mut | 653 |
| C: treasury mut, address @ Unauthorized | 654-655 |
| C: player_stats seeds/mut/Unauthorized | 656-661 |
| 1 GameAlreadySettled | 667 |
| 2-11 replay and all checks | 670, 532-560 |
| 12 outstanding saturating_sub(reserved) | 671 |
| 13-14 payout, PayoutExceedsReserved, VaultInsufficientFunds, lamports, total_payouts | 673-684 |
| 15 stats | 686-687, 564-593 |
| 16 referral (find, 6022, load, 6022, cut, min, lamports, fields, tier) | 687-691, 596-623 |
| 17 treasury split | 693-710 |
| 18 dead claim.settled write skipped | 711 |
| 19 exit close claim then game | 714-715 |

## 8. refund_stalled_vrf

| spec step | line |
|---|---|
| A: caller 3010, claim/vault/v2 load | 730-733 |
| C: player mut, claim, game seeds (find) + mut, vault, v2 | 735-740 |
| 1 GameAlreadySettled | 745 |
| 2 player or house_authority | 748-750 |
| 3 NotStalledYet | 751-752 |
| 4a-e GameStillDelegated, BadGameAccount, GameAlreadyResolved, BadGameAccount, Unauthorized | 753-762 |
| 5 outstanding saturating_sub | 763 |
| 6 VaultInsufficientFunds | 764-765 |
| 7 vault -> player bet | 766 |
| 8 manual zero-close of game | 768 |
| 9 exit close claim | 770 |

## 9. admin_release_vrf_claim

| spec step | line |
|---|---|
| A | 785-788 |
| C: owner == vault.owner (first), player mut, claim, vault, v2 | 790-793 |
| 1 GameAlreadySettled | 798 |
| 2 NotStalledYet (216000) | 801-802 |
| 3 outstanding saturating_sub | 803 |
| 4-5 payable = min(bet, admin_spendable), lamports | 804-808 |
| 6 exit close claim | 810 |

## 10. admin_close_orphaned_game_v2

| spec step | line |
|---|---|
| A | 825-827 |
| C: owner constraint, player mut, game seeds (find) + mut, vault, v2 | 829-834 |
| 1-4 len, disc, player, field reads | 837-843 |
| 5 GameAlreadySettled | 844 |
| 6 outstanding saturating_sub(max_payout) | 845 |
| 7 payable lamports | 846-850 |
| 8 zero-close only if owned by us | 851-853 |

## 11. process_undelegation

| spec step | line |
|---|---|
| args Vec<Vec<u8>>, short 102, trailing ignored, n = 0 ok | 861-879, 887 |
| account count | 888-890 |
| C: base_account mut, payer mut | 892-893 |
| 1 buffer signer (MissingRequiredSignature) | 896-898 |
| 2 buffer owner DLP (InvalidAccountOwner) | 899-901 |
| 3 canonical undelegate-buffer PDA (InvalidSeeds) | 902-909 |
| 4 bump via try_find (InvalidSeeds) | 910-913 |
| 5 space, rent | 914-915 |
| 6 CreateAccount, or Transfer shortfall + Allocate + Assign | 916-930 |
| 7 copy buffer -> base | 931-933 |

## Deviations

- reveal_callback_vrf step 2: Anchor panics on `1u16 << tile` when tile >= 16. The port returns `ArithmeticOverflow`. Both fail.
- process_undelegation: if there are more than 15 seeds, or no bump is found, Anchor panics in `find_program_address`. The port returns `InvalidSeeds`. The pre-funded base_account branch from 0.15.5 is kept; D8 would also have accepted CreateAccount only.
- settle_vrf referral PDA: when `try_find` returns `None`, the helper fails with 2006 where Anchor panics.
- reveal_request_vrf program_identity: compared with the constant `IDENTITY_PDA`, failing with 2006, instead of a runtime find.
- delegate_vrf 4i: the buffer is closed by a direct lamport move plus `close()`, not by a system Transfer CPI. The end state is the same, as spec §2.4.i allows.
- delegate_vrf 4h: the Delegate CPI is built by hand (104 bytes). It is not the vendored `cpi_delegate`, which needs a 625-byte data buffer. `tests::delegate_data_matches_vendored` checks it byte for byte against the vendored `DelegateAccountArgs`.
- start_game_vrf 19: only the discriminator and non-zero VrfGame fields are written, because the data was freshly zeroed by create or Allocate (spec §1.19).
- D12: the host test compares the 33-byte constant with the vendored pinocchio `MagicIntentBundleBuilder` output. The sdk 0.15.5 crate is not a dev-dependency, so the 0.15.5 / magic-program-api 0.10.1 layout was checked by reading the source: variant index 11, `MagicIntentBundleArgs` field order, bincode-1 widths.
- Spec vs source: no disagreements found.

## F-fix deviations (2026-11-04, binding spec `FIXES.md`)

- F3: `VRF_VOID = 3`. New house-only ER instruction `force_undelegate_vrf` (disc `da30a3da54f8e465`, accounts `house WS, game W, magic_program, magic_context W, vault`): PLAYING with `pending == 0` (else 6044) becomes WON if `safe_reveals > 0`, else VOID; other statuses unchanged; then the same commit+undelegate CPI as `settle_and_undelegate_vrf` (shared `schedule_undelegate`). `refund_stalled_vrf` accepts PLAYING or VOID (Anchor: VOID gives 6050).
- F3 (round 2): `settle_and_undelegate_vrf` applies the same mapping first (`end_playing`, shared with the force): a PLAYING game with a pending reveal fails 6044, one with progress is committed WON, one without VOID. Anchor commits PLAYING as-is. So no game reaches L1 PLAYING with progress or pending, and a PLAYING game on L1 is always a never-delegated zero-progress one (house refund branch).
- F5: `settle_vrf` requires `remaining_accounts[0]` when `player_stats.referrer` is Some (missing: 6022).
- F6: `start_game_vrf` Pass B reuses a program-owned, VrfGame-disc'd game PDA after the claim `init` succeeds (seeds 2006, mut 2000, data zeroed, rent carried over) instead of `init` (Anchor: Allocate fails).
