//! PlayKaboom wind-down drain. Deployed as an in-place upgrade of Ednka8zj... so the program's own
//! accounts (Vault, VaultV2State, LpPosition, PlayerStats, ReferralAccount) can be closed; the live
//! program has no close instruction for most of them.
//!
//! ONE instruction, empty data. Accounts: [0] AUTHORITY (signer), then (source, destination) pairs.
//! Every pair is checked before any lamport moves; then each source's lamports all go to its
//! destination and the source is closed (data_len 0, owner System, lamports 0).
//!
//! Errors (Custom): 1 data not empty, 2 no pairs or odd count, 3 wrong authority, 4 authority not
//! signer, 5 source not owned by this program, 6 source read-only, 7 destination == source,
//! 8 destination owned by this program, 9 destination read-only, 10 duplicate source.
#![no_std]

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

/// The upgrade authority (deployer). Only this key can drain.
pub const AUTHORITY: Address = Address::from_str_const("qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG");

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    // Default maximum (255): a smaller cap would silently drop trailing pairs.
    pinocchio::program_entrypoint!(crate::process_instruction);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}

fn fail(code: u32) -> ProgramResult {
    Err(ProgramError::Custom(code))
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if !data.is_empty() {
        return fail(1);
    }
    let [auth, pairs @ ..] = accounts else { return fail(2) };
    if pairs.is_empty() || pairs.len() % 2 != 0 {
        return fail(2);
    }
    if auth.address() != &AUTHORITY {
        return fail(3);
    }
    if !auth.is_signer() {
        return fail(4);
    }

    // Validate everything against the pre-state first. A destination may never be program-owned, so it can
    // never be a source of another pair either (no lamports land in an account that is then closed).
    for (i, p) in pairs.chunks_exact(2).enumerate() {
        let (src, dst) = (&p[0], &p[1]);
        if !src.owned_by(program_id) {
            return fail(5);
        }
        if !src.is_writable() {
            return fail(6);
        }
        if dst.address() == src.address() {
            return fail(7);
        }
        if dst.owned_by(program_id) {
            return fail(8);
        }
        if !dst.is_writable() {
            return fail(9);
        }
        if pairs[..2 * i].chunks_exact(2).any(|q| q[0].address() == src.address()) {
            return fail(10);
        }
    }

    for p in pairs.chunks_exact_mut(2) {
        let (src, dst) = p.split_at_mut(1);
        let (src, dst) = (&mut src[0], &mut dst[0]);
        // Live read: several pairs may share one destination.
        let sum = dst.lamports().checked_add(src.lamports()).ok_or(ProgramError::ArithmeticOverflow)?;
        dst.set_lamports(sum);
        src.close()?; // zeroes owner (= System), lamports and data_len
    }

    let n = pairs.len() / 2; // <= 127
    let mut m = *b"drain: closed 000";
    m[14] += (n / 100) as u8;
    m[15] += (n / 10 % 10) as u8;
    m[16] += (n % 10) as u8;
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_(m.as_ptr(), m.len() as u64);
    }
    #[cfg(not(target_os = "solana"))]
    let _ = m;
    Ok(())
}
