# legacy-game implementation checklist

File: `pinocchio/kaboom-p/src/ix/legacy_game.rs` (L = line).

## Dispatch (all 7)

| spec step | where |
|---|---|
| `Instruction: <PascalName>` log before args/accounts | `src/ix/mod.rs:56-62` route names, logged by `src/lib.rs` `process_instruction` |
| discriminators | `src/ix/mod.rs:56-62` |
| trailing arg bytes ignored, short data / bad bool -> 102 | `helpers::Args` |
| fewer accounts -> 3005 | L82-84, L181-183, L241-243, L279-281, L473-475, L502-504, L532-534 |

## Private helpers

| helper | L |
|---|---|
| `check_game_seeds_mut` game seeds + stored bump (2006), mut (2000) | 21-27 |
| `check_game_owned` + `game.player == player` (6007) | 31-35 |
| `check_vault_v2_game_player` CashOut / RefundExpired Pass A + C | 39-50 |
| `win_payout` u128 bet*mult/BPS, try_from (6008) | 54-61 |
| `release_outstanding` saturating_sub of total_outstanding_max_payout | 65-70 |
| `settle_referral` settle_game step 12 | 429-465 |

## 1. start_game

| spec step | L |
|---|---|
| args mine_count u8, bet u64, commitment [32] | 78-81 |
| Pass A vault, v2, player signer, system program | 86-89 |
| Pass B init game (find 2006, create / pre-funded path, mut, rent 2005) | 93 |
| Pass B init_if_needed player_stats (2019/2004/2005/3002) | 94 |
| Pass C vault seeds+mut, v2 seeds+mut, player mut | 96-100 |
| 1 paused -> 6012 | 105 |
| 2 mine_count 1..=15 -> 6000 | 108 |
| 3 bet >= MIN -> 6004 | 109 |
| 4 commitment != 0 -> 6011 | 110 |
| 5 available = vault.lamports - rent(428), pre-transfer | 112 |
| 6 pre_health | 113 |
| 7 effective bps checked_mul / BPS | 114-115 |
| 8 max_bet, bet <= max_bet -> 6005 | 116-117 |
| 9 worst_case_payout | 118 |
| 10 max_payout, worst <= max_payout -> 6006 | 119-120 |
| 11 system transfer player -> vault | 122 |
| 12 clock | 123 |
| 13 stats first-time player/bump/version (+ disc) | 125-133 |
| 14 game full image | 134-154 |
| 15 vault total_games / total_wagered saturating | 155-161 |
| 16 v2 outstanding checked_add -> 6008 | 163-165 |
| 17 enforce_min_health(available + bet) -> 6034 | 166 |
| 18 emit GameStarted | 168 |

## 2. reveal_tile

| spec step | L |
|---|---|
| args tile_index u8, is_mine bool (102) | 178-180 |
| Pass A vault, game, house signer | 185-187 |
| Pass C vault seeds (no mut), game seeds+mut, house == vault.house_authority -> 6007 | 189-195 |
| 1 tile < 16 -> 6001 | 198 |
| 2 status Playing -> 6003 | 202 |
| 3 slot <= start + 300 -> 6013 | 200, 203 |
| 4 tile bit, already revealed -> 6002 | 204-206 |
| 5 revealed_mask |= bit | 207 |
| 6 mine: Lost, TileRevealed, GameLost | 210-216 |
| 7 safe: safe mask, safe_reveals, multiplier, Won on full board, TileRevealed | 217-231 |

## 3. cash_out

| spec step | L |
|---|---|
| Pass A + C (vault, v2, game seeds/mut/6007, player) | 244 |
| 1 status Playing -> 6003 | 250 |
| 2 safe_reveals > 0 -> 6019 | 251 |
| 3 payout (6008) | 254 |
| 4 available, payout <= available -> 6006 | 255-257 |
| 5 direct lamports vault -> player (6008) | 258 |
| 6 status Won | 259 |
| 7 vault.total_payouts saturating | 260-264 |
| 8 v2 untouched | n/a |
| 9 emit GameWon | 265-266 |

## 4. settle_game

