//! Shared runtime helpers: logging, account checks (Anchor codes), PDAs, init / close, lamports,
//! Borsh arg reader, sysvars, and the exact math helpers of lib.rs:1790-1967 / vrf_mode.rs:176-392.
//! Spec: `shared.md` §4.3, §5.

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

use crate::consts::*;
use crate::error::{AnchorError as A, KaboomError as K};
use crate::state::{self, rd_u128, rd_u16, rd_u64, vault_v2_state as v2, AccountType};

// ─── logging / syscalls ─────────────────────────────────────────────────────

/// `msg!` equivalent: one `sol_log_` (prints `Program log: <msg>`).
#[inline(always)]
pub fn log(msg: &str) {
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_(msg.as_ptr(), msg.len() as u64);
    }
    #[cfg(not(target_os = "solana"))]
    let _ = msg;
}

/// sha256 over the concatenation of `vals` (`sol_sha256` syscall; on-chain only).
#[inline(never)]
pub fn sha256(vals: &[&[u8]]) -> [u8; 32] {
    #[cfg(target_os = "solana")]
    {
        let mut out = [0u8; 32];
        unsafe {
            pinocchio::syscalls::sol_sha256(vals.as_ptr() as *const u8, vals.len() as u64, out.as_mut_ptr());
        }
        out
    }
    #[cfg(not(target_os = "solana"))]
    {
        let _ = vals;
        unreachable!("sha256 syscall is on-chain only")
    }
}

// ─── sysvars (fetch each once per instruction) ──────────────────────────────

#[inline(always)]
pub fn clock() -> Result<Clock, ProgramError> {
    Clock::get()
}
#[inline(always)]
pub fn rent() -> Result<Rent, ProgramError> {
    Rent::get()
}
/// `Rent.minimum_balance(space)` (decision D1: pinocchio `try_minimum_balance` as-is).
#[inline(always)]
pub fn rent_min(rent: &Rent, space: usize) -> Result<u64, ProgramError> {
    rent.try_minimum_balance(space)
}

// ─── account checks (Anchor codes) ──────────────────────────────────────────

/// `Signer<'info>`: 3010.
#[inline(always)]
pub fn check_signer(a: &AccountView) -> ProgramResult {
    if a.is_signer() {
        Ok(())
    } else {
        Err(A::AccountNotSigner.into())
    }
}
/// `#[account(mut)]`: 2000.
#[inline(always)]
pub fn check_mut(a: &AccountView) -> ProgramResult {
    if a.is_writable() {
        Ok(())
    } else {
        Err(A::ConstraintMut.into())
    }
}
/// `Program<'info, T>`: key -> 3008, executable -> 3009.
#[inline(never)]
pub fn check_program(a: &AccountView, id: &Address) -> ProgramResult {
    if a.address() != id {
        return Err(A::InvalidProgramId.into());
    }
    if !a.executable() {
        return Err(A::InvalidProgramExecutable.into());
    }
    Ok(())
}
/// `Program<'info, System>`.
#[inline(always)]
pub fn check_system_program(a: &AccountView) -> ProgramResult {
    check_program(a, &SYSTEM_PROGRAM_ID)
}
/// `address = X` without a custom error: 2012.
#[inline(always)]
pub fn check_address(a: &AccountView, expected: &Address) -> ProgramResult {
    if a.address() == expected {
        Ok(())
    } else {
        Err(A::ConstraintAddress.into())
    }
}
/// `close = target` self-target check (Pass C): 2011.
#[inline(always)]
pub fn check_close_target(a: &AccountView, target: &AccountView) -> ProgramResult {
    if a.address() == target.address() {
        Err(A::ConstraintClose.into())
    } else {
        Ok(())
    }
}
/// `require!(cond, E)` / `constraint = cond @ E`.
#[inline(always)]
pub fn require(cond: bool, e: K) -> ProgramResult {
    if cond {
        Ok(())
    } else {
        Err(e.into())
    }
}
/// Typed-account load (Pass A): see `state::load`.
#[inline(always)]
pub fn load(a: &AccountView, t: &AccountType) -> ProgramResult {
    state::load(a, t)
}

