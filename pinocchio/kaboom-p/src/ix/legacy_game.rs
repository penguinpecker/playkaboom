//! `legacy-game` group: 7 handlers + `expire_game` (F2). Spec: `pinocchio/spec/legacy-game.md`.
//! Read `PORT_NOTES.md` before filling these in.

use pinocchio::{sysvars::rent::Rent, AccountView, ProgramResult};

use crate::consts::*;
use crate::error::{AnchorError, KaboomError as K};
use crate::events::{self, emit};
use crate::helpers::*;
use crate::state::{
    game_session as gs, player_stats as ps, rd_pk, rd_u128, rd_u16, rd_u32, rd_u64, referral_account as ra,
    vault as vt, vault_v2_state as v2, wr_bytes, wr_i64, wr_u16, wr_u32, wr_u64,
};

const NOT_ENOUGH_KEYS: AnchorError = AnchorError::AccountNotEnoughKeys;

// ─── private account-check helpers (Pass C pieces shared by several handlers) ───

/// game: `seeds = [GAME_SEED, game.player], bump = game.bump` (2006) -> `mut` (2000).
#[inline(never)]
fn check_game_seeds_mut(game: &AccountView) -> ProgramResult {
    {
        let d = game.try_borrow()?;
        check_pda_bump(game, &[GAME_SEED, rd_pk(&d, gs::PLAYER)], d[gs::BUMP])?;
    }
    check_mut(game)
}

/// game seeds + mut, then `constraint = game.player == player.key() @ Unauthorized` (6007).
#[inline(never)]
fn check_game_owned(game: &AccountView, player: &AccountView) -> ProgramResult {
    check_game_seeds_mut(game)?;
    let d = game.try_borrow()?;
    require(rd_pk(&d, gs::PLAYER) == player.address().as_array(), K::Unauthorized)
}

/// CashOut / RefundExpired accounts (identical structs): Pass A then Pass C.
#[inline(never)]
fn check_vault_v2_game_player(vault: &AccountView, v2s: &AccountView, game: &AccountView, player: &AccountView) -> ProgramResult {
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    load(game, &gs::TYPE)?;
    check_signer(player)?;
    check_vault_v2_mut(vault, v2s)?;
    check_game_owned(game, player)?;
    check_mut(player)
}

/// `start_game` -- VRF-only upgrade (error 6057 `LegacyModeDisabled`): the legacy commit-reveal start is
/// disabled. The player supplied the commitment, so a leaked house key could drain the vault. It fails
/// before reading any account or arg; the dispatcher has already logged `Instruction: StartGame`.
/// Every other legacy instruction is unchanged so games that already exist can still wind down.
#[inline(never)]
pub fn start_game(_accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    Err(K::LegacyModeDisabled.into())
}

