//! `v2-lp` group: 7 handlers. Spec: `pinocchio/spec/v2-lp.md` (source lib.rs:1313-1613, 2568-2663).

use pinocchio::{AccountView, ProgramResult};

use crate::consts::*;
use crate::error::{AnchorError, KaboomError as K};
use crate::events::{self, emit};
use crate::helpers::*;
use crate::state::{
    lp_position as lp, rd_pk, rd_u128, rd_u16, rd_u64, vault as vt, vault_v2_state as v2, wr_bytes, wr_u128,
    wr_u16, wr_u64,
};

const OVF: K = K::MathOverflow;

/// `initialize_v2` -- spec section 1. Accounts: vault, v2_state(W, init), owner(WS), system_program.
#[inline(never)]
pub fn initialize_v2(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, v2s, owner, sys, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    // Pass A
    load(vault, &vt::TYPE)?;
    check_signer(owner)?;
    check_system_program(sys)?;
    // Pass B: init v2_state (canonical bump, payer = owner)
    let rent = rent()?;
    let bump = init_pda(owner, v2s, &[VAULT_V2_SEED], v2::SPACE, &rent)?;
    // Pass C: vault seeds -> raw owner constraint; owner mut
    check_vault_seeds(vault)?;
    require(rd_pk(&vault.try_borrow()?, vt::OWNER) == owner.address().as_array(), K::Unauthorized)?;
    check_mut(owner)?;
    // body
    let assets = vault_assets(vault, &rent)?;
    require(assets >= ANTI_INFLATION_SEED_LAMPORTS, K::InsufficientLiquidity)?;
    let seed = ANTI_INFLATION_SEED_LAMPORTS as u128;
    let house = (assets - ANTI_INFLATION_SEED_LAMPORTS) as u128;
    let total = assets as u128;
    {
        // Full image: account is freshly zeroed; vrf_* and _reserved stay 0 like Anchor.
        let mut d = v2s.try_borrow_mut()?;
        d[..8].copy_from_slice(&v2::DISC);
        d[v2::BUMP] = bump;
        wr_u64(&mut d, v2::TOTAL_OUTSTANDING_MAX_PAYOUT, 0);
        wr_u128(&mut d, v2::TOTAL_UNITS, total);
        wr_u128(&mut d, v2::HOUSE_UNITS, house);
        wr_u128(&mut d, v2::HOUSE_PENDING_UNITS, 0);
        wr_u64(&mut d, v2::HOUSE_PENDING_UNLOCK_SLOT, 0);
        wr_u128(&mut d, v2::SEED_UNITS, seed);
        wr_u128(&mut d, v2::TOTAL_PENDING_UNITS, 0);
        wr_u16(&mut d, v2::MIN_HOUSE_SHARE_BPS, DEFAULT_MIN_HOUSE_SHARE_BPS);
        wr_u16(&mut d, v2::MAX_USER_POSITION_BPS, DEFAULT_MAX_USER_POSITION_BPS);
        wr_u16(&mut d, v2::MIN_HEALTH_BPS, DEFAULT_MIN_HEALTH_BPS);
        wr_u64(&mut d, v2::WITHDRAW_COOLDOWN_SLOTS, DEFAULT_WITHDRAW_COOLDOWN_SLOTS);
        wr_u64(&mut d, v2::MIN_LP_DEPOSIT, DEFAULT_MIN_LP_DEPOSIT_LAMPORTS);
    }
    emit(&events::v2_initialized(vault.address().as_array(), seed, house, total, clock()?.slot));
    Ok(())
}