// ─── PDAs (decision D2 / D14: never the panicking find) ─────────────────────

/// Canonical PDA under this program. `None` -> 2006 (Anchor would panic; both fail).
#[inline(always)]
pub fn find_pda(seeds: &[&[u8]]) -> Result<(Address, u8), ProgramError> {
    find_pda_for(seeds, &ID)
}
/// Canonical PDA under `program` (e.g. DLP record / metadata seeds).
#[inline(never)]
pub fn find_pda_for(seeds: &[&[u8]], program: &Address) -> Result<(Address, u8), ProgramError> {
    Address::try_find_program_address(seeds, program).ok_or(A::ConstraintSeeds.into())
}
/// `seeds = [...], bump` (no target) on a non-init field: canonical find; key mismatch -> 2006.
/// Returns the bump (Anchor's `ctx.bumps.<field>`).
#[inline(always)]
pub fn check_pda_find(a: &AccountView, seeds: &[&[u8]]) -> Result<u8, ProgramError> {
    let (pda, bump) = find_pda(seeds)?;
    if a.address() != &pda {
        return Err(A::ConstraintSeeds.into());
    }
    Ok(bump)
}
/// `seeds = [...], bump = <stored>`: `create_program_address(seeds ++ [bump])`; error or key mismatch -> 2006.
/// At most 3 seeds before the bump.
#[inline(never)]
pub fn check_pda_bump(a: &AccountView, seeds: &[&[u8]], bump: u8) -> ProgramResult {
    let n = seeds.len();
    if n > 3 {
        return Err(A::ConstraintSeeds.into());
    }
    let b = [bump];
    let mut s: [&[u8]; 4] = [&[]; 4];
    s[..n].copy_from_slice(seeds);
    s[n] = &b;
    match Address::create_program_address(&s[..=n], &ID) {
        Ok(pda) if a.address() == &pda => Ok(()),
        _ => Err(A::ConstraintSeeds.into()),
    }
}
/// Vault seeds check: `seeds = [VAULT_SEED], bump = vault.bump` (create_program_address with the
/// stored bump), else 2006. The canonical (VAULT_PDA, 254) pair takes a fast path with no syscall.
/// Call after `load(vault, &vault::TYPE)` (reads the stored bump).
#[inline(never)]
pub fn check_vault_seeds(vault: &AccountView) -> ProgramResult {
    let bump = vault.try_borrow()?[state::vault::BUMP];
    if vault.address() == &VAULT_PDA && bump == VAULT_BUMP {
        return Ok(());
    }
    check_pda_bump(vault, &[VAULT_SEED], bump)
}
/// VaultV2State seeds check: `seeds = [V2_STATE_SEED], bump = v2_state.bump`, else 2006.
#[inline(never)]
pub fn check_v2_seeds(v2s: &AccountView) -> ProgramResult {
    let bump = v2s.try_borrow()?[v2::BUMP];
    if v2s.address() == &V2_PDA && bump == V2_BUMP {
        return Ok(());
    }
    check_pda_bump(v2s, &[VAULT_V2_SEED], bump)
}

/// Pass C for vault + v2_state in field order: seeds (D2) -> mut, then seeds -> mut.
#[inline(never)]
pub fn check_vault_v2_mut(vault: &AccountView, v2s: &AccountView) -> ProgramResult {
    check_vault_seeds(vault)?;
    check_mut(vault)?;
    check_v2_seeds(v2s)?;
    check_mut(v2s)
}

// ─── init / init_if_needed (spec shared.md §5.4, decision D8) ───────────────

