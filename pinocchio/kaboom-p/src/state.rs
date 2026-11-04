//! Account layouts (spec `shared.md` §1) and the Anchor `Account<T>` loader.
//!
//! Every account is `disc[8] ++ borsh(fields)`, packed little-endian, read and written IN PLACE at the
//! absolute offsets below (offsets include the 8-byte discriminator). Never cast pointers to u64/u128:
//! use `rd_*` / `wr_*`, which go through byte arrays and are alignment-safe.

use pinocchio::{error::ProgramError, AccountView};

use crate::consts::{ID, SYSTEM_PROGRAM_ID};
use crate::error::AnchorError;

/// What Anchor's `Account<T>::try_from` checks for one account type.
pub struct AccountType {
    pub disc: [u8; 8],
    /// Shortest data Borsh can decode (`Option` = None). Shorter -> 3003.
    pub min_len: usize,
    /// `(offset, max)` bytes Borsh validates: bool <= 1, `GameStatus` <= 3, `Option` tag <= 1. Bigger -> 3003.
    pub checks: &'static [(usize, u8)],
    /// Offset of an `Option<Pubkey>` tag (0 = none). Tag 1 needs 32 more bytes than `min_len`.
    pub option_tag: usize,
}

/// Anchor `Account<T>::try_from` (deserialize pass, spec `shared.md` §5.3), in Anchor's order:
/// owner System && lamports 0 -> 3012; owner != ID -> 3007; len < 8 -> 3001; disc -> 3002; Borsh -> 3003.
/// Trailing bytes past the Borsh end are accepted, like Anchor.
#[inline(never)]
pub fn load(acc: &AccountView, t: &AccountType) -> Result<(), ProgramError> {
    if acc.lamports() == 0 && acc.owned_by(&SYSTEM_PROGRAM_ID) {
        return Err(AnchorError::AccountNotInitialized.into());
    }
    if !acc.owned_by(&ID) {
        return Err(AnchorError::AccountOwnedByWrongProgram.into());
    }
    let d = acc.try_borrow()?;
    if d.len() < 8 {
        return Err(AnchorError::AccountDiscriminatorNotFound.into());
    }
    if d[..8] != t.disc {
        return Err(AnchorError::AccountDiscriminatorMismatch.into());
    }
    if d.len() < t.min_len {
        return Err(AnchorError::AccountDidNotDeserialize.into());
    }
    for &(off, max) in t.checks {
        if d[off] > max {
            return Err(AnchorError::AccountDidNotDeserialize.into());
        }
    }
    if t.option_tag != 0 && d[t.option_tag] == 1 && d.len() < t.min_len + 32 {
        return Err(AnchorError::AccountDidNotDeserialize.into());
    }
    Ok(())
}