/// `reveal_tile` -- spec `legacy-game.md` section 2.
///
/// Accounts (IDL order): vault, game(W), house_authority(S)
/// Args (`args` = ix data after the 8-byte disc): tile_index: u8, is_mine: bool
#[inline(never)]
pub fn reveal_tile(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let mut a = Args::new(args);
    let tile_index = a.u8()?;
    let is_mine = a.bool()?;
    let [vault, game, house, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    load(vault, &vt::TYPE)?;
    load(game, &gs::TYPE)?;
    check_signer(house)?;
    // Pass C (vault is not mut)
    check_vault_seeds(vault)?;
    check_game_seeds_mut(game)?;
    let edge = {
        let d = vault.try_borrow()?;
        require(house.address().as_array() == rd_pk(&d, vt::HOUSE_AUTHORITY), K::Unauthorized)?;
        rd_u16(&d, vt::HOUSE_EDGE_BPS)
    };

    // Handler (lib.rs:375-442)
    require(tile_index < GRID_SIZE, K::InvalidTileIndex)?;
    let gk = *game.address().as_array();
    let clock = clock()?;
    let mut d = game.try_borrow_mut()?;
    require(d[gs::STATUS] == STATUS_PLAYING, K::GameNotPlaying)?;
    require(clock.slot <= rd_u64(&d, gs::START_SLOT).saturating_add(GAME_EXPIRY_SLOTS), K::GameExpired)?;
    let tile_bit: u16 = 1u16 << tile_index;
    let mask = rd_u16(&d, gs::REVEALED_MASK);
    require(mask & tile_bit == 0, K::TileAlreadyRevealed)?;
    wr_u16(&mut d, gs::REVEALED_MASK, mask | tile_bit);
    let gp = *rd_pk(&d, gs::PLAYER);

    if is_mine {
        d[gs::STATUS] = STATUS_LOST;
        let mult = rd_u64(&d, gs::MULTIPLIER_BPS);
        let safe = d[gs::SAFE_REVEALS];
        let bet = rd_u64(&d, gs::BET);
        emit(&events::tile_revealed(&gp, &gk, tile_index, true, mult, safe, clock.slot));
        emit(&events::game_lost(&gp, &gk, bet, tile_index, safe, clock.slot));
    } else {
        let smask = rd_u16(&d, gs::REVEALED_SAFE_MASK) | tile_bit;
        wr_u16(&mut d, gs::REVEALED_SAFE_MASK, smask);
        let safe = d[gs::SAFE_REVEALS].saturating_add(1);
        d[gs::SAFE_REVEALS] = safe;
        let mine_count = d[gs::MINE_COUNT];
        let mult = calc_multiplier(safe, mine_count, edge)?;
        wr_u64(&mut d, gs::MULTIPLIER_BPS, mult);
        let total_safe = GRID_SIZE - mine_count;
        if safe >= total_safe {
            // Parity quirk (D11): full board = Won with no payout.
            d[gs::STATUS] = STATUS_WON;
        }
        emit(&events::tile_revealed(&gp, &gk, tile_index, false, mult, safe, clock.slot));
    }
    Ok(())
}

/// `cash_out` -- spec `legacy-game.md` section 3.
///
/// Accounts (IDL order): vault(W), v2_state(W), game(W), player(WS)
/// Args (`args` = ix data after the 8-byte disc): none
#[inline(never)]
pub fn cash_out(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, v2s, game, player, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    check_vault_v2_game_player(vault, v2s, game, player)?;

    // Handler (lib.rs:445-499). No expiry check (parity, D11).
    let gk = *game.address().as_array();
    let (gp, bet, mult, safe) = {
        let d = game.try_borrow()?;
        require(d[gs::STATUS] == STATUS_PLAYING, K::GameNotPlaying)?;
        require(d[gs::SAFE_REVEALS] > 0, K::NoTilesRevealed)?;
        (*rd_pk(&d, gs::PLAYER), rd_u64(&d, gs::BET), rd_u64(&d, gs::MULTIPLIER_BPS), d[gs::SAFE_REVEALS])
    };
    let payout = mul_div_floor(bet, mult, BPS)?;
    let rent = rent()?;
    let available = vault_assets(vault, &rent)?;
    require(payout <= available, K::VaultInsufficientFunds)?;
    move_lamports(vault, player, payout)?;
    game.try_borrow_mut()?[gs::STATUS] = STATUS_WON;
    {
        let mut d = vault.try_borrow_mut()?;
        let tp = rd_u64(&d, vt::TOTAL_PAYOUTS).saturating_add(payout);
        wr_u64(&mut d, vt::TOTAL_PAYOUTS, tp);
    }
    let clock = clock()?;
    emit(&events::game_won(&gp, &gk, bet, payout, mult, safe, clock.slot));
    Ok(())
}

/// `settle_game` -- spec `legacy-game.md` section 4.
///
/// Accounts (IDL order): vault(W), v2_state(W), game(W), player_stats(W), house_authority(S), treasury(W)
/// Args (`args` = ix data after the 8-byte disc): mine_layout: u16, salt: [u8; 32]
#[inline(never)]
pub fn settle_game(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let mut a = Args::new(args);
    let mine_layout = a.u16()?;
    let salt = *a.pk()?;
    let [vault, v2s, game, stats, house, treasury, rem @ ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    load(game, &gs::TYPE)?;
    load(stats, &ps::TYPE)?;
    check_signer(house)?;
    // Pass C
    check_vault_v2_mut(vault, v2s)?;
    check_game_seeds_mut(game)?;
    let gp = *rd_pk(&game.try_borrow()?, gs::PLAYER);
    let stats_bump = check_pda_find(stats, &[STATS_SEED, &gp])?;
    check_mut(stats)?;
    let (edge, split) = {
        let d = vault.try_borrow()?;
        require(house.address().as_array() == rd_pk(&d, vt::HOUSE_AUTHORITY), K::Unauthorized)?;
        check_mut(treasury)?;
        require(treasury.address().as_array() == rd_pk(&d, vt::TREASURY), K::Unauthorized)?;
        (rd_u16(&d, vt::HOUSE_EDGE_BPS), rd_u16(&d, vt::TREASURY_SPLIT_BPS))
    };

    // Handler (lib.rs:510-797)
    let rent = rent()?;
    let clock = clock()?;
    let gk = *game.address().as_array();
    let (won, bet, mult, mine_count, commitment, max_payout) = {
        let mut d = game.try_borrow_mut()?;
        let status = d[gs::STATUS];
        require(status == STATUS_WON || status == STATUS_LOST, K::GameNotPlaying)?;
        require(d[gs::SETTLED] == 0, K::GameAlreadySettled)?;
        let mine_count = d[gs::MINE_COUNT];
        let computed = sha256(&[&mine_layout.to_le_bytes()[..], &[mine_count][..], &salt[..]]);
        require(&computed == rd_pk(&d, gs::COMMITMENT), K::CommitmentMismatch)?;
        require(mine_layout.count_ones() as u8 == mine_count, K::CommitmentMismatch)?;
        let rmask = rd_u16(&d, gs::REVEALED_MASK);
        let smask = rd_u16(&d, gs::REVEALED_SAFE_MASK);
        require(smask & mine_layout == 0, K::RevealMismatch)?;
        let revealed_mine_mask = rmask & !smask;
        require(revealed_mine_mask & mine_layout == revealed_mine_mask, K::RevealMismatch)?;
        if status == STATUS_LOST {
            require(revealed_mine_mask != 0, K::RevealMismatch)?;
        }
        wr_u16(&mut d, gs::MINE_LAYOUT, mine_layout);
        wr_bytes(&mut d, gs::SALT, &salt);
        d[gs::SETTLED] = 1;
        (
            status == STATUS_WON,
            rd_u64(&d, gs::BET),
            rd_u64(&d, gs::MULTIPLIER_BPS),
            mine_count,
            *rd_pk(&d, gs::COMMITMENT),
            rd_u64(&d, gs::MAX_PAYOUT),
        )
    };
    release_outstanding(v2s, max_payout)?;

    let (sp, played, games_won, wagered, payouts, biggest_win, streak, referrer) = {
        let mut d = stats.try_borrow_mut()?;
        if rd_pk(&d, ps::PLAYER) == &[0u8; 32] {
            wr_bytes(&mut d, ps::PLAYER, &gp);
            d[ps::BUMP] = stats_bump;
            d[ps::VERSION] = 1;
        }
        let played = rd_u64(&d, ps::GAMES_PLAYED).saturating_add(1);
        wr_u64(&mut d, ps::GAMES_PLAYED, played);
        let wagered = rd_u64(&d, ps::TOTAL_WAGERED).saturating_add(bet);
        wr_u64(&mut d, ps::TOTAL_WAGERED, wagered);
        wr_i64(&mut d, ps::LAST_PLAYED, clock.unix_timestamp);
        let payout = if won { mul_div_floor(bet, mult, BPS)? } else { 0 };
        if won {
            let gw = rd_u64(&d, ps::GAMES_WON).saturating_add(1);
            wr_u64(&mut d, ps::GAMES_WON, gw);
            let tp = rd_u64(&d, ps::TOTAL_PAYOUTS).saturating_add(payout);
            wr_u64(&mut d, ps::TOTAL_PAYOUTS, tp);
            let net_win = payout.saturating_sub(bet);
            if net_win > rd_u64(&d, ps::BIGGEST_WIN) {
                wr_u64(&mut d, ps::BIGGEST_WIN, net_win);
            }
            if mult > rd_u64(&d, ps::BIGGEST_MULTIPLIER_BPS) {
                wr_u64(&mut d, ps::BIGGEST_MULTIPLIER_BPS, mult);
            }
            let cs = rd_u32(&d, ps::CURRENT_STREAK).saturating_add(1);
            wr_u32(&mut d, ps::CURRENT_STREAK, cs);
            if cs > rd_u32(&d, ps::BEST_STREAK) {
                wr_u32(&mut d, ps::BEST_STREAK, cs);
            }
        } else {
            wr_u32(&mut d, ps::CURRENT_STREAK, 0);
        }
        let referrer = if d[ps::REFERRER_TAG] == 1 { Some(*rd_pk(&d, ps::REFERRER)) } else { None };
        (
            *rd_pk(&d, ps::PLAYER),
            played,
            rd_u64(&d, ps::GAMES_WON),
            wagered,
            rd_u64(&d, ps::TOTAL_PAYOUTS),
            rd_u64(&d, ps::BIGGEST_WIN),
            rd_u32(&d, ps::CURRENT_STREAK),
            referrer,
        )
    };

    if let (Some(rk), Some(ra_acc)) = (referrer, rem.first_mut()) {
        settle_referral(vault, ra_acc, &rk, &gp, bet, &rent, clock.slot)?;
    }

    if split > 0 {
        let edge_share = mul_div_floor(bet, edge as u64, BPS)?;
        let treasury_cut = mul_div_floor(edge_share, split as u64, BPS)?;
        let assets_now = vault_assets(vault, &rent)?;
        let liquidity = {
            let d = v2s.try_borrow()?;
            let pending =
                units_to_assets(rd_u128(&d, v2::TOTAL_PENDING_UNITS), assets_now, rd_u128(&d, v2::TOTAL_UNITS))?;
            assets_now.saturating_sub(rd_u64(&d, v2::TOTAL_OUTSTANDING_MAX_PAYOUT)).saturating_sub(pending)
        };
        let actual = treasury_cut.min(liquidity);
        if actual > 0 {
            move_lamports(vault, treasury, actual)?;
            emit(&events::treasury_accrued(
                vault.address().as_array(),
                treasury.address().as_array(),
                &gk,
                bet,
                actual,
                clock.slot,
            ));
        }
    }

    emit(&events::game_settled(&gp, &gk, mine_count, mine_layout, &salt, &commitment, true, clock.slot));

    let assets_now = vault_assets(vault, &rent)?;
    let (h, total_units) = {
        let d = v2s.try_borrow()?;
        (calc_health_bps(&d, assets_now)?, rd_u128(&d, v2::TOTAL_UNITS))
    };
    emit(&events::vault_unit_value_updated(vault.address().as_array(), assets_now, total_units, h, clock.slot));
    emit(&events::stats_updated(&sp, played, games_won, wagered, payouts, biggest_win, streak, clock.slot));
    Ok(())
}

/// settle_game referral branch (lib.rs:614-680): PDA (6022) before load, then load, referrer (6022),
/// capped cut, saturating counters, tier change, ReferralAccrued (emitted even for a 0 cut).
#[inline(never)]
fn settle_referral(
    vault: &mut AccountView,
    ra_acc: &mut AccountView,
    rk: &[u8; 32],
    gp: &[u8; 32],
    bet: u64,
    rent: &Rent,
    slot: u64,
) -> ProgramResult {
    let (expected, _) = find_pda(&[REFERRAL_SEED, rk])?;
    require(ra_acc.address() == &expected, K::ReferralMismatch)?;
    load(ra_acc, &ra::TYPE)?;
    let tier = {
        let d = ra_acc.try_borrow()?;
        require(rd_pk(&d, ra::REFERRER) == rk, K::ReferralMismatch)?;
        d[ra::TIER]
    };
    let cut = mul_div_floor(bet, referral_cut_bps(tier) as u64, BPS)?;
    let actual_cut = cut.min(vault_assets(vault, rent)?);
    if actual_cut > 0 {
        move_lamports(vault, ra_acc, actual_cut)?;
    }
    let mut d = ra_acc.try_borrow_mut()?;
    let accrued = rd_u64(&d, ra::ACCRUED_LAMPORTS).saturating_add(actual_cut);
    wr_u64(&mut d, ra::ACCRUED_LAMPORTS, accrued);
    let earned = rd_u64(&d, ra::TOTAL_EARNED).saturating_add(actual_cut);
    wr_u64(&mut d, ra::TOTAL_EARNED, earned);
    let volume = rd_u64(&d, ra::REFERRED_VOLUME).saturating_add(bet);
    wr_u64(&mut d, ra::REFERRED_VOLUME, volume);
    let new_tier = tier_for_volume(volume);
    if new_tier != tier {
        d[ra::TIER] = new_tier;
        emit(&events::referral_tier_changed(rk, new_tier, slot));
    }
    emit(&events::referral_accrued(rk, gp, actual_cut, d[ra::TIER], slot));
    Ok(())
}

/// `refund_expired` -- spec `legacy-game.md` section 5.
///
/// Accounts (IDL order): vault(W), v2_state(W), game(W), player(WS)
/// Args (`args` = ix data after the 8-byte disc): none
#[inline(never)]
pub fn refund_expired(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, v2s, game, player, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    check_vault_v2_game_player(vault, v2s, game, player)?;

    // Handler (lib.rs:862-906)
    let gk = *game.address().as_array();
    let clock = clock()?;
    let (gp, bet, max_payout) = {
        let d = game.try_borrow()?;
        require(d[gs::STATUS] == STATUS_PLAYING, K::GameNotPlaying)?;
        require(clock.slot > rd_u64(&d, gs::START_SLOT).saturating_add(GAME_EXPIRY_SLOTS), K::GameNotExpired)?;
        (*rd_pk(&d, gs::PLAYER), rd_u64(&d, gs::BET), rd_u64(&d, gs::MAX_PAYOUT))
    };
    let rent = rent()?;
    let refund = bet.min(vault_assets(vault, &rent)?);
    move_lamports(vault, player, refund)?;
    game.try_borrow_mut()?[gs::STATUS] = STATUS_EXPIRED;
    release_outstanding(v2s, max_payout)?;
    emit(&events::game_refunded(&gp, &gk, bet, refund, clock.slot));
    Ok(())
}

/// `close_game` -- spec `legacy-game.md` section 6.
///
/// Accounts (IDL order): game(W), player(WS)
/// Args (`args` = ix data after the 8-byte disc): none
#[inline(never)]
pub fn close_game(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [game, player, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    load(game, &gs::TYPE)?;
    check_signer(player)?;
    // Pass C
    check_game_owned(game, player)?;
    check_close_target(game, player)?;
    check_mut(player)?;

    // Handler (lib.rs:908-917)
    {
        let d = game.try_borrow()?;
        let s = d[gs::STATUS];
        require(
            s == STATUS_EXPIRED || (d[gs::SETTLED] == 1 && (s == STATUS_WON || s == STATUS_LOST)),
            K::GameNotFinished,
        )?;
    }
    // Exit: close = player
    close_to(game, player)
}

/// `close_unsettled_game` -- spec `legacy-game.md` section 7.
///
/// Accounts (IDL order): v2_state(W), game(W), player(WS)
/// Args (`args` = ix data after the 8-byte disc): none
#[inline(never)]
pub fn close_unsettled_game(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [v2s, game, player, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    load(v2s, &v2::TYPE)?;
    load(game, &gs::TYPE)?;
    check_signer(player)?;
    // Pass C
    check_v2_seeds(v2s)?;
    check_mut(v2s)?;
    check_game_owned(game, player)?;
    check_close_target(game, player)?;
    check_mut(player)?;

    // Handler (lib.rs:929-946)
    let clock = clock()?;
    let max_payout = {
        let d = game.try_borrow()?;
        let s = d[gs::STATUS];
        require(s == STATUS_WON || s == STATUS_LOST, K::GameNotFinished)?;
        require(d[gs::SETTLED] == 0, K::GameAlreadySettled)?;
        require(
            clock.slot > rd_u64(&d, gs::START_SLOT).saturating_add(CLOSE_UNSETTLED_EXPIRY_SLOTS),
            K::GameNotExpired,
        )?;
        rd_u64(&d, gs::MAX_PAYOUT)
    };
    release_outstanding(v2s, max_payout)?;
    // Exit: v2_state (written above), then close = player
    close_to(game, player)
}

/// `expire_game` (F2 fix, MONEY-1; not in Anchor). Permissionless exit for an EXPIRED Playing game: pays
/// the player exactly what the better of their own two exits would (refund_expired or cash_out).
///
/// Accounts: vault(W), v2_state(W), game(W), player(W, not signer)
/// Args: none
#[inline(never)]
pub fn expire_game(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, v2s, game, player, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    load(game, &gs::TYPE)?;
    check_vault_v2_mut(vault, v2s)?;
    check_game_owned(game, player)?;
    check_mut(player)?;

    let gk = *game.address().as_array();
    let clock = clock()?;
    let (gp, bet, mult, safe, max_payout) = {
        let d = game.try_borrow()?;
        require(d[gs::STATUS] == STATUS_PLAYING, K::GameNotPlaying)?;
        require(clock.slot > rd_u64(&d, gs::START_SLOT).saturating_add(GAME_EXPIRY_SLOTS), K::GameNotExpired)?;
        (*rd_pk(&d, gs::PLAYER), rd_u64(&d, gs::BET), rd_u64(&d, gs::MULTIPLIER_BPS), d[gs::SAFE_REVEALS], rd_u64(&d, gs::MAX_PAYOUT))
    };
    let available = vault_assets(vault, &rent()?)?;
    if safe == 0 || mult < BPS {
        // refund_expired branch; unlike refund_expired it never pays a partial refund.
        require(bet <= available, K::VaultInsufficientFunds)?;
        move_lamports(vault, player, bet)?;
        game.try_borrow_mut()?[gs::STATUS] = STATUS_EXPIRED;
        release_outstanding(v2s, max_payout)?;
        emit(&events::game_refunded(&gp, &gk, bet, bet, clock.slot));
    } else {
        // cash_out branch (ties land here). The reservation is released by settle_game, not here.
        let payout = mul_div_floor(bet, mult, BPS)?;
        require(payout <= available, K::VaultInsufficientFunds)?;
        move_lamports(vault, player, payout)?;
        game.try_borrow_mut()?[gs::STATUS] = STATUS_WON;
        {
            let mut d = vault.try_borrow_mut()?;
            let tp = rd_u64(&d, vt::TOTAL_PAYOUTS).saturating_add(payout);
            wr_u64(&mut d, vt::TOTAL_PAYOUTS, tp);
        }
        emit(&events::game_won(&gp, &gk, bet, payout, mult, safe, clock.slot));
    }
    Ok(())
}