/// Signer seeds `seeds ++ [bump]` for up to 2 seeds, then `f(signer)`.
#[inline(always)]
pub fn with_signer<R>(seeds: &[&[u8]], bump: u8, f: impl FnOnce(&[Signer]) -> R) -> R {
    let b = [bump];
    // For one seed, slot 1 holds the bump and we slice [..2]; for two seeds, slot 2 does.
    let arr = [
        Seed::from(seeds[0]),
        Seed::from(if seeds.len() > 1 { seeds[1] } else { &b[..] }),
        Seed::from(&b[..]),
    ];
    let signer_seeds = if seeds.len() > 1 { &arr[..] } else { &arr[..2] };
    f(&[Signer::from(signer_seeds)])
}

/// Anchor's create branch for a PDA we own (`generate_create_account`): lamports == 0 -> CreateAccount;
/// pre-funded -> payer != acc (4101), top-up `max(rent, 1) - lamports` via Transfer, then Allocate +
/// Assign signed by the PDA. Does NOT write the discriminator (the caller writes the full image).
#[inline(never)]
pub fn create_pda(
    payer: &AccountView,
    acc: &AccountView,
    seeds: &[&[u8]],
    bump: u8,
    space: usize,
    rent_lamports: u64,
) -> ProgramResult {
    if acc.lamports() == 0 {
        return with_signer(seeds, bump, |s| {
            CreateAccount { from: payer, to: acc, lamports: rent_lamports, space: space as u64, owner: &ID }
                .invoke_signed(s)
        });
    }
    if payer.address() == acc.address() {
        return Err(A::TryingToInitPayerAsProgramAccount.into());
    }
    let top_up = rent_lamports.max(1).saturating_sub(acc.lamports());
    if top_up > 0 {
        Transfer { from: payer, to: acc, lamports: top_up }.invoke()?;
    }
    with_signer(seeds, bump, |s| {
        Allocate { account: acc, space: space as u64 }.invoke_signed(s)?;
        Assign { account: acc, owner: &ID }.invoke_signed(s)
    })
}

/// Anchor `init` (Pass B) for field `acc`: find (2006) -> create -> mut (2000) -> rent-exempt (2005).
/// Plain `init` on an existing account fails inside Allocate (system Custom(0)), like Anchor.
/// Returns the canonical bump. The caller then writes the full `disc ++ fields` image.
#[inline(never)]
pub fn init_pda(
    payer: &AccountView,
    acc: &AccountView,
    seeds: &[&[u8]],
    space: usize,
    rent: &Rent,
) -> Result<u8, ProgramError> {
    let bump = check_pda_find(acc, seeds)?;
    let min = rent_min(rent, space)?;
    create_pda(payer, acc, seeds, bump, space, min)?;
    check_mut(acc)?;
    if acc.lamports() < rent_min(rent, acc.data_len())? {
        return Err(A::ConstraintRentExempt.into());
    }
    Ok(bump)
}

/// Anchor `init_if_needed` (Pass B): find (2006); if System-owned -> create (zeroed, no disc check),
/// else full typed load (3007/3001/3002/3003); then space (2019) -> owner (2004) -> rent (2005)
/// -> mut (2000) -> rent-exempt (2005). Returns `(bump, created)`.
/// "First time" in the handlers is still detected by a zero key field, exactly like Anchor.
#[inline(never)]
pub fn init_if_needed_pda(
    payer: &AccountView,
    acc: &AccountView,
    seeds: &[&[u8]],
    t: &AccountType,
    space: usize,
    rent: &Rent,
) -> Result<(u8, bool), ProgramError> {
    let bump = check_pda_find(acc, seeds)?;
    let min = rent_min(rent, space)?;
    let created = acc.owned_by(&SYSTEM_PROGRAM_ID);
    if created {
        create_pda(payer, acc, seeds, bump, space, min)?;
    } else {
        state::load(acc, t)?;
    }
    if acc.data_len() != space {
        return Err(A::ConstraintSpace.into());
    }
    if !acc.owned_by(&ID) {
        return Err(A::ConstraintOwner.into());
    }
    if acc.lamports() < min {
        return Err(A::ConstraintRentExempt.into());
    }
    check_mut(acc)?;
    if acc.lamports() < rent_min(rent, acc.data_len())? {
        return Err(A::ConstraintRentExempt.into());
    }
    Ok((bump, created))
}