/// `update_v2_config` -- spec section 2. Accounts: vault, v2_state(W), owner(S).
#[inline(never)]
pub fn update_v2_config(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let mut a = Args::new(args);
    let min_house_share_bps = a.opt_u16()?;
    let max_user_position_bps = a.opt_u16()?;
    let min_health_bps = a.opt_u16()?;
    let withdraw_cooldown_slots = a.opt_u64()?;
    let min_lp_deposit = a.opt_u64()?;
    let vrf_mode_enabled = a.opt_bool()?;
    let vrf_validator = a.opt_pk()?;
    let vrf_max_payout_bps = a.opt_u16()?;

    let [vault, v2s, owner, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    // Pass A
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    check_signer(owner)?;
    // Pass C
    check_vault_seeds(vault)?;
    require(rd_pk(&vault.try_borrow()?, vt::OWNER) == owner.address().as_array(), K::Unauthorized)?;
    check_v2_seeds(v2s)?;
    check_mut(v2s)?;
    // body: source order (lib.rs:1362-1406), not arg order
    {
        let mut d = v2s.try_borrow_mut()?;
        if let Some(v) = vrf_mode_enabled {
            d[v2::VRF_MODE_ENABLED] = v as u8;
        }
        if let Some(v) = vrf_validator {
            wr_bytes(&mut d, v2::VRF_VALIDATOR, v);
        }
        if let Some(v) = vrf_max_payout_bps {
            require(v <= BPS as u16, K::InvalidConfig)?;
            wr_u16(&mut d, v2::VRF_MAX_PAYOUT_BPS, v);
        }
        if let Some(v) = min_house_share_bps {
            require(v <= BPS as u16, K::InvalidConfig)?;
            wr_u16(&mut d, v2::MIN_HOUSE_SHARE_BPS, v);
        }
        if let Some(v) = max_user_position_bps {
            require(v <= BPS as u16, K::InvalidConfig)?;
            wr_u16(&mut d, v2::MAX_USER_POSITION_BPS, v);
        }
        if let Some(v) = min_health_bps {
            require(v >= MIN_HEALTH_BPS_FLOOR && v <= BPS as u16, K::InvalidConfig)?;
            wr_u16(&mut d, v2::MIN_HEALTH_BPS, v);
        }
        if let Some(v) = withdraw_cooldown_slots {
            require(v >= MIN_WITHDRAW_COOLDOWN_SLOTS, K::InvalidConfig)?;
            wr_u64(&mut d, v2::WITHDRAW_COOLDOWN_SLOTS, v);
        }
        if let Some(v) = min_lp_deposit {
            wr_u64(&mut d, v2::MIN_LP_DEPOSIT, v);
        }
    }
    emit(&events::v2_config_updated(vault.address().as_array(), clock()?.slot));
    Ok(())
}

/// `lp_deposit` -- spec section 3 (hot path).
/// Accounts: vault(W), v2_state(W), position(W, init_if_needed), user(WS), system_program.
#[inline(never)]
pub fn lp_deposit(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let amount = Args::new(args).u64()?;
    let [vault, v2s, position, user, sys, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    // Pass A
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    check_signer(user)?;
    check_system_program(sys)?;
    // Pass B: init_if_needed position (canonical find, payer = user)
    let rent = rent()?;
    let (bump, _) =
        init_if_needed_pda(user, position, &[LP_SEED, user.address().as_array()], &lp::TYPE, lp::SPACE, &rent)?;
    // Pass C
    check_vault_v2_mut(vault, v2s)?;
    check_mut(user)?;
    // body
    let (v2_min, total_units_pre) = {
        let d = v2s.try_borrow()?;
        (rd_u64(&d, v2::MIN_LP_DEPOSIT), rd_u128(&d, v2::TOTAL_UNITS))
    };
    require(vault.try_borrow()?[vt::PAUSED] == 0, K::VaultPaused)?;
    require(amount >= v2_min, K::DepositBelowMin)?;
    let assets_pre = vault_assets(vault, &rent)?;
    let units_minted = deposit_to_units(amount, assets_pre, total_units_pre)?;
    require(units_minted > 0, OVF)?;

    transfer(user, vault, amount)?;

    let assets_after = assets_pre.saturating_add(amount);
    let clock = clock()?;
    let mut vd = v2s.try_borrow_mut()?;
    let total_units_after = total_units_pre.checked_add(units_minted).ok_or(OVF)?;
    wr_u128(&mut vd, v2::TOTAL_UNITS, total_units_after);

    let mut pd = position.try_borrow_mut()?;
    // Anchor's exit serializes `disc ++ struct`; this stamps the disc on a fresh account.
    pd[..8].copy_from_slice(&lp::DISC);
    let user_key = user.address().as_array();
    if rd_pk(&pd, lp::USER) == &[0u8; 32] {
        wr_bytes(&mut pd, lp::USER, user_key);
        pd[lp::BUMP] = bump;
        wr_u64(&mut pd, lp::CREATED_SLOT, clock.slot);
    }
    let units = rd_u128(&pd, lp::UNITS).checked_add(units_minted).ok_or(OVF)?;
    wr_u128(&mut pd, lp::UNITS, units);

    let user_after = user_units_total(&vd)?;
    enforce_house_floor(rd_u128(&vd, v2::HOUSE_UNITS), user_after, rd_u16(&vd, v2::MIN_HOUSE_SHARE_BPS))?;
    let position_units = units.checked_add(rd_u128(&pd, lp::PENDING_UNITS)).ok_or(OVF)?;
    let position_value = units_to_assets(position_units, assets_after, total_units_after)?;
    let h = calc_health_bps(&vd, assets_after)?;
    enforce_user_position_cap(position_value, assets_after, h, rd_u16(&vd, v2::MAX_USER_POSITION_BPS))?;
    // enforce_min_health recomputes the same h from the same inputs; reuse it.
    let min_h = rd_u16(&vd, v2::MIN_HEALTH_BPS);
    require(min_h == 0 || h >= min_h, K::HealthFloorBreached)?;

    emit(&events::lp_deposited(user_key, amount, units_minted, total_units_after, assets_after, clock.slot));
    Ok(())
}

/// `UserLpAction` account checks (lib.rs:2630-2648), Anchor order:
/// Pass A (vault, v2, position loads; user signer) then Pass C (vault seeds/mut, v2 seeds/mut,
/// position seeds(stored bump)/mut/user == user @ 6007, user mut).
/// `user_signs = false` only for `complete_withdraw` (F4): funds can only reach `position.user`.
#[inline(never)]
fn user_lp_checks(vault: &AccountView, v2s: &AccountView, position: &AccountView, user: &AccountView, user_signs: bool) -> ProgramResult {
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    load(position, &lp::TYPE)?;
    if user_signs {
        check_signer(user)?;
    }
    check_vault_v2_mut(vault, v2s)?;
    let key = user.address().as_array();
    let d = position.try_borrow()?;
    check_pda_bump(position, &[LP_SEED, key], d[lp::BUMP])?;
    check_mut(position)?;
    require(rd_pk(&d, lp::USER) == key, K::Unauthorized)?;
    check_mut(user)
}

/// `request_withdraw` -- spec section 4. Accounts: vault(W), v2_state(W), position(W), user(WS).
#[inline(never)]
pub fn request_withdraw(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let units = Args::new(args).u128()?;
    let [vault, v2s, position, user, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    user_lp_checks(vault, v2s, position, user, true)?;
    let mut pd = position.try_borrow_mut()?;
    let mut vd = v2s.try_borrow_mut()?;
    require(rd_u128(&pd, lp::PENDING_UNITS) == 0, K::PendingWithdrawAlreadyExists)?;
    require(units > 0, K::InvalidAmount)?;
    let pos_units = rd_u128(&pd, lp::UNITS);
    require(units <= pos_units, K::InsufficientUnits)?;
    wr_u128(&mut pd, lp::UNITS, pos_units.checked_sub(units).ok_or(OVF)?);
    wr_u128(&mut pd, lp::PENDING_UNITS, units);
    let slot = clock()?.slot;
    let unlock = slot.saturating_add(rd_u64(&vd, v2::WITHDRAW_COOLDOWN_SLOTS));
    wr_u64(&mut pd, lp::PENDING_UNLOCK_SLOT, unlock);
    let tp = rd_u128(&vd, v2::TOTAL_PENDING_UNITS).checked_add(units).ok_or(OVF)?;
    wr_u128(&mut vd, v2::TOTAL_PENDING_UNITS, tp);
    emit(&events::lp_withdraw_requested(user.address().as_array(), units, unlock, slot));
    Ok(())
}

/// `cancel_withdraw` -- spec section 5. Accounts: as `request_withdraw`.
#[inline(never)]
pub fn cancel_withdraw(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, v2s, position, user, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    user_lp_checks(vault, v2s, position, user, true)?;
    let mut pd = position.try_borrow_mut()?;
    let mut vd = v2s.try_borrow_mut()?;
    let units = rd_u128(&pd, lp::PENDING_UNITS);
    require(units > 0, K::NoPendingWithdraw)?;
    let pos_units = rd_u128(&pd, lp::UNITS).checked_add(units).ok_or(OVF)?;
    wr_u128(&mut pd, lp::UNITS, pos_units);
    wr_u128(&mut pd, lp::PENDING_UNITS, 0);
    wr_u64(&mut pd, lp::PENDING_UNLOCK_SLOT, 0);
    let tp = rd_u128(&vd, v2::TOTAL_PENDING_UNITS).checked_sub(units).ok_or(OVF)?;
    wr_u128(&mut vd, v2::TOTAL_PENDING_UNITS, tp);
    emit(&events::lp_withdraw_cancelled(user.address().as_array(), units, clock()?.slot));
    Ok(())
}

/// `complete_withdraw` -- spec section 6. Accounts: as `request_withdraw`; vault is debited.
#[inline(never)]
pub fn complete_withdraw(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, v2s, position, user, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    user_lp_checks(vault, v2s, position, user, false)?; // F4: crank-callable
    let (units, assets_pre, assets_out, total_after, slot) = {
        let mut pd = position.try_borrow_mut()?;
        let mut vd = v2s.try_borrow_mut()?;
        let units = rd_u128(&pd, lp::PENDING_UNITS);
        require(units > 0, K::NoPendingWithdraw)?;
        let now = clock()?.slot;
        let unlock = rd_u64(&pd, lp::PENDING_UNLOCK_SLOT);
        require(now >= unlock, K::CooldownNotElapsed)?;
        let assets_pre = vault_assets(vault, &rent()?)?;
        let total_units = rd_u128(&vd, v2::TOTAL_UNITS);
        let assets_out = units_to_assets(units, assets_pre, total_units)?;
        require(assets_out <= assets_pre, K::InsufficientLiquidity)?;
        wr_u128(&mut pd, lp::PENDING_UNITS, 0);
        wr_u64(&mut pd, lp::PENDING_UNLOCK_SLOT, 0);
        let tp = rd_u128(&vd, v2::TOTAL_PENDING_UNITS).checked_sub(units).ok_or(OVF)?;
        wr_u128(&mut vd, v2::TOTAL_PENDING_UNITS, tp);
        let total_after = total_units.checked_sub(units).ok_or(OVF)?;
        wr_u128(&mut vd, v2::TOTAL_UNITS, total_after);
        // F4 (MONEY-3): the matured option lasts WITHDRAW_CLAIM_WINDOW_SLOTS, not for ever. Checked last so
        // every Anchor error path (6036/6037/6008/6039) keeps its code; the failing tx reverts the writes.
        require(now <= unlock.saturating_add(WITHDRAW_CLAIM_WINDOW_SLOTS), K::WithdrawWindowExpired)?;
        (units, assets_pre, assets_out, total_after, now)
    };
    if assets_out > 0 {
        move_lamports(vault, user, assets_out)?;
    }
    let assets_after = assets_pre.saturating_sub(assets_out);
    emit(&events::lp_withdraw_completed(
        user.address().as_array(),
        units,
        assets_out,
        total_after,
        assets_after,
        slot,
    ));
    Ok(())
}

/// `close_lp_position` -- spec section 7. Accounts: position(W, close = user), user(WS).
#[inline(never)]
pub fn close_lp_position(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [position, user, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    // Pass A
    load(position, &lp::TYPE)?;
    check_signer(user)?;
    // Pass C: seeds(stored bump) -> mut -> raw @6007 -> close self-target; user mut
    let empty = {
        let key = user.address().as_array();
        let d = position.try_borrow()?;
        check_pda_bump(position, &[LP_SEED, key], d[lp::BUMP])?;
        check_mut(position)?;
        require(rd_pk(&d, lp::USER) == key, K::Unauthorized)?;
        rd_u128(&d, lp::UNITS) == 0 && rd_u128(&d, lp::PENDING_UNITS) == 0
    };
    check_close_target(position, user)?;
    check_mut(user)?;
    // body
    require(empty, K::LpPositionNotEmpty)?;
    emit(&events::lp_position_closed(user.address().as_array(), clock()?.slot));
    // exit
    close_to(position, user)
}
