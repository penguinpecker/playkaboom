//! `vault-admin` group: 10 handlers. Spec: `pinocchio/spec/vault-admin.md`.
//! Source: `programs/kaboom/src/lib.rs` 148-214, 948-1301 (contexts 2241-2273, 2499-2564).

use pinocchio::{AccountView, ProgramResult};

use crate::consts::*;
use crate::error::{AnchorError as A, KaboomError as K};
use crate::events::{self, emit};
use crate::helpers::*;
use crate::state::{rd_pk, rd_u128, rd_u64, vault as vt, vault_v2_state as v2, wr_bytes, wr_u128, wr_u16, wr_u64};

const ZERO: [u8; 32] = [0u8; 32];

/// `withdraw_allowlist.iter().take(allowlist_count).any(|k| k == key)` (lib.rs:976-980).
/// `take(n)` on the 8-element array clamps a corrupt count to 8.
fn is_allowlisted(d: &[u8], key: &[u8; 32]) -> bool {
    let n = (d[vt::ALLOWLIST_COUNT] as usize).min(MAX_ALLOWLIST);
    (0..n).any(|i| rd_pk(d, vt::WITHDRAW_ALLOWLIST + 32 * i) == key)
}

/// Shared vault gate of `UpdateVault` / `AcceptOwnership` / `WithdrawToTreasury`:
/// Pass A `Account<Vault>` + `Signer`; Pass C seeds (2006) -> mut (2000) -> `vault.<key_off> == signer` (6007).
#[inline(never)]
fn vault_gate(vault: &AccountView, signer: &AccountView, key_off: usize) -> ProgramResult {
    load(vault, &vt::TYPE)?;
    check_signer(signer)?;
    check_vault_seeds(vault)?;
    check_mut(vault)?;
    require(rd_pk(&vault.try_borrow()?, key_off) == signer.address().as_array(), K::Unauthorized)
}