// ─── close / lamports ───────────────────────────────────────────────────────

/// Anchor `close = target` (exit phase, after the handler): target += lamports; lamports = 0;
/// owner = System; data_len = 0. Run it LAST, in the struct's field order.
#[inline(never)]
pub fn close_to(acc: &mut AccountView, target: &mut AccountView) -> ProgramResult {
    let sum = target.lamports().checked_add(acc.lamports()).ok_or(ProgramError::ArithmeticOverflow)?;
    target.set_lamports(sum);
    acc.set_lamports(0);
    acc.close()
}

/// Manual zero-close (refund_stalled_vrf / admin_close_orphaned_game_v2, decision D11):
/// to += lamports; lamports = 0; data zero-filled; owner and data_len UNCHANGED.
#[inline(never)]
pub fn zero_close_to(acc: &mut AccountView, to: &mut AccountView) -> ProgramResult {
    let sum = to.lamports().checked_add(acc.lamports()).ok_or(K::MathOverflow)?;
    to.set_lamports(sum);
    acc.set_lamports(0);
    acc.try_borrow_mut()?.fill(0);
    Ok(())
}

/// Direct lamport move out of a program-owned account (checked_sub / checked_add -> 6008).
/// Reads live lamports each time, so a duplicate `from == to` nets to zero like Anchor.
#[inline(never)]
pub fn move_lamports(from: &mut AccountView, to: &mut AccountView, amount: u64) -> ProgramResult {
    from.set_lamports(from.lamports().checked_sub(amount).ok_or(K::MathOverflow)?);
    to.set_lamports(to.lamports().checked_add(amount).ok_or(K::MathOverflow)?);
    Ok(())
}

/// `v2.total_outstanding_max_payout = v2.total_outstanding_max_payout.saturating_sub(amount)`.
#[inline(never)]
pub fn release_outstanding(v2s: &mut AccountView, amount: u64) -> ProgramResult {
    let mut d = v2s.try_borrow_mut()?;
    let v = rd_u64(&d, v2::TOTAL_OUTSTANDING_MAX_PAYOUT).saturating_sub(amount);
    crate::state::wr_u64(&mut d, v2::TOTAL_OUTSTANDING_MAX_PAYOUT, v);
    Ok(())
}

/// `system_program::transfer` CPI (payer signs; used for bets / deposits INTO the vault).
#[inline(always)]
pub fn transfer(from: &AccountView, to: &AccountView, lamports: u64) -> ProgramResult {
    Transfer { from, to, lamports }.invoke()
}

// ─── Borsh argument reader (spec shared.md §5.2) ────────────────────────────

/// Sequential Borsh decoder over `args`. Short data / bad bool or Option tag -> 102.
/// Trailing bytes are ignored (Anchor uses `deserialize`, not `try_from_slice`).
pub struct Args<'a> {
    d: &'a [u8],
}