| spec step | L |
|---|---|
| args mine_layout u16, salt [32] | 276-278 |
| Pass A vault, v2, game, stats, house signer | 283-287 |
| Pass C vault, v2, game seeds+mut | 289-293 |
| Pass C stats canonical find (2006) + mut | 294-296 |
| Pass C house == vault.house_authority -> 6007, treasury mut, treasury == vault.treasury -> 6007 | 297-303 |
| 1 status Won/Lost -> 6003 | 312 |
| 2 !settled -> 6017 | 313 |
| 3 sha256(layout_le, mine_count, salt) == commitment -> 6015 | 315-316 |
| 4 popcount == mine_count -> 6015 | 317 |
| 5 safe mask & layout == 0 -> 6016 | 320 |
| 6 revealed mine mask subset of layout -> 6016 | 321-322 |
| 7 Lost needs a revealed mine -> 6016 | 323-325 |
| 8 mine_layout, salt, settled | 326-328 |
| 9 release outstanding before referral/treasury | 338 |
| 10 stats first-time, games_played, total_wagered, last_played | 342-351 |
| 11 payout and win/loss stats | 352-372 |
| 12 referral only if Some(referrer) and remaining[0] | 373, 386-388 |
| 12a PDA check -> 6022 before load | 438-439 |
| 12b load (3012/3007/3001/3002/3003), referrer -> 6022 | 440-445 |
| 12c cut by tier | 446 |
| 12d cap at vault available | 447 |
| 12e direct lamports vault -> referral (6008) | 448-450 |
| 12f accrued / earned / volume saturating | 451-457 |
| 12g tier change + ReferralTierChanged | 458-462 |
| 12h persist referral account | 451-460 |
| 12i emit ReferralAccrued (also for 0) | 463 |
| 13 treasury split, liquidity, direct lamports, TreasuryAccrued | 390-412 |
| 14 emit GameSettled verified=true | 414 |
| 15 VaultUnitValueUpdated | 416-421 |
| 16 StatsUpdated | 422 |

## 5. refund_expired

| spec step | L |
|---|---|
| Pass A + C | 476 |
| 1 status Playing -> 6003 | 483 |
| 2 slot > start + 300 -> 6014 | 480, 484 |
| 3 refund = min(bet, available) | 487-488 |
| 4 direct lamports vault -> player (also 0) | 489 |
| 5 status Expired | 490 |
| 6 release outstanding | 491 |
| 7 emit GameRefunded | 492 |

## 6. close_game

| spec step | L |
|---|---|
| Pass A game, player signer | 506-507 |
| Pass C game seeds, mut, 6007, close target 2011, player mut | 509-511 |
| 1 Expired or settled Won/Lost -> 6018 | 514-521 |
| 2 close to player | 523 |

## 7. close_unsettled_game

| spec step | L |
|---|---|
| Pass A v2, game, player signer | 536-538 |
| Pass C v2 seeds+mut, game seeds/mut/6007/2011, player mut | 540-544 |
| 1 Won/Lost -> 6018 | 551 |
| 2 !settled -> 6017 | 552 |
| 3 slot > start + 38 -> 6014 | 547, 553-556 |
| 4 release outstanding | 559 |
| 5 close to player after v2 write | 561 |

## Deviations

| item | detail |
|---|---|
| sysvar fetch position | Clock and Rent read once per handler, sometimes earlier than Anchor's call site; no observable difference |
| game `_reserved` [24] | not rewritten; data is zero after the init CPI, Anchor writes the same zeros |
| stats discriminator | written on every start_game; identical bytes when the account already existed |
| vault / v2 seeds | constant PDA + canonical bump compare (D2) instead of create_program_address |
| referral find_pda | returns 2006 when no bump exists where Anchor would panic; both fail |
| spec vs source | no disagreement found |

## F-fix deviations (2026-11-04, binding spec `FIXES.md`)

- F2: new permissionless `expire_game` (disc `d0155783f22bfc90`, no args, accounts `vault W, v2_state W, game W, player W` not signer). Checks as `refund_expired` minus the signer. Playing (6003) and `slot > start_slot + 300` (6014); refund branch if `safe_reveals == 0 || multiplier_bps < 10_000` (full bet only, 6006 otherwise; Expired; reservation released; `GameRefunded`), else cash branch (`bet*mult/BPS`, 6006 if short; Won; `total_payouts +=`; `GameWon`; release left to `settle_game`). The four existing instructions are unchanged.
- F5: `settle_game` keeps the referral account optional (house-gated; see FIXES.md section 6).