// ─── byte accessors (offsets are absolute; panics only on an out-of-range offset = a port bug) ───
#[inline(always)]
pub fn rd_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(rd_arr(d, o))
}
#[inline(always)]
pub fn rd_u32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(rd_arr(d, o))
}
#[inline(always)]
pub fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(rd_arr(d, o))
}
#[inline(always)]
pub fn rd_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(rd_arr(d, o))
}
#[inline(always)]
pub fn rd_u128(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(rd_arr(d, o))
}
/// 32-byte key / hash at `o`, by reference.
#[inline(always)]
pub fn rd_pk(d: &[u8], o: usize) -> &[u8; 32] {
    let s = &d[o..o + 32];
    // SAFETY: `s` is exactly 32 bytes (the slice above bounds-checks). Avoids `try_into().unwrap()`,
    // which links the Debug/fmt machinery.
    unsafe { &*(s.as_ptr() as *const [u8; 32]) }
}
#[inline(always)]
pub fn rd_arr<const N: usize>(d: &[u8], o: usize) -> [u8; N] {
    let mut b = [0u8; N];
    b.copy_from_slice(&d[o..o + N]);
    b
}
#[inline(always)]
pub fn wr_u16(d: &mut [u8], o: usize, v: u16) {
    d[o..o + 2].copy_from_slice(&v.to_le_bytes());
}
#[inline(always)]
pub fn wr_u32(d: &mut [u8], o: usize, v: u32) {
    d[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
#[inline(always)]
pub fn wr_u64(d: &mut [u8], o: usize, v: u64) {
    d[o..o + 8].copy_from_slice(&v.to_le_bytes());
}
#[inline(always)]
pub fn wr_i64(d: &mut [u8], o: usize, v: i64) {
    d[o..o + 8].copy_from_slice(&v.to_le_bytes());
}
#[inline(always)]
pub fn wr_u128(d: &mut [u8], o: usize, v: u128) {
    d[o..o + 16].copy_from_slice(&v.to_le_bytes());
}
#[inline(always)]
pub fn wr_bytes(d: &mut [u8], o: usize, v: &[u8]) {
    d[o..o + v.len()].copy_from_slice(v);
}

/// `GameSessionV2` (ER-era, not in the IDL): raw reads only, by `admin_close_orphaned_game_v2`
/// (vrf_mode.rs:88-97). SPACE 221; seeds `[b"game_v2", player]`.
pub mod game_session_v2 {
    pub const DISC: [u8; 8] = [0x64, 0x0f, 0xad, 0x57, 0x58, 0xaf, 0xa9, 0x64];
    pub const SPACE: usize = 221;
    pub const BET: usize = 42;
    pub const SETTLED: usize = 112;
    pub const MAX_PAYOUT: usize = 148;
    /// Shortest data the handler accepts (`GAME_V2_MAX_PAYOUT_OFFSET + 8`).
    pub const MIN_RAW_LEN: usize = MAX_PAYOUT + 8;
}

/// Raw-prefix length the VRF raw checks need (`VRF_GAME_MIN_RAW_LEN`, vrf_mode.rs:83).
pub const VRF_GAME_MIN_RAW_LEN: usize = vrf_game::PENDING + 1;

/// (IDL account name, discriminator, SPACE) for the host ABI test.
pub const ACCOUNTS: [(&str, [u8; 8], usize); 8] = [
    ("GameSession", game_session::DISC, game_session::SPACE),
    ("LpPosition", lp_position::DISC, lp_position::SPACE),
    ("PlayerStats", player_stats::DISC, player_stats::SPACE),
    ("ReferralAccount", referral_account::DISC, referral_account::SPACE),
    ("Vault", vault::DISC, vault::SPACE),
    ("VaultV2State", vault_v2_state::DISC, vault_v2_state::SPACE),
    ("VrfClaim", vrf_claim::DISC, vrf_claim::SPACE),
    ("VrfGame", vrf_game::DISC, vrf_game::SPACE),
];

/// `GameSession` field offsets (absolute, disc at 0..8). Borsh, packed, little-endian.
pub mod game_session {
    pub const PLAYER: usize = 8;  // "pubkey" (32)
    pub const BUMP: usize = 40;  // "u8" (1)
    pub const STATUS: usize = 41;  // {"defined": {"name": "GameStatus"}} (1)
    pub const BET: usize = 42;  // "u64" (8)
    pub const MINE_COUNT: usize = 50;  // "u8" (1)
    pub const COMMITMENT: usize = 51;  // {"array": ["u8", 32]} (32)
    pub const REVEALED_MASK: usize = 83;  // "u16" (2)
    pub const REVEALED_SAFE_MASK: usize = 85;  // "u16" (2)
    pub const SAFE_REVEALS: usize = 87;  // "u8" (1)
    pub const MULTIPLIER_BPS: usize = 88;  // "u64" (8)
    pub const START_SLOT: usize = 96;  // "u64" (8)
    pub const CREATED_AT: usize = 104;  // "i64" (8)
    pub const SETTLED: usize = 112;  // "bool" (1)
    pub const MINE_LAYOUT: usize = 113;  // "u16" (2)
    pub const SALT: usize = 115;  // {"array": ["u8", 32]} (32)
    pub const VERSION: usize = 147;  // "u8" (1)
    pub const MAX_PAYOUT: usize = 148;  // "u64" (8)
    pub const RESERVED: usize = 156;  // {"array": ["u8", 24]} (24)
    /// serialized end == allocated space
    pub const END: usize = 180;
    pub const DISC: [u8; 8] = [0x96, 0x74, 0x14, 0xc5, 0xcd, 0x79, 0xdc, 0xf0];
    /// allocated size (`SPACE` / `8 + SIZE` in the Anchor source)
    pub const SPACE: usize = 180;
    pub const TYPE: super::AccountType = super::AccountType {
        disc: DISC,
        min_len: 180,
        checks: &[(STATUS, 3), (SETTLED, 1)],
        option_tag: 0,
    };
}

/// `LpPosition` field offsets (absolute, disc at 0..8). Borsh, packed, little-endian.
pub mod lp_position {
    pub const USER: usize = 8;  // "pubkey" (32)
    pub const UNITS: usize = 40;  // "u128" (16)
    pub const PENDING_UNITS: usize = 56;  // "u128" (16)
    pub const PENDING_UNLOCK_SLOT: usize = 72;  // "u64" (8)
    pub const CREATED_SLOT: usize = 80;  // "u64" (8)
    pub const BUMP: usize = 88;  // "u8" (1)
    pub const RESERVED: usize = 89;  // {"array": ["u8", 32]} (32)
    /// serialized end == allocated space
    pub const END: usize = 121;
    pub const DISC: [u8; 8] = [0x69, 0xf1, 0x25, 0xc8, 0xe0, 0x02, 0xfc, 0x5a];
    /// allocated size (`SPACE` / `8 + SIZE` in the Anchor source)
    pub const SPACE: usize = 121;
    pub const TYPE: super::AccountType = super::AccountType {
        disc: DISC,
        min_len: 121,
        checks: &[],
        option_tag: 0,
    };
}

/// `PlayerStats` field offsets (absolute, disc at 0..8). Borsh, packed, little-endian.
pub mod player_stats {
    pub const PLAYER: usize = 8;  // "pubkey" (32)
    pub const BUMP: usize = 40;  // "u8" (1)
    pub const VERSION: usize = 41;  // "u8" (1)
    pub const GAMES_PLAYED: usize = 42;  // "u64" (8)
    pub const GAMES_WON: usize = 50;  // "u64" (8)
    pub const TOTAL_WAGERED: usize = 58;  // "u64" (8)
    pub const TOTAL_PAYOUTS: usize = 66;  // "u64" (8)
    pub const BIGGEST_WIN: usize = 74;  // "u64" (8)
    pub const BIGGEST_MULTIPLIER_BPS: usize = 82;  // "u64" (8)
    pub const CURRENT_STREAK: usize = 90;  // "u32" (4)
    pub const BEST_STREAK: usize = 94;  // "u32" (4)
    pub const LAST_PLAYED: usize = 98;  // "i64" (8)
    /// `Option<Pubkey>` tag byte (0 = None, 1 = Some).
    pub const REFERRER_TAG: usize = 106;
    /// key bytes, valid only when the tag is 1.
    pub const REFERRER: usize = 107;
    pub const RESERVED: usize = 139;  // {"array": ["u8", 64]} (64)
    /// serialized end == allocated space
    pub const END: usize = 203;
    pub const DISC: [u8; 8] = [0xa9, 0x92, 0xf2, 0xb0, 0x66, 0x76, 0xe7, 0xac];
    /// allocated size (`SPACE` / `8 + SIZE` in the Anchor source)
    pub const SPACE: usize = 203;
    pub const TYPE: super::AccountType = super::AccountType {
        disc: DISC,
        min_len: 171,
        checks: &[(REFERRER_TAG, 1)],
        option_tag: REFERRER_TAG,
    };
}

/// `ReferralAccount` field offsets (absolute, disc at 0..8). Borsh, packed, little-endian.
pub mod referral_account {
    pub const REFERRER: usize = 8;  // "pubkey" (32)
    pub const BUMP: usize = 40;  // "u8" (1)
    pub const VERSION: usize = 41;  // "u8" (1)
    pub const TIER: usize = 42;  // "u8" (1)
    pub const ACCRUED_LAMPORTS: usize = 43;  // "u64" (8)
    pub const TOTAL_EARNED: usize = 51;  // "u64" (8)
    pub const REFERRED_COUNT: usize = 59;  // "u32" (4)
    pub const REFERRED_VOLUME: usize = 63;  // "u64" (8)
    pub const RESERVED: usize = 71;  // {"array": ["u8", 32]} (32)
    /// serialized end == allocated space
    pub const END: usize = 103;
    pub const DISC: [u8; 8] = [0xed, 0xa2, 0x50, 0x4e, 0xc4, 0xe9, 0x5b, 0x02];
    /// allocated size (`SPACE` / `8 + SIZE` in the Anchor source)
    pub const SPACE: usize = 103;
    pub const TYPE: super::AccountType = super::AccountType {
        disc: DISC,
        min_len: 103,
        checks: &[],
        option_tag: 0,
    };
}

/// `Vault` field offsets (absolute, disc at 0..8). Borsh, packed, little-endian.
pub mod vault {
    pub const OWNER: usize = 8;  // "pubkey" (32)
    pub const HOUSE_AUTHORITY: usize = 40;  // "pubkey" (32)
    pub const TREASURY: usize = 72;  // "pubkey" (32)
    pub const BUMP: usize = 104;  // "u8" (1)
    pub const HOUSE_EDGE_BPS: usize = 105;  // "u16" (2)
    pub const MAX_BET_BPS: usize = 107;  // "u16" (2)
    pub const MAX_PAYOUT_BPS: usize = 109;  // "u16" (2)
    pub const TREASURY_SPLIT_BPS: usize = 111;  // "u16" (2)
    pub const TOTAL_GAMES: usize = 113;  // "u64" (8)
    pub const TOTAL_WAGERED: usize = 121;  // "u64" (8)
    pub const TOTAL_PAYOUTS: usize = 129;  // "u64" (8)
    pub const PAUSED: usize = 137;  // "bool" (1)
    pub const VERSION: usize = 138;  // "u8" (1)
    pub const ALLOWLIST_COUNT: usize = 139;  // "u8" (1)
    pub const WITHDRAW_ALLOWLIST: usize = 140;  // {"array": ["pubkey", 8]} (256)
    pub const PENDING_OWNER: usize = 396;  // "pubkey" (32)
    /// serialized end == allocated space
    pub const END: usize = 428;
    pub const DISC: [u8; 8] = [0xd3, 0x08, 0xe8, 0x2b, 0x02, 0x98, 0x75, 0x77];
    /// allocated size (`SPACE` / `8 + SIZE` in the Anchor source)
    pub const SPACE: usize = 428;
    pub const TYPE: super::AccountType = super::AccountType {
        disc: DISC,
        min_len: 428,
        checks: &[(PAUSED, 1)],
        option_tag: 0,
    };
}

/// `VaultV2State` field offsets (absolute, disc at 0..8). Borsh, packed, little-endian.
pub mod vault_v2_state {
    pub const BUMP: usize = 8;  // "u8" (1)
    pub const TOTAL_OUTSTANDING_MAX_PAYOUT: usize = 9;  // "u64" (8)
    pub const TOTAL_UNITS: usize = 17;  // "u128" (16)
    pub const HOUSE_UNITS: usize = 33;  // "u128" (16)
    pub const HOUSE_PENDING_UNITS: usize = 49;  // "u128" (16)
    pub const HOUSE_PENDING_UNLOCK_SLOT: usize = 65;  // "u64" (8)
    pub const SEED_UNITS: usize = 73;  // "u128" (16)
    pub const TOTAL_PENDING_UNITS: usize = 89;  // "u128" (16)
    pub const MIN_HOUSE_SHARE_BPS: usize = 105;  // "u16" (2)
    pub const MAX_USER_POSITION_BPS: usize = 107;  // "u16" (2)
    pub const MIN_HEALTH_BPS: usize = 109;  // "u16" (2)
    pub const WITHDRAW_COOLDOWN_SLOTS: usize = 111;  // "u64" (8)
    pub const MIN_LP_DEPOSIT: usize = 119;  // "u64" (8)
    pub const VRF_MODE_ENABLED: usize = 127;  // "bool" (1)
    pub const VRF_VALIDATOR: usize = 128;  // "pubkey" (32)
    pub const VRF_MAX_PAYOUT_BPS: usize = 160;  // "u16" (2)
    pub const RESERVED: usize = 162;  // {"array": ["u8", 29]} (29)
    /// serialized end == allocated space
    pub const END: usize = 191;
    pub const DISC: [u8; 8] = [0xee, 0xfc, 0xda, 0xfd, 0x59, 0x66, 0x44, 0x5e];
    /// allocated size (`SPACE` / `8 + SIZE` in the Anchor source)
    pub const SPACE: usize = 191;
    pub const TYPE: super::AccountType = super::AccountType {
        disc: DISC,
        min_len: 191,
        checks: &[(VRF_MODE_ENABLED, 1)],
        option_tag: 0,
    };
}

/// `VrfClaim` field offsets (absolute, disc at 0..8). Borsh, packed, little-endian.
pub mod vrf_claim {
    pub const PLAYER: usize = 8;  // "pubkey" (32)
    pub const BET: usize = 40;  // "u64" (8)
    pub const RESERVED: usize = 48;  // "u64" (8)
    pub const MINE_COUNT: usize = 56;  // "u8" (1)
    pub const HOUSE_EDGE_BPS: usize = 57;  // "u16" (2)
    pub const START_SLOT: usize = 59;  // "u64" (8)
    pub const SETTLED: usize = 67;  // "bool" (1)
    pub const BUMP: usize = 68;  // "u8" (1)
    /// serialized end == allocated space
    pub const END: usize = 69;
    pub const DISC: [u8; 8] = [0xeb, 0xb3, 0xfd, 0x77, 0x39, 0xe5, 0x46, 0xdf];
    /// allocated size (`SPACE` / `8 + SIZE` in the Anchor source)
    pub const SPACE: usize = 69;
    pub const TYPE: super::AccountType = super::AccountType {
        disc: DISC,
        min_len: 69,
        checks: &[(SETTLED, 1)],
        option_tag: 0,
    };
}

/// `VrfGame` field offsets (absolute, disc at 0..8). Borsh, packed, little-endian.
pub mod vrf_game {
    pub const STATUS: usize = 8;  // "u8" (1)
    pub const PLAYER: usize = 9;  // "pubkey" (32)
    pub const SESSION_KEY: usize = 41;  // "pubkey" (32)
    pub const BUMP: usize = 73;  // "u8" (1)
    pub const MINE_COUNT: usize = 74;  // "u8" (1)
    pub const HOUSE_EDGE_BPS: usize = 75;  // "u16" (2)
    pub const SAFE_REVEALS: usize = 77;  // "u8" (1)
    pub const REVEAL_COUNT: usize = 78;  // "u8" (1)
    pub const PENDING: usize = 79;  // "bool" (1)
    pub const PENDING_TILE: usize = 80;  // "u8" (1)
    pub const REVEALED_MASK: usize = 81;  // "u16" (2)
    pub const MINE_MASK: usize = 83;  // "u16" (2)
    pub const MULTIPLIER_BPS: usize = 85;  // "u64" (8)
    pub const REVEALS: usize = 93;  // {"array": [{"defined": {"name": "VrfReveal"}}, 16]} (528)
    /// serialized end == allocated space
    pub const END: usize = 621;
    pub const DISC: [u8; 8] = [0xe9, 0x24, 0x15, 0xe3, 0xfd, 0x87, 0xfa, 0x04];
    /// allocated size (`SPACE` / `8 + SIZE` in the Anchor source)
    pub const SPACE: usize = 621;
    /// `VrfReveal` = tile u8 + randomness [u8; 32]; `reveals[i]` starts at `REVEALS + REVEAL_SIZE * i`.
    pub const REVEAL_SIZE: usize = 33;
    pub const TYPE: super::AccountType = super::AccountType {
        disc: DISC,
        min_len: 621,
        checks: &[(PENDING, 1)],
        option_tag: 0,
    };
}