impl<'a> Args<'a> {
    #[inline(always)]
    pub fn new(d: &'a [u8]) -> Self {
        Args { d }
    }
    #[inline(always)]
    pub fn take<const N: usize>(&mut self) -> Result<&'a [u8; N], ProgramError> {
        let Some((h, t)) = self.d.split_first_chunk::<N>() else {
            return Err(A::InstructionDidNotDeserialize.into());
        };
        self.d = t;
        Ok(h)
    }
    #[inline(always)]
    pub fn u8(&mut self) -> Result<u8, ProgramError> {
        Ok(self.take::<1>()?[0])
    }
    #[inline(always)]
    pub fn bool(&mut self) -> Result<bool, ProgramError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(A::InstructionDidNotDeserialize.into()),
        }
    }
    #[inline(always)]
    pub fn u16(&mut self) -> Result<u16, ProgramError> {
        Ok(u16::from_le_bytes(*self.take()?))
    }
    #[inline(always)]
    pub fn u32(&mut self) -> Result<u32, ProgramError> {
        Ok(u32::from_le_bytes(*self.take()?))
    }
    #[inline(always)]
    pub fn u64(&mut self) -> Result<u64, ProgramError> {
        Ok(u64::from_le_bytes(*self.take()?))
    }
    #[inline(always)]
    pub fn u128(&mut self) -> Result<u128, ProgramError> {
        Ok(u128::from_le_bytes(*self.take()?))
    }
    /// `Pubkey` / `[u8; 32]`.
    #[inline(always)]
    pub fn pk(&mut self) -> Result<&'a [u8; 32], ProgramError> {
        self.take::<32>()
    }
    /// `Option` tag: strict 0/1.
    #[inline(always)]
    pub fn some(&mut self) -> Result<bool, ProgramError> {
        self.bool()
    }
    #[inline(always)]
    pub fn opt_u16(&mut self) -> Result<Option<u16>, ProgramError> {
        Ok(if self.some()? { Some(self.u16()?) } else { None })
    }
    #[inline(always)]
    pub fn opt_u64(&mut self) -> Result<Option<u64>, ProgramError> {
        Ok(if self.some()? { Some(self.u64()?) } else { None })
    }
    #[inline(always)]
    pub fn opt_bool(&mut self) -> Result<Option<bool>, ProgramError> {
        Ok(if self.some()? { Some(self.bool()?) } else { None })
    }
    #[inline(always)]
    pub fn opt_pk(&mut self) -> Result<Option<&'a [u8; 32]>, ProgramError> {
        Ok(if self.some()? { Some(self.pk()?) } else { None })
    }
    /// Remaining undecoded bytes (e.g. the `Vec<Vec<u8>>` of process_undelegation).
    #[inline(always)]
    pub fn rest(&self) -> &'a [u8] {
        self.d
    }
}

// ─── math (lib.rs:1790-1967, exact; MathOverflow = 6008) ────────────────────

const OVF: K = K::MathOverflow;

/// lib.rs:1790. `safe == 0` -> 10_000 with no other check.
#[inline(never)]
pub fn calc_multiplier(safe_reveals: u8, mine_count: u8, house_edge_bps: u16) -> Result<u64, ProgramError> {
    if safe_reveals == 0 {
        return Ok(BPS);
    }
    require((mine_count as u64) + (safe_reveals as u64) <= GRID_SIZE as u64, K::InvalidMineCount)?;
    let total = GRID_SIZE as u128;
    let mines = mine_count as u128;
    let mut num: u128 = 1;
    let mut den: u128 = 1;
    for i in 0..safe_reveals as u128 {
        let tiles_remaining = total.checked_sub(i).ok_or(OVF)?;
        let safe_remaining = total.checked_sub(mines).and_then(|v| v.checked_sub(i)).ok_or(OVF)?;
        require(safe_remaining > 0, K::InvalidMineCount)?;
        num = num.checked_mul(tiles_remaining).ok_or(OVF)?;
        den = den.checked_mul(safe_remaining).ok_or(OVF)?;
    }
    let raw_bps = num.checked_mul(BPS as u128).ok_or(OVF)?.checked_div(den).ok_or(OVF)?;
    // u64 subtraction: panics (overflow-checks) if edge > 10_000, like Anchor. Callers prevent it.
    let edge_factor = (BPS - house_edge_bps as u64) as u128;
    let final_bps = raw_bps.checked_mul(edge_factor).ok_or(OVF)?.checked_div(BPS as u128).ok_or(OVF)?;
    u64::try_from(final_bps).map_err(|_| OVF.into())
}

