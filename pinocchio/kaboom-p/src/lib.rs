//! PlayKaboom Mines: Pinocchio port of `programs/kaboom` (Anchor 0.31.1, git e82f2c5).
//! ABI-identical to the Anchor program; only the program id changes. See `PORT_NOTES.md`.
#![no_std]

pub mod consts;
pub mod error;
pub mod events;
pub mod helpers;
pub mod ix;
pub mod state;

pub use consts::ID;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::error::AnchorError;

/// Most accounts any instruction reads (settle_vrf / delegate_vrf: 9 + remaining[0]).
/// Extra accounts are ignored, like Anchor ignores unused remaining accounts.
pub const MAX_ACCOUNTS: usize = 10;

#[cfg(not(feature = "no-entrypoint"))]
#[allow(dead_code)]
mod entrypoint {
    pinocchio::program_entrypoint!(crate::process_instruction, { crate::MAX_ACCOUNTS });
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}

/// security.txt, same fields as `lib.rs:35-46` except `auditors` (decision D7: no audit claim).
#[cfg(not(feature = "no-entrypoint"))]
// No `#[used]`: it sets SHF_GNU_RETAIN, which makes lld write EI_OSABI = GNU and every sbpf loader
// rejects the ELF ("wrong ABI"). `#[no_mangle]` alone keeps it exported, as `solana-security-txt` does.
#[no_mangle]
pub static SECURITY_TXT: &str = concat!(
    "=======BEGIN SECURITY.TXT V1=======\0",
    "name\0PlayKaboom\0",
    "project_url\0https://www.playkaboom.gg\0",
    "contacts\0link:https://x.com/playkaboomgg\0",
    "policy\0https://github.com/penguinpecker/playkaboom/blob/main/SECURITY.md\0",
    "preferred_languages\0en\0",
    "source_code\0https://github.com/penguinpecker/playkaboom\0",
    "source_revision\0main\0",
    "auditors\0None. Unaudited Pinocchio port\0",
    "acknowledgements\0Thanks to the Neodyme, OtterSec, and Sec3 teams for their public Solana security research.\0",
    "=======END SECURITY.TXT V1=======\0",
);

/// Anchor `EVENT_IX_TAG_LE` (event-cpi off -> 1500).
const EVENT_IX_TAG: u64 = u64::from_le_bytes([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/// Anchor 0.31.1 `entry` + `dispatch`: 4100 on a foreign program id, 101 on data < 8 or an unknown
/// discriminator (the Anchor IDL-management prefix included, decision D6), 1500 on the event tag.
/// Logs `Instruction: <Name>` before running the handler, like Anchor, even if the handler fails.
pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if program_id != &ID {
        return Err(AnchorError::DeclaredProgramIdMismatch.into());
    }
    let Some(d) = data.get(..8) else {
        return Err(AnchorError::InstructionFallbackNotFound.into());
    };
    let d = u64::from_le_bytes(d.try_into().map_err(|_| ProgramError::InvalidInstructionData)?);
    match ix::route(d) {
        Some((log_line, handler)) => {
            helpers::log(log_line);
            handler(accounts, &data[8..])
        }
        None if d == EVENT_IX_TAG => Err(AnchorError::EventInstructionStub.into()),
        None => Err(AnchorError::InstructionFallbackNotFound.into()),
    }
}