/// `initialize_vault` -- spec `vault-admin.md` section 1.
#[inline(never)]
pub fn initialize_vault(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let mut a = Args::new(args);
    let house_edge_bps = a.u16()?;
    let max_bet_bps = a.u16()?;
    let max_payout_bps = a.u16()?;
    let [vault, house_authority, treasury, owner, system_program, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    check_signer(owner)?;
    check_system_program(system_program)?;
    // Pass B: init vault, seeds [VAULT_SEED] canonical (D2: const PDA + const bump).
    if vault.address() != &VAULT_PDA {
        return Err(A::ConstraintSeeds.into());
    }
    let rent = rent()?;
    create_pda(owner, vault, &[VAULT_SEED], VAULT_BUMP, vt::SPACE, rent_min(&rent, vt::SPACE)?)?;
    check_mut(vault)?;
    if vault.lamports() < rent_min(&rent, vault.data_len())? {
        return Err(A::ConstraintRentExempt.into());
    }
    // Pass C
    check_mut(owner)?;
    // F1 (AUTH-1/MONEY-4/PINO-1): last account check, so every Anchor error path keeps its code.
    require(owner.address() == &DEPLOYER, K::NotDeployer)?;
    // handler
    require(house_edge_bps <= MAX_HOUSE_EDGE_BPS, K::InvalidConfig)?;
    require(max_bet_bps > 0 && max_bet_bps <= MAX_BET_BPS, K::InvalidConfig)?;
    require(max_payout_bps > 0 && max_payout_bps <= MAX_PAYOUT_BPS, K::InvalidConfig)?;
    let vk = *vault.address().as_array();
    let ok = owner.address().as_array();
    let hk = house_authority.address().as_array();
    let tk = treasury.address().as_array();
    {
        let mut d = vault.try_borrow_mut()?;
        d[..vt::END].fill(0);
        d[..8].copy_from_slice(&vt::DISC);
        wr_bytes(&mut d, vt::OWNER, ok);
        wr_bytes(&mut d, vt::HOUSE_AUTHORITY, hk);
        wr_bytes(&mut d, vt::TREASURY, tk);
        d[vt::BUMP] = VAULT_BUMP;
        wr_u16(&mut d, vt::HOUSE_EDGE_BPS, house_edge_bps);
        wr_u16(&mut d, vt::MAX_BET_BPS, max_bet_bps);
        wr_u16(&mut d, vt::MAX_PAYOUT_BPS, max_payout_bps);
        wr_u16(&mut d, vt::TREASURY_SPLIT_BPS, DEFAULT_TREASURY_SPLIT_BPS);
        d[vt::VERSION] = 1;
    }
    emit(&events::vault_initialized(&vk, ok, hk, tk, clock()?.slot));
    Ok(())
}

/// `fund_vault` -- spec `vault-admin.md` section 2.
#[inline(never)]
pub fn fund_vault(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let amount = Args::new(args).u64()?;
    let [vault, funder, system_program, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    load(vault, &vt::TYPE)?;
    check_signer(funder)?;
    check_system_program(system_program)?;
    check_vault_seeds(vault)?;
    check_mut(vault)?;
    check_mut(funder)?;
    require(amount > 0, K::InvalidAmount)?;
    transfer(funder, vault, amount)?;
    emit(&events::vault_funded(funder.address().as_array(), amount, vault.lamports(), clock()?.slot));
    Ok(())
}

/// `withdraw_to_treasury` -- spec `vault-admin.md` section 3.
#[inline(never)]
pub fn withdraw_to_treasury(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let amount = Args::new(args).u64()?;
    let [vault, treasury, destination, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    vault_gate(vault, treasury, vt::TREASURY)?;
    check_mut(destination)?;
    require(amount > 0, K::InvalidAmount)?;
    let dest_key = *destination.address().as_array();
    require(!destination.executable(), K::InvalidAmount)?;
    require(destination.address() != vault.address(), K::InvalidConfig)?;
    require(is_allowlisted(&vault.try_borrow()?, &dest_key), K::DestinationNotAllowlisted)?;
    let rent = rent()?;
    let withdraw = amount.min(vault_assets(vault, &rent)?);
    move_lamports(vault, destination, withdraw)?;
    emit(&events::treasury_withdrawal(treasury.address().as_array(), &dest_key, withdraw, clock()?.slot));
    Ok(())
}

/// `unlock_operator_position` -- spec `vault-admin.md` section 4.
#[inline(never)]
pub fn unlock_operator_position(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, v2_state, owner, destination, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    // Pass A
    load(vault, &vt::TYPE)?;
    load(v2_state, &v2::TYPE)?;
    check_signer(owner)?;
    // Pass C
    check_vault_seeds(vault)?;
    check_mut(vault)?;
    require(rd_pk(&vault.try_borrow()?, vt::OWNER) == owner.address().as_array(), K::Unauthorized)?;
    check_v2_seeds(v2_state)?;
    check_mut(v2_state)?;
    check_mut(destination)?;
    // handler (lib.rs:1043-1131)
    let dest_key = *destination.address().as_array();
    let mut d2 = v2_state.try_borrow_mut()?;
    let burned_seed = rd_u128(&d2, v2::SEED_UNITS);
    let burned_house = rd_u128(&d2, v2::HOUSE_UNITS);
    let burned_pending = rd_u128(&d2, v2::HOUSE_PENDING_UNITS);
    let burn_units = burned_seed
        .checked_add(burned_house)
        .and_then(|s| s.checked_add(burned_pending))
        .ok_or(K::MathOverflow)?;
    require(burn_units > 0, K::NoOperatorUnitsToUnlock)?;
    require(!destination.executable(), K::InvalidAmount)?;
    require(destination.address() != vault.address(), K::InvalidConfig)?;
    require(is_allowlisted(&vault.try_borrow()?, &dest_key), K::DestinationNotAllowlisted)?;
    let rent = rent()?;
    let assets = vault_assets(vault, &rent)?;
    let total_units = rd_u128(&d2, v2::TOTAL_UNITS);
    let payout_lamports = units_to_assets(burn_units, assets, total_units)?;
    let user_pending_value = units_to_assets(rd_u128(&d2, v2::TOTAL_PENDING_UNITS), assets, total_units)?;
    let withdrawable = assets
        .saturating_sub(rd_u64(&d2, v2::TOTAL_OUTSTANDING_MAX_PAYOUT))
        .saturating_sub(user_pending_value);
    let actual = payout_lamports.min(withdrawable);
    require(actual > 0, K::InsufficientLiquidity)?;
    wr_u128(&mut d2, v2::TOTAL_UNITS, total_units.checked_sub(burn_units).ok_or(K::MathOverflow)?);
    wr_u128(&mut d2, v2::SEED_UNITS, 0);
    wr_u128(&mut d2, v2::HOUSE_UNITS, 0);
    wr_u128(&mut d2, v2::HOUSE_PENDING_UNITS, 0);
    wr_u64(&mut d2, v2::HOUSE_PENDING_UNLOCK_SLOT, 0);
    move_lamports(vault, destination, actual)?;
    enforce_min_health(&d2, vault_assets(vault, &rent)?)?;
    drop(d2);
    emit(&events::operator_units_unlocked(
        vault.address().as_array(),
        &dest_key,
        actual,
        burned_seed,
        burned_house,
        burned_pending,
        clock()?.slot,
    ));
    Ok(())
}

/// `update_vault` -- spec `vault-admin.md` section 5.
#[inline(never)]
pub fn update_vault(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let mut a = Args::new(args);
    let house_edge_bps = a.opt_u16()?;
    let max_bet_bps = a.opt_u16()?;
    let max_payout_bps = a.opt_u16()?;
    let treasury_split_bps = a.opt_u16()?;
    let paused = a.opt_bool()?;
    let new_house_authority = a.opt_pk()?;
    let new_treasury = a.opt_pk()?;
    let [vault, owner, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    vault_gate(vault, owner, vt::OWNER)?;
    let vk = *vault.address().as_array();
    {
        let mut d = vault.try_borrow_mut()?;
        if let Some(e) = house_edge_bps {
            require(e <= MAX_HOUSE_EDGE_BPS, K::InvalidConfig)?;
            wr_u16(&mut d, vt::HOUSE_EDGE_BPS, e);
        }
        if let Some(b) = max_bet_bps {
            require(b > 0 && b <= MAX_BET_BPS, K::InvalidConfig)?;
            wr_u16(&mut d, vt::MAX_BET_BPS, b);
        }
        if let Some(p) = max_payout_bps {
            require(p > 0 && p <= MAX_PAYOUT_BPS, K::InvalidConfig)?;
            wr_u16(&mut d, vt::MAX_PAYOUT_BPS, p);
        }
        if let Some(t) = treasury_split_bps {
            require(t <= BPS as u16, K::InvalidConfig)?;
            wr_u16(&mut d, vt::TREASURY_SPLIT_BPS, t);
        }
        if let Some(p) = paused {
            d[vt::PAUSED] = p as u8;
        }
        if let Some(auth) = new_house_authority {
            require(auth != &ZERO, K::InvalidConfig)?;
            wr_bytes(&mut d, vt::HOUSE_AUTHORITY, auth);
        }
        if let Some(t) = new_treasury {
            require(t != &ZERO, K::InvalidConfig)?;
            wr_bytes(&mut d, vt::TREASURY, t);
        }
    }
    emit(&events::vault_updated(&vk, clock()?.slot));
    Ok(())
}

/// `allowlist_add` -- spec `vault-admin.md` section 6.
#[inline(never)]
pub fn allowlist_add(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let address = Args::new(args).pk()?;
    let [vault, owner, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    vault_gate(vault, owner, vt::OWNER)?;
    let vk = *vault.address().as_array();
    {
        let mut d = vault.try_borrow_mut()?;
        let count = d[vt::ALLOWLIST_COUNT];
        require((count as usize) < MAX_ALLOWLIST, K::AllowlistFull)?;
        require(!is_allowlisted(&d, address), K::AlreadyAllowlisted)?;
        wr_bytes(&mut d, vt::WITHDRAW_ALLOWLIST + 32 * count as usize, address);
        d[vt::ALLOWLIST_COUNT] = count.saturating_add(1);
    }
    emit(&events::allowlist_changed(&vk, address, true, clock()?.slot));
    Ok(())
}

/// `allowlist_remove` -- spec `vault-admin.md` section 7.
#[inline(never)]
pub fn allowlist_remove(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let address = Args::new(args).pk()?;
    let [vault, owner, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    vault_gate(vault, owner, vt::OWNER)?;
    let vk = *vault.address().as_array();
    {
        let mut d = vault.try_borrow_mut()?;
        let count = d[vt::ALLOWLIST_COUNT] as usize;
        // D10: loop clamped to min(count, 8).
        let idx = (0..count.min(MAX_ALLOWLIST))
            .find(|&i| rd_pk(&d, vt::WITHDRAW_ALLOWLIST + 32 * i) == address)
            .ok_or(K::AddressNotInAllowlist)?;
        let last = count - 1;
        // Anchor panics indexing `withdraw_allowlist[last]` when count > 8 (unreachable: add caps at 8).
        if last >= MAX_ALLOWLIST {
            return Err(pinocchio::error::ProgramError::InvalidAccountData);
        }
        if idx != last {
            let moved = *rd_pk(&d, vt::WITHDRAW_ALLOWLIST + 32 * last);
            wr_bytes(&mut d, vt::WITHDRAW_ALLOWLIST + 32 * idx, &moved);
        }
        wr_bytes(&mut d, vt::WITHDRAW_ALLOWLIST + 32 * last, &ZERO);
        d[vt::ALLOWLIST_COUNT] = last as u8;
    }
    emit(&events::allowlist_changed(&vk, address, false, clock()?.slot));
    Ok(())
}

/// `propose_owner` -- spec `vault-admin.md` section 8.
#[inline(never)]
pub fn propose_owner(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let new_owner = Args::new(args).pk()?;
    let [vault, owner, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    vault_gate(vault, owner, vt::OWNER)?;
    let vk = *vault.address().as_array();
    let current_owner = {
        let mut d = vault.try_borrow_mut()?;
        require(new_owner != &ZERO, K::InvalidConfig)?;
        require(new_owner != rd_pk(&d, vt::OWNER), K::InvalidConfig)?;
        wr_bytes(&mut d, vt::PENDING_OWNER, new_owner);
        *rd_pk(&d, vt::OWNER)
    };
    emit(&events::owner_proposed(&vk, &current_owner, new_owner, clock()?.slot));
    Ok(())
}

/// `cancel_proposed_owner` -- spec `vault-admin.md` section 9.
#[inline(never)]
pub fn cancel_proposed_owner(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, owner, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    vault_gate(vault, owner, vt::OWNER)?;
    let vk = *vault.address().as_array();
    {
        let mut d = vault.try_borrow_mut()?;
        require(rd_pk(&d, vt::PENDING_OWNER) != &ZERO, K::NoPendingOwner)?;
        wr_bytes(&mut d, vt::PENDING_OWNER, &ZERO);
    }
    emit(&events::owner_proposal_cancelled(&vk, clock()?.slot));
    Ok(())
}

/// `accept_ownership` -- spec `vault-admin.md` section 10.
#[inline(never)]
pub fn accept_ownership(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, new_owner, ..] = accounts else {
        return Err(A::AccountNotEnoughKeys.into());
    };
    vault_gate(vault, new_owner, vt::PENDING_OWNER)?;
    let vk = *vault.address().as_array();
    let nk = new_owner.address().as_array();
    let (old_owner, owner_now) = {
        let mut d = vault.try_borrow_mut()?;
        let pending = *rd_pk(&d, vt::PENDING_OWNER);
        require(pending != ZERO, K::NoPendingOwner)?;
        require(&pending == nk, K::Unauthorized)?;
        let old = *rd_pk(&d, vt::OWNER);
        wr_bytes(&mut d, vt::OWNER, &pending);
        wr_bytes(&mut d, vt::PENDING_OWNER, &ZERO);
        (old, pending)
    };
    emit(&events::owner_accepted(&vk, &old_owner, &owner_now, clock()?.slot));
    Ok(())
}