/// lib.rs:1836. `a * num / den` in u128, floor; den 0 or > u64 -> 6008.
#[inline(never)]
pub fn mul_div_floor(a: u64, num: u64, den: u64) -> Result<u64, ProgramError> {
    let v = (a as u128).checked_mul(num as u128).ok_or(OVF)?.checked_div(den as u128).ok_or(OVF)?;
    u64::try_from(v).map_err(|_| OVF.into())
}

/// lib.rs:1846.
#[inline(always)]
pub fn worst_case_payout(bet: u64, mine_count: u8, house_edge_bps: u16) -> Result<u64, ProgramError> {
    let worst_safe = GRID_SIZE.saturating_sub(mine_count);
    mul_div_floor(bet, calc_multiplier(worst_safe, mine_count, house_edge_bps)?, BPS)
}

/// lib.rs:1854. `vault.lamports - rent(428)`, saturating.
#[inline(always)]
pub fn vault_assets(vault: &AccountView, rent: &Rent) -> Result<u64, ProgramError> {
    Ok(vault.lamports().saturating_sub(rent_min(rent, state::vault::SPACE)?))
}

/// lib.rs:1861.
#[inline(never)]
pub fn deposit_to_units(amount: u64, vault_assets_pre: u64, total_units: u128) -> Result<u128, ProgramError> {
    if total_units == 0 {
        return Ok(amount as u128);
    }
    require(vault_assets_pre > 0, OVF)?;
    Ok((amount as u128).checked_mul(total_units).ok_or(OVF)?.checked_div(vault_assets_pre as u128).ok_or(OVF)?)
}

/// lib.rs:1873.
#[inline(never)]
pub fn units_to_assets(units: u128, vault_assets: u64, total_units: u128) -> Result<u64, ProgramError> {
    if total_units == 0 || units == 0 {
        return Ok(0);
    }
    let v = units.checked_mul(vault_assets as u128).ok_or(OVF)?.checked_div(total_units).ok_or(OVF)?;
    u64::try_from(v).map_err(|_| OVF.into())
}

/// lib.rs:1885. `v2d` = VaultV2State data (from offset 0, disc included).
#[inline(never)]
pub fn user_units_total(v2d: &[u8]) -> Result<u128, ProgramError> {
    rd_u128(v2d, v2::TOTAL_UNITS)
        .checked_sub(rd_u128(v2d, v2::SEED_UNITS))
        .and_then(|v| v.checked_sub(rd_u128(v2d, v2::HOUSE_UNITS)))
        .and_then(|v| v.checked_sub(rd_u128(v2d, v2::HOUSE_PENDING_UNITS)))
        .ok_or(OVF.into())
}

/// lib.rs:1893. Reads `total_pending_units`, `total_units`, `total_outstanding_max_payout` from `v2d`.
#[inline(never)]
pub fn calc_health_bps(v2d: &[u8], vault_assets_now: u64) -> Result<u16, ProgramError> {
    if vault_assets_now == 0 {
        return Ok(0);
    }
    let pending_value =
        units_to_assets(rd_u128(v2d, v2::TOTAL_PENDING_UNITS), vault_assets_now, rd_u128(v2d, v2::TOTAL_UNITS))?;
    let obligations = rd_u64(v2d, v2::TOTAL_OUTSTANDING_MAX_PAYOUT).checked_add(pending_value).ok_or(OVF)?;
    let free = vault_assets_now.saturating_sub(obligations);
    let h = (free as u128).checked_mul(BPS as u128).ok_or(OVF)?.checked_div(vault_assets_now as u128).ok_or(OVF)?;
    Ok(h.min(BPS as u128) as u16)
}

/// lib.rs:1911. 6034 below `min_health_bps` (0 = off).
#[inline(never)]
pub fn enforce_min_health(v2d: &[u8], vault_assets_now: u64) -> ProgramResult {
    let min = rd_u16(v2d, v2::MIN_HEALTH_BPS);
    if min == 0 {
        return Ok(());
    }
    require(calc_health_bps(v2d, vault_assets_now)? >= min, K::HealthFloorBreached)
}

