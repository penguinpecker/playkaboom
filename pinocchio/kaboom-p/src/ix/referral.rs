//! `referral` group: 3 handlers. Spec: `pinocchio/spec/referral.md`.

use pinocchio::{AccountView, ProgramResult};

use crate::consts::*;
use crate::error::{AnchorError, KaboomError};
use crate::events::{self, emit};
use crate::helpers::*;
use crate::state::{player_stats as ps, rd_pk, rd_u32, rd_u64, referral_account as ra, vault as vt, wr_bytes, wr_u32, wr_u64};

const ZERO_KEY: [u8; 32] = [0u8; 32];

/// `set_referrer` -- spec `referral.md` section 1 (lib.rs:222-262, accounts lib.rs:2275-2300).
///
/// Accounts (IDL order): player_stats(W), referrer, referral_account(W), player(WS), system_program
/// Args: none (trailing bytes ignored).
#[inline(never)]
pub fn set_referrer(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [stats, referrer, referral, player, system_program, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    // Pass A: init fields taken raw; referrer unchecked.
    check_signer(player)?;
    check_system_program(system_program)?;

    let player_key: [u8; 32] = *player.address().as_array();
    let referrer_key: [u8; 32] = *referrer.address().as_array();

    // Pass B: init_if_needed player_stats, then referral_account (canonical bumps).
    let rent = rent()?;
    let (stats_bump, _) = init_if_needed_pda(player, stats, &[STATS_SEED, &player_key], &ps::TYPE, ps::SPACE, &rent)?;
    let (referral_bump, _) =
        init_if_needed_pda(player, referral, &[REFERRAL_SEED, &referrer_key], &ra::TYPE, ra::SPACE, &rent)?;

    // Pass C: referrer none; player mut; system_program none.
    check_mut(player)?;

    // Handler body.
    require(referrer_key != player_key, KaboomError::SelfReferral)?;

    {
        let mut d = stats.try_borrow_mut()?;
        if rd_pk(&d, ps::PLAYER) == &ZERO_KEY {
            wr_bytes(&mut d, ps::PLAYER, &player_key);
            d[ps::BUMP] = stats_bump;
            d[ps::VERSION] = 1;
        }
        require(d[ps::REFERRER_TAG] == 0, KaboomError::ReferrerAlreadySet)?;
        // Anchor re-serializes the whole struct at exit: None -> Some shifts the 64-byte
        // `_reserved` from 107..171 to 139..203 (init_if_needed already pinned len == 203, else 2019).
        d.copy_within(ps::REFERRER..ps::REFERRER + 64, ps::RESERVED);
        d[ps::REFERRER_TAG] = 1;
        wr_bytes(&mut d, ps::REFERRER, &referrer_key);
        wr_bytes(&mut d, 0, &ps::DISC);
    }

    {
        let mut d = referral.try_borrow_mut()?;
        if rd_pk(&d, ra::REFERRER) == &ZERO_KEY {
            wr_bytes(&mut d, ra::REFERRER, &referrer_key);
            d[ra::BUMP] = referral_bump;
            d[ra::TIER] = 0;
            d[ra::VERSION] = 1;
        }
        let count = rd_u32(&d, ra::REFERRED_COUNT).saturating_add(1);
        wr_u32(&mut d, ra::REFERRED_COUNT, count);
        wr_bytes(&mut d, 0, &ra::DISC);
    }

    emit(&events::referrer_set(&player_key, &referrer_key, clock()?.slot));
    Ok(())
}

/// `claim_referral` -- spec `referral.md` section 2 (lib.rs:800-828, accounts lib.rs:2408-2420).
///
/// Accounts (IDL order): referral_account(W), referrer(WS)
/// Args: none (trailing bytes ignored).
#[inline(never)]
pub fn claim_referral(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [referral, referrer, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    // Pass A.
    load(referral, &ra::TYPE)?;
    check_signer(referrer)?;

    // Pass C: referral_account seeds (stored bump) -> mut -> constraint @Unauthorized; referrer mut.
    let referrer_key: [u8; 32] = *referrer.address().as_array();
    let amount = {
        let d = referral.try_borrow()?;
        check_pda_bump(referral, &[REFERRAL_SEED, &referrer_key], d[ra::BUMP])?;
        check_mut(referral)?;
        require(rd_pk(&d, ra::REFERRER) == &referrer_key, KaboomError::Unauthorized)?;
        rd_u64(&d, ra::ACCRUED_LAMPORTS)
    };
    check_mut(referrer)?;

    // Handler body.
    require(amount > 0, KaboomError::NothingToClaim)?;
    let rent_lamports = rent_min(&rent()?, ra::SPACE)?;
    let withdrawable = referral.lamports().saturating_sub(rent_lamports);
    let payout = amount.min(withdrawable);
    move_lamports(referral, referrer, payout)?;

    let stored_referrer: [u8; 32] = {
        let mut d = referral.try_borrow_mut()?;
        let accrued = rd_u64(&d, ra::ACCRUED_LAMPORTS).saturating_sub(payout);
        wr_u64(&mut d, ra::ACCRUED_LAMPORTS, accrued);
        *rd_pk(&d, ra::REFERRER)
    };

    emit(&events::referral_claimed(&stored_referrer, payout, clock()?.slot));
    Ok(())
}

/// `repair_referral` -- spec `referral.md` section 3 (lib.rs:839-860, accounts lib.rs:2422-2444).
///
/// Accounts (IDL order): vault, referrer, referral_account(W), owner(S)
/// Args: none (trailing bytes ignored).
#[inline(never)]
pub fn repair_referral(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [vault, referrer, referral, owner, ..] = accounts else {
        return Err(AnchorError::AccountNotEnoughKeys.into());
    };
    // Pass A: vault, referrer (unchecked), referral_account, owner.
    load(vault, &vt::TYPE)?;
    load(referral, &ra::TYPE)?;
    check_signer(owner)?;

    // Pass C: vault seeds -> constraint @Unauthorized; referral_account seeds (stored bump) -> mut.
    check_vault_seeds(vault)?;
    require(rd_pk(&vault.try_borrow()?, vt::OWNER) == owner.address().as_array(), KaboomError::Unauthorized)?;
    let referrer_key: [u8; 32] = *referrer.address().as_array();
    {
        let bump = referral.try_borrow()?[ra::BUMP];
        check_pda_bump(referral, &[REFERRAL_SEED, &referrer_key], bump)?;
    }
    check_mut(referral)?;

    // Handler body.
    {
        let mut d = referral.try_borrow_mut()?;
        let current = rd_pk(&d, ra::REFERRER);
        if current == &referrer_key {
            return Ok(());
        }
        require(current == &ZERO_KEY, KaboomError::Unauthorized)?;
        wr_bytes(&mut d, ra::REFERRER, &referrer_key);
    }

    emit(&events::referral_repaired(&referrer_key, clock()?.slot));
    Ok(())
}
