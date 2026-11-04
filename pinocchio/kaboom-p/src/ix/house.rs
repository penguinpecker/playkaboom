//! `house` group: 4 handlers. Spec: `pinocchio/spec/house.md`.

use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::error::{AnchorError, KaboomError as K};
use crate::events::{self, emit};
use crate::helpers::*;
use crate::state::{rd_pk, rd_u128, rd_u16, rd_u64, vault as vt, vault_v2_state as v2, wr_u128, wr_u64};

/// Account `i`, or 3005 (Anchor checks `accounts.is_empty()` lazily, per field, in declaration order).
#[inline(always)]
fn nth(accounts: &[AccountView], i: usize) -> Result<&AccountView, ProgramError> {
    accounts.get(i).ok_or(AnchorError::AccountNotEnoughKeys.into())
}

/// `HouseDepositCtx` (with `system_program`) / `HouseLpAction` (without), spec house.md §1 / §2.
/// Pass A: vault, v2_state, owner, [system_program]. Pass C: vault seeds -> mut -> owner constraint,
/// v2_state seeds -> mut, owner mut.
#[inline(never)]
fn check_house_ctx(accounts: &[AccountView], with_system: bool) -> ProgramResult {
    let vault = nth(accounts, 0)?;
    load(vault, &vt::TYPE)?;
    let v2s = nth(accounts, 1)?;
    load(v2s, &v2::TYPE)?;
    let owner = nth(accounts, 2)?;
    check_signer(owner)?;
    if with_system {
        check_system_program(nth(accounts, 3)?)?;
    }
    check_vault_seeds(vault)?;
    check_mut(vault)?;
    require(rd_pk(&vault.try_borrow()?, vt::OWNER) == owner.address().as_array(), K::Unauthorized)?;
    check_v2_seeds(v2s)?;
    check_mut(v2s)?;
    check_mut(owner)
}

/// `house_deposit` -- spec `house.md` section 1 (lib.rs:1617-1652).
///
/// Accounts (IDL order): vault(W), v2_state(W), owner(WS), system_program
/// Args (`args` = ix data after the 8-byte disc): amount: u64
#[inline(never)]
pub fn house_deposit(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let amount = Args::new(args).u64()?;
    check_house_ctx(accounts, true)?;
    let [vault, v2s, owner, ..] = accounts else { return Err(AnchorError::AccountNotEnoughKeys.into()) };

    require(amount > 0, K::InvalidAmount)?;
    let assets_pre = vault_assets(vault, &rent()?)?;
    let total_units_pre = rd_u128(&v2s.try_borrow()?, v2::TOTAL_UNITS);
    let units_minted = deposit_to_units(amount, assets_pre, total_units_pre)?;
    require(units_minted > 0, K::MathOverflow)?;

    transfer(owner, vault, amount)?;

    let mut d = v2s.try_borrow_mut()?;
    let total_after = total_units_pre.checked_add(units_minted).ok_or(K::MathOverflow)?;
    wr_u128(&mut d, v2::TOTAL_UNITS, total_after);
    let house_after = rd_u128(&d, v2::HOUSE_UNITS).checked_add(units_minted).ok_or(K::MathOverflow)?;
    wr_u128(&mut d, v2::HOUSE_UNITS, house_after);

    emit(&events::house_deposited(amount, units_minted, total_after, clock()?.slot));
    Ok(())
}

/// `house_request_withdraw` -- spec `house.md` section 2 (lib.rs:1654-1677).
///
/// Accounts (IDL order): vault(W), v2_state(W), owner(WS)
/// Args (`args` = ix data after the 8-byte disc): units: u128
#[inline(never)]
pub fn house_request_withdraw(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let units = Args::new(args).u128()?;
    check_house_ctx(accounts, false)?;
    let v2s = &mut accounts[1];

    let mut d = v2s.try_borrow_mut()?;
    require(rd_u128(&d, v2::HOUSE_PENDING_UNITS) == 0, K::PendingWithdrawAlreadyExists)?;
    require(units > 0, K::InvalidAmount)?;
    let house_units = rd_u128(&d, v2::HOUSE_UNITS);
    require(units <= house_units, K::InsufficientUnits)?;

    let house_after = house_units.checked_sub(units).ok_or(K::MathOverflow)?;
    let user_total = user_units_total(&d)?;
    enforce_house_floor(house_after, user_total, rd_u16(&d, v2::MIN_HOUSE_SHARE_BPS))?;

    wr_u128(&mut d, v2::HOUSE_UNITS, house_after);
    wr_u128(&mut d, v2::HOUSE_PENDING_UNITS, units);
    let slot = clock()?.slot;
    let unlock = slot.saturating_add(rd_u64(&d, v2::WITHDRAW_COOLDOWN_SLOTS));
    wr_u64(&mut d, v2::HOUSE_PENDING_UNLOCK_SLOT, unlock);

    emit(&events::house_withdraw_requested(units, unlock, slot));
    Ok(())
}

/// `house_cancel_withdraw` -- spec `house.md` section 3 (lib.rs:1679-1692).
///
/// Accounts (IDL order): vault(W), v2_state(W), owner(WS)
/// Args (`args` = ix data after the 8-byte disc): none
#[inline(never)]
pub fn house_cancel_withdraw(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    check_house_ctx(accounts, false)?;
    let v2s = &mut accounts[1];

    let mut d = v2s.try_borrow_mut()?;
    let units = rd_u128(&d, v2::HOUSE_PENDING_UNITS);
    require(units > 0, K::NoPendingWithdraw)?;
    let house_after = rd_u128(&d, v2::HOUSE_UNITS).checked_add(units).ok_or(K::MathOverflow)?;
    wr_u128(&mut d, v2::HOUSE_UNITS, house_after);
    wr_u128(&mut d, v2::HOUSE_PENDING_UNITS, 0);
    wr_u64(&mut d, v2::HOUSE_PENDING_UNLOCK_SLOT, 0);

    emit(&events::house_withdraw_cancelled(units, clock()?.slot));
    Ok(())
}

/// `house_complete_withdraw` -- spec `house.md` section 4 (lib.rs:1694-1728).
///
/// Accounts (IDL order): vault(W), v2_state(W), owner(WS)
/// Args (`args` = ix data after the 8-byte disc): none
#[inline(never)]
pub fn house_complete_withdraw(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    check_house_ctx(accounts, false)?;
    let [vault, v2s, owner, ..] = accounts else { return Err(AnchorError::AccountNotEnoughKeys.into()) };

    let mut d = v2s.try_borrow_mut()?;
    let units = rd_u128(&d, v2::HOUSE_PENDING_UNITS);
    require(units > 0, K::NoPendingWithdraw)?;
    let now = clock()?.slot;
    require(now >= rd_u64(&d, v2::HOUSE_PENDING_UNLOCK_SLOT), K::CooldownNotElapsed)?;

    let assets_pre = vault_assets(vault, &rent()?)?;
    let total_units = rd_u128(&d, v2::TOTAL_UNITS);
    let assets_out = units_to_assets(units, assets_pre, total_units)?;
    require(assets_out <= assets_pre, K::InsufficientLiquidity)?;

    wr_u128(&mut d, v2::HOUSE_PENDING_UNITS, 0);
    wr_u64(&mut d, v2::HOUSE_PENDING_UNLOCK_SLOT, 0);
    wr_u128(&mut d, v2::TOTAL_UNITS, total_units.checked_sub(units).ok_or(K::MathOverflow)?);

    if assets_out > 0 {
        move_lamports(vault, owner, assets_out)?;
    }

    emit(&events::house_withdraw_completed(units, assets_out, now));
    Ok(())
}