/// lib.rs:1920. 6033.
#[inline(never)]
pub fn enforce_house_floor(house_units_after: u128, user_units_total_after: u128, min_house_share_bps: u16) -> ProgramResult {
    if min_house_share_bps == 0 {
        return Ok(());
    }
    let denom = house_units_after.checked_add(user_units_total_after).ok_or(OVF)?;
    if denom == 0 {
        return Ok(());
    }
    let lhs = house_units_after.checked_mul(BPS as u128).ok_or(OVF)?;
    let rhs = (min_house_share_bps as u128).checked_mul(denom).ok_or(OVF)?;
    require(lhs >= rhs, K::HouseShareFloorBreached)
}

/// lib.rs:1944. 6032. Floors after each division, in this order.
#[inline(never)]
pub fn enforce_user_position_cap(
    user_position_value: u64,
    vault_assets_now: u64,
    health_bps_value: u16,
    max_user_position_bps: u16,
) -> ProgramResult {
    if max_user_position_bps == 0 {
        return Ok(());
    }
    let cap = (vault_assets_now as u128)
        .checked_mul(max_user_position_bps as u128)
        .ok_or(OVF)?
        .checked_div(BPS as u128)
        .ok_or(OVF)?
        .checked_mul(health_bps_value as u128)
        .ok_or(OVF)?
        .checked_div(BPS as u128)
        .ok_or(OVF)?;
    require((user_position_value as u128) <= cap, K::UserPositionCapExceeded)
}

/// vrf_mode.rs:176. Owner-gated cleanup budget: assets, minus 1 while LP units exist.
#[inline(always)]
pub fn admin_spendable(vault: &AccountView, v2d: &[u8], rent: &Rent) -> Result<u64, ProgramError> {
    let available = vault_assets(vault, rent)?;
    Ok(if rd_u128(v2d, v2::TOTAL_UNITS) > 0 { available.saturating_sub(1) } else { available })
}

/// vrf_mode.rs:192. Exactly uniform per-click mine decision.
#[inline(always)]
pub fn decide_mine(randomness: &[u8; 32], safe_reveals: u8, mine_count: u8) -> bool {
    let remaining = GRID_SIZE.saturating_sub(safe_reveals) as u64;
    if remaining == 0 {
        return false;
    }
    let x = u64::from_le_bytes(state::rd_arr(randomness, 0)) % remaining;
    x < mine_count as u64
}

/// vrf_mode.rs:372, checked in this order: owner (6052), len >= 80 (6049), disc (6049),
/// status Playing (6050), not pending (6044).
#[inline(never)]
pub fn check_vrf_game_delegable(owner: &Address, data: &[u8]) -> ProgramResult {
    require(owner == &ID, K::GameStillDelegated)?;
    require(data.len() >= state::VRF_GAME_MIN_RAW_LEN, K::BadGameAccount)?;
    require(data[..8] == state::vrf_game::DISC, K::BadGameAccount)?;
    require(data[state::vrf_game::STATUS] == VRF_PLAYING, K::GameAlreadyResolved)?;
    require(data[state::vrf_game::PENDING] == 0, K::RevealPending)
}

/// Referral cut by tier (lib.rs settle_game: 0 bronze, 1 silver, anything else gold).
#[inline(always)]
pub fn referral_cut_bps(tier: u8) -> u16 {
    match tier {
        0 => REFERRAL_BRONZE_BPS,
        1 => REFERRAL_SILVER_BPS,
        _ => REFERRAL_GOLD_BPS,
    }
}

/// Referral tier for a cumulative referred volume (2 >= 100 SOL, 1 >= 10 SOL, else 0).
#[inline(always)]
pub fn tier_for_volume(referred_volume: u64) -> u8 {
    if referred_volume >= GOLD_VOLUME_LAMPORTS {
        2
    } else if referred_volume >= SILVER_VOLUME_LAMPORTS {
        1
    } else {
        0
    }
}
