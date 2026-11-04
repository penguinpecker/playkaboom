//! Events (spec `shared.md` §2): `sol_log_data(&[disc ++ borsh(event)])` with ONE slice, exactly like
//! Anchor 0.31.1 `emit!`, so the runtime prints `Program data: <base64>`.
//!
//! Usage: `emit(&events::game_won(&player, &game, bet, payout, mult, safe, slot));`
//! Pubkeys are `&[u8; 32]` (`acc.address().as_array()` or `state::rd_pk(&data, off)`).
//! Call `emit` from the handler itself (top invoke frame), never between CPIs that should precede it.

/// Log one event buffer (one `sol_log_data` slice).
#[inline(never)]
pub fn emit(data: &[u8]) {
    #[cfg(target_os = "solana")]
    unsafe {
        let s: [&[u8]; 1] = [data];
        pinocchio::syscalls::sol_log_data(s.as_ptr() as *const u8, 1);
    }
    #[cfg(not(target_os = "solana"))]
    let _ = data;
}

/// `AllowlistChanged` (81 bytes incl. disc). Fields in IDL order.
pub const ALLOWLIST_CHANGED: [u8; 8] = [0xbc, 0xd3, 0x68, 0x37, 0x29, 0xaa, 0x53, 0x2f];
#[inline(always)]
pub fn allowlist_changed(vault: &[u8; 32], address: &[u8; 32], added: bool, slot: u64) -> [u8; 81] {
    let mut b = [0u8; 81];
    b[..8].copy_from_slice(&ALLOWLIST_CHANGED);
    b[8..40].copy_from_slice(vault);
    b[40..72].copy_from_slice(address);
    b[72..73].copy_from_slice(&[added as u8]);
    b[73..81].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `GameLost` (90 bytes incl. disc). Fields in IDL order.
pub const GAME_LOST: [u8; 8] = [0xc8, 0xa1, 0xe2, 0xe3, 0x0b, 0x81, 0xfa, 0x9f];
#[inline(always)]
pub fn game_lost(player: &[u8; 32], game: &[u8; 32], bet: u64, tile_index: u8, safe_reveals: u8, slot: u64) -> [u8; 90] {
    let mut b = [0u8; 90];
    b[..8].copy_from_slice(&GAME_LOST);
    b[8..40].copy_from_slice(player);
    b[40..72].copy_from_slice(game);
    b[72..80].copy_from_slice(&bet.to_le_bytes());
    b[80..81].copy_from_slice(&tile_index.to_le_bytes());
    b[81..82].copy_from_slice(&safe_reveals.to_le_bytes());
    b[82..90].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `GameRefunded` (96 bytes incl. disc). Fields in IDL order.
pub const GAME_REFUNDED: [u8; 8] = [0x38, 0x6f, 0x18, 0xd1, 0xf3, 0xa5, 0x55, 0xff];
#[inline(always)]
pub fn game_refunded(player: &[u8; 32], game: &[u8; 32], bet: u64, refund: u64, slot: u64) -> [u8; 96] {
    let mut b = [0u8; 96];
    b[..8].copy_from_slice(&GAME_REFUNDED);
    b[8..40].copy_from_slice(player);
    b[40..72].copy_from_slice(game);
    b[72..80].copy_from_slice(&bet.to_le_bytes());
    b[80..88].copy_from_slice(&refund.to_le_bytes());
    b[88..96].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `GameSettled` (148 bytes incl. disc). Fields in IDL order.
pub const GAME_SETTLED: [u8; 8] = [0x3f, 0x6d, 0x80, 0x55, 0xe5, 0x3f, 0xa7, 0xb0];
#[inline(always)]
pub fn game_settled(player: &[u8; 32], game: &[u8; 32], mine_count: u8, mine_layout: u16, salt: &[u8; 32], commitment: &[u8; 32], verified: bool, slot: u64) -> [u8; 148] {
    let mut b = [0u8; 148];
    b[..8].copy_from_slice(&GAME_SETTLED);
    b[8..40].copy_from_slice(player);
    b[40..72].copy_from_slice(game);
    b[72..73].copy_from_slice(&mine_count.to_le_bytes());
    b[73..75].copy_from_slice(&mine_layout.to_le_bytes());
    b[75..107].copy_from_slice(salt);
    b[107..139].copy_from_slice(commitment);
    b[139..140].copy_from_slice(&[verified as u8]);
    b[140..148].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `GameStarted` (121 bytes incl. disc). Fields in IDL order.
pub const GAME_STARTED: [u8; 8] = [0xde, 0xf7, 0x4e, 0xff, 0x3d, 0xb8, 0x9c, 0x29];
#[inline(always)]
pub fn game_started(player: &[u8; 32], game: &[u8; 32], bet: u64, mine_count: u8, commitment: &[u8; 32], slot: u64) -> [u8; 121] {
    let mut b = [0u8; 121];
    b[..8].copy_from_slice(&GAME_STARTED);
    b[8..40].copy_from_slice(player);
    b[40..72].copy_from_slice(game);
    b[72..80].copy_from_slice(&bet.to_le_bytes());
    b[80..81].copy_from_slice(&mine_count.to_le_bytes());
    b[81..113].copy_from_slice(commitment);
    b[113..121].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `GameWon` (105 bytes incl. disc). Fields in IDL order.
pub const GAME_WON: [u8; 8] = [0xa0, 0xc6, 0xea, 0xc1, 0xe3, 0x80, 0x66, 0xc7];
#[inline(always)]
pub fn game_won(player: &[u8; 32], game: &[u8; 32], bet: u64, payout: u64, multiplier_bps: u64, safe_reveals: u8, slot: u64) -> [u8; 105] {
    let mut b = [0u8; 105];
    b[..8].copy_from_slice(&GAME_WON);
    b[8..40].copy_from_slice(player);
    b[40..72].copy_from_slice(game);
    b[72..80].copy_from_slice(&bet.to_le_bytes());
    b[80..88].copy_from_slice(&payout.to_le_bytes());
    b[88..96].copy_from_slice(&multiplier_bps.to_le_bytes());
    b[96..97].copy_from_slice(&safe_reveals.to_le_bytes());
    b[97..105].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `HouseDeposited` (56 bytes incl. disc). Fields in IDL order.
pub const HOUSE_DEPOSITED: [u8; 8] = [0xad, 0x71, 0xd7, 0x1a, 0xe5, 0x1b, 0xa3, 0xe7];
#[inline(always)]
pub fn house_deposited(amount_lamports: u64, units_minted: u128, total_units_after: u128, slot: u64) -> [u8; 56] {
    let mut b = [0u8; 56];
    b[..8].copy_from_slice(&HOUSE_DEPOSITED);
    b[8..16].copy_from_slice(&amount_lamports.to_le_bytes());
    b[16..32].copy_from_slice(&units_minted.to_le_bytes());
    b[32..48].copy_from_slice(&total_units_after.to_le_bytes());
    b[48..56].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `HouseWithdrawCancelled` (32 bytes incl. disc). Fields in IDL order.
pub const HOUSE_WITHDRAW_CANCELLED: [u8; 8] = [0xac, 0xb8, 0xbf, 0xfa, 0xbd, 0xa9, 0x10, 0x54];
#[inline(always)]
pub fn house_withdraw_cancelled(units_returned: u128, slot: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[..8].copy_from_slice(&HOUSE_WITHDRAW_CANCELLED);
    b[8..24].copy_from_slice(&units_returned.to_le_bytes());
    b[24..32].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `HouseWithdrawCompleted` (40 bytes incl. disc). Fields in IDL order.
pub const HOUSE_WITHDRAW_COMPLETED: [u8; 8] = [0xcd, 0xb3, 0x18, 0x82, 0xb1, 0xc9, 0xba, 0x09];
#[inline(always)]
pub fn house_withdraw_completed(units_burned: u128, amount_lamports: u64, slot: u64) -> [u8; 40] {
    let mut b = [0u8; 40];
    b[..8].copy_from_slice(&HOUSE_WITHDRAW_COMPLETED);
    b[8..24].copy_from_slice(&units_burned.to_le_bytes());
    b[24..32].copy_from_slice(&amount_lamports.to_le_bytes());
    b[32..40].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `HouseWithdrawRequested` (40 bytes incl. disc). Fields in IDL order.
pub const HOUSE_WITHDRAW_REQUESTED: [u8; 8] = [0xfe, 0x1e, 0x16, 0x3f, 0x06, 0x6d, 0x77, 0x00];
#[inline(always)]
pub fn house_withdraw_requested(units: u128, unlock_slot: u64, slot: u64) -> [u8; 40] {
    let mut b = [0u8; 40];
    b[..8].copy_from_slice(&HOUSE_WITHDRAW_REQUESTED);
    b[8..24].copy_from_slice(&units.to_le_bytes());
    b[24..32].copy_from_slice(&unlock_slot.to_le_bytes());
    b[32..40].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `LpDeposited` (96 bytes incl. disc). Fields in IDL order.
pub const LP_DEPOSITED: [u8; 8] = [0x55, 0xd3, 0xb8, 0x9f, 0xb0, 0xe0, 0x1c, 0x48];
#[inline(always)]
pub fn lp_deposited(user: &[u8; 32], amount_lamports: u64, units_minted: u128, total_units_after: u128, vault_assets_after: u64, slot: u64) -> [u8; 96] {
    let mut b = [0u8; 96];
    b[..8].copy_from_slice(&LP_DEPOSITED);
    b[8..40].copy_from_slice(user);
    b[40..48].copy_from_slice(&amount_lamports.to_le_bytes());
    b[48..64].copy_from_slice(&units_minted.to_le_bytes());
    b[64..80].copy_from_slice(&total_units_after.to_le_bytes());
    b[80..88].copy_from_slice(&vault_assets_after.to_le_bytes());
    b[88..96].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `LpPositionClosed` (48 bytes incl. disc). Fields in IDL order.
pub const LP_POSITION_CLOSED: [u8; 8] = [0xd9, 0x0f, 0xfa, 0xcc, 0xd6, 0x5a, 0xcc, 0x30];
#[inline(always)]
pub fn lp_position_closed(user: &[u8; 32], slot: u64) -> [u8; 48] {
    let mut b = [0u8; 48];
    b[..8].copy_from_slice(&LP_POSITION_CLOSED);
    b[8..40].copy_from_slice(user);
    b[40..48].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `LpWithdrawCancelled` (64 bytes incl. disc). Fields in IDL order.
pub const LP_WITHDRAW_CANCELLED: [u8; 8] = [0xd0, 0x0a, 0x6e, 0x73, 0xea, 0x9e, 0x56, 0x7d];
#[inline(always)]
pub fn lp_withdraw_cancelled(user: &[u8; 32], units_returned: u128, slot: u64) -> [u8; 64] {
    let mut b = [0u8; 64];
    b[..8].copy_from_slice(&LP_WITHDRAW_CANCELLED);
    b[8..40].copy_from_slice(user);
    b[40..56].copy_from_slice(&units_returned.to_le_bytes());
    b[56..64].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `LpWithdrawCompleted` (96 bytes incl. disc). Fields in IDL order.
pub const LP_WITHDRAW_COMPLETED: [u8; 8] = [0x7b, 0x1e, 0xbe, 0x2f, 0xe2, 0xc1, 0x1c, 0x53];
#[inline(always)]
pub fn lp_withdraw_completed(user: &[u8; 32], units_burned: u128, amount_lamports: u64, total_units_after: u128, vault_assets_after: u64, slot: u64) -> [u8; 96] {
    let mut b = [0u8; 96];
    b[..8].copy_from_slice(&LP_WITHDRAW_COMPLETED);
    b[8..40].copy_from_slice(user);
    b[40..56].copy_from_slice(&units_burned.to_le_bytes());
    b[56..64].copy_from_slice(&amount_lamports.to_le_bytes());
    b[64..80].copy_from_slice(&total_units_after.to_le_bytes());
    b[80..88].copy_from_slice(&vault_assets_after.to_le_bytes());
    b[88..96].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `LpWithdrawRequested` (72 bytes incl. disc). Fields in IDL order.
pub const LP_WITHDRAW_REQUESTED: [u8; 8] = [0xbf, 0xe9, 0xde, 0x83, 0xe9, 0x7a, 0xaa, 0x1a];
#[inline(always)]
pub fn lp_withdraw_requested(user: &[u8; 32], units: u128, unlock_slot: u64, slot: u64) -> [u8; 72] {
    let mut b = [0u8; 72];
    b[..8].copy_from_slice(&LP_WITHDRAW_REQUESTED);
    b[8..40].copy_from_slice(user);
    b[40..56].copy_from_slice(&units.to_le_bytes());
    b[56..64].copy_from_slice(&unlock_slot.to_le_bytes());
    b[64..72].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `OperatorUnitsUnlocked` (136 bytes incl. disc). Fields in IDL order.
pub const OPERATOR_UNITS_UNLOCKED: [u8; 8] = [0xf5, 0x86, 0x17, 0xc7, 0x83, 0x74, 0xfb, 0xe5];
#[inline(always)]
pub fn operator_units_unlocked(vault: &[u8; 32], destination: &[u8; 32], lamports: u64, burned_seed: u128, burned_house: u128, burned_pending: u128, slot: u64) -> [u8; 136] {
    let mut b = [0u8; 136];
    b[..8].copy_from_slice(&OPERATOR_UNITS_UNLOCKED);
    b[8..40].copy_from_slice(vault);
    b[40..72].copy_from_slice(destination);
    b[72..80].copy_from_slice(&lamports.to_le_bytes());
    b[80..96].copy_from_slice(&burned_seed.to_le_bytes());
    b[96..112].copy_from_slice(&burned_house.to_le_bytes());
    b[112..128].copy_from_slice(&burned_pending.to_le_bytes());
    b[128..136].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `OwnerAccepted` (112 bytes incl. disc). Fields in IDL order.
pub const OWNER_ACCEPTED: [u8; 8] = [0x73, 0x31, 0x41, 0xb7, 0x48, 0x7b, 0x29, 0x8b];
#[inline(always)]
pub fn owner_accepted(vault: &[u8; 32], old_owner: &[u8; 32], new_owner: &[u8; 32], slot: u64) -> [u8; 112] {
    let mut b = [0u8; 112];
    b[..8].copy_from_slice(&OWNER_ACCEPTED);
    b[8..40].copy_from_slice(vault);
    b[40..72].copy_from_slice(old_owner);
    b[72..104].copy_from_slice(new_owner);
    b[104..112].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `OwnerProposalCancelled` (48 bytes incl. disc). Fields in IDL order.
pub const OWNER_PROPOSAL_CANCELLED: [u8; 8] = [0x2a, 0xa4, 0x69, 0x5d, 0x77, 0xb3, 0x59, 0xe9];
#[inline(always)]
pub fn owner_proposal_cancelled(vault: &[u8; 32], slot: u64) -> [u8; 48] {
    let mut b = [0u8; 48];
    b[..8].copy_from_slice(&OWNER_PROPOSAL_CANCELLED);
    b[8..40].copy_from_slice(vault);
    b[40..48].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `OwnerProposed` (112 bytes incl. disc). Fields in IDL order.
pub const OWNER_PROPOSED: [u8; 8] = [0x4c, 0x62, 0xc0, 0x1e, 0x44, 0x30, 0x2b, 0xbc];
#[inline(always)]
pub fn owner_proposed(vault: &[u8; 32], current_owner: &[u8; 32], proposed_owner: &[u8; 32], slot: u64) -> [u8; 112] {
    let mut b = [0u8; 112];
    b[..8].copy_from_slice(&OWNER_PROPOSED);
    b[8..40].copy_from_slice(vault);
    b[40..72].copy_from_slice(current_owner);
    b[72..104].copy_from_slice(proposed_owner);
    b[104..112].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `ReferralAccrued` (89 bytes incl. disc). Fields in IDL order.
pub const REFERRAL_ACCRUED: [u8; 8] = [0x4a, 0x5d, 0x2e, 0x8e, 0x80, 0x41, 0x19, 0xfe];
#[inline(always)]
pub fn referral_accrued(referrer: &[u8; 32], player: &[u8; 32], amount: u64, tier: u8, slot: u64) -> [u8; 89] {
    let mut b = [0u8; 89];
    b[..8].copy_from_slice(&REFERRAL_ACCRUED);
    b[8..40].copy_from_slice(referrer);
    b[40..72].copy_from_slice(player);
    b[72..80].copy_from_slice(&amount.to_le_bytes());
    b[80..81].copy_from_slice(&tier.to_le_bytes());
    b[81..89].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `ReferralClaimed` (56 bytes incl. disc). Fields in IDL order.
pub const REFERRAL_CLAIMED: [u8; 8] = [0xc3, 0x6d, 0x4d, 0xc4, 0x86, 0xe2, 0x4e, 0x6c];
#[inline(always)]
pub fn referral_claimed(referrer: &[u8; 32], amount: u64, slot: u64) -> [u8; 56] {
    let mut b = [0u8; 56];
    b[..8].copy_from_slice(&REFERRAL_CLAIMED);
    b[8..40].copy_from_slice(referrer);
    b[40..48].copy_from_slice(&amount.to_le_bytes());
    b[48..56].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `ReferralRepaired` (48 bytes incl. disc). Fields in IDL order.
pub const REFERRAL_REPAIRED: [u8; 8] = [0x9a, 0x45, 0x0a, 0x63, 0x5a, 0x86, 0x07, 0xc1];
#[inline(always)]
pub fn referral_repaired(referrer: &[u8; 32], slot: u64) -> [u8; 48] {
    let mut b = [0u8; 48];
    b[..8].copy_from_slice(&REFERRAL_REPAIRED);
    b[8..40].copy_from_slice(referrer);
    b[40..48].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `ReferralTierChanged` (49 bytes incl. disc). Fields in IDL order.
pub const REFERRAL_TIER_CHANGED: [u8; 8] = [0x15, 0x7e, 0xc4, 0x25, 0xdc, 0x67, 0xd7, 0xf1];
#[inline(always)]
pub fn referral_tier_changed(referrer: &[u8; 32], new_tier: u8, slot: u64) -> [u8; 49] {
    let mut b = [0u8; 49];
    b[..8].copy_from_slice(&REFERRAL_TIER_CHANGED);
    b[8..40].copy_from_slice(referrer);
    b[40..41].copy_from_slice(&new_tier.to_le_bytes());
    b[41..49].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `ReferrerSet` (80 bytes incl. disc). Fields in IDL order.
pub const REFERRER_SET: [u8; 8] = [0x41, 0xbb, 0x1d, 0xcd, 0x74, 0xe5, 0x45, 0x9a];
#[inline(always)]
pub fn referrer_set(player: &[u8; 32], referrer: &[u8; 32], slot: u64) -> [u8; 80] {
    let mut b = [0u8; 80];
    b[..8].copy_from_slice(&REFERRER_SET);
    b[8..40].copy_from_slice(player);
    b[40..72].copy_from_slice(referrer);
    b[72..80].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `StatsUpdated` (92 bytes incl. disc). Fields in IDL order.
pub const STATS_UPDATED: [u8; 8] = [0x32, 0x90, 0x3e, 0x26, 0x8c, 0x94, 0x75, 0x3e];
#[inline(always)]
pub fn stats_updated(player: &[u8; 32], games_played: u64, games_won: u64, total_wagered: u64, total_payouts: u64, biggest_win: u64, current_streak: u32, slot: u64) -> [u8; 92] {
    let mut b = [0u8; 92];
    b[..8].copy_from_slice(&STATS_UPDATED);
    b[8..40].copy_from_slice(player);
    b[40..48].copy_from_slice(&games_played.to_le_bytes());
    b[48..56].copy_from_slice(&games_won.to_le_bytes());
    b[56..64].copy_from_slice(&total_wagered.to_le_bytes());
    b[64..72].copy_from_slice(&total_payouts.to_le_bytes());
    b[72..80].copy_from_slice(&biggest_win.to_le_bytes());
    b[80..84].copy_from_slice(&current_streak.to_le_bytes());
    b[84..92].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `TileRevealed` (91 bytes incl. disc). Fields in IDL order.
pub const TILE_REVEALED: [u8; 8] = [0xe8, 0xb0, 0x81, 0x36, 0x96, 0x9e, 0x8f, 0xb7];
#[inline(always)]
pub fn tile_revealed(player: &[u8; 32], game: &[u8; 32], tile_index: u8, is_mine: bool, multiplier_bps: u64, safe_reveals: u8, slot: u64) -> [u8; 91] {
    let mut b = [0u8; 91];
    b[..8].copy_from_slice(&TILE_REVEALED);
    b[8..40].copy_from_slice(player);
    b[40..72].copy_from_slice(game);
    b[72..73].copy_from_slice(&tile_index.to_le_bytes());
    b[73..74].copy_from_slice(&[is_mine as u8]);
    b[74..82].copy_from_slice(&multiplier_bps.to_le_bytes());
    b[82..83].copy_from_slice(&safe_reveals.to_le_bytes());
    b[83..91].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `TreasuryAccrued` (128 bytes incl. disc). Fields in IDL order.
pub const TREASURY_ACCRUED: [u8; 8] = [0x56, 0xd8, 0x45, 0xa7, 0xa2, 0xae, 0xb5, 0x47];
#[inline(always)]
pub fn treasury_accrued(vault: &[u8; 32], treasury: &[u8; 32], from_game: &[u8; 32], bet: u64, amount: u64, slot: u64) -> [u8; 128] {
    let mut b = [0u8; 128];
    b[..8].copy_from_slice(&TREASURY_ACCRUED);
    b[8..40].copy_from_slice(vault);
    b[40..72].copy_from_slice(treasury);
    b[72..104].copy_from_slice(from_game);
    b[104..112].copy_from_slice(&bet.to_le_bytes());
    b[112..120].copy_from_slice(&amount.to_le_bytes());
    b[120..128].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `TreasuryWithdrawal` (88 bytes incl. disc). Fields in IDL order.
pub const TREASURY_WITHDRAWAL: [u8; 8] = [0xf4, 0x75, 0xaf, 0x2e, 0xbb, 0x6d, 0x14, 0x10];
#[inline(always)]
pub fn treasury_withdrawal(treasury: &[u8; 32], destination: &[u8; 32], amount: u64, slot: u64) -> [u8; 88] {
    let mut b = [0u8; 88];
    b[..8].copy_from_slice(&TREASURY_WITHDRAWAL);
    b[8..40].copy_from_slice(treasury);
    b[40..72].copy_from_slice(destination);
    b[72..80].copy_from_slice(&amount.to_le_bytes());
    b[80..88].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `V2ConfigUpdated` (48 bytes incl. disc). Fields in IDL order.
pub const V2_CONFIG_UPDATED: [u8; 8] = [0x07, 0x0e, 0x33, 0x95, 0xb4, 0xfc, 0x25, 0xa2];
#[inline(always)]
pub fn v2_config_updated(vault: &[u8; 32], slot: u64) -> [u8; 48] {
    let mut b = [0u8; 48];
    b[..8].copy_from_slice(&V2_CONFIG_UPDATED);
    b[8..40].copy_from_slice(vault);
    b[40..48].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `V2Initialized` (96 bytes incl. disc). Fields in IDL order.
pub const V2_INITIALIZED: [u8; 8] = [0x22, 0xd5, 0x7f, 0xc5, 0x3d, 0xf9, 0x36, 0xd4];
#[inline(always)]
pub fn v2_initialized(vault: &[u8; 32], seed_units: u128, house_units: u128, total_units: u128, slot: u64) -> [u8; 96] {
    let mut b = [0u8; 96];
    b[..8].copy_from_slice(&V2_INITIALIZED);
    b[8..40].copy_from_slice(vault);
    b[40..56].copy_from_slice(&seed_units.to_le_bytes());
    b[56..72].copy_from_slice(&house_units.to_le_bytes());
    b[72..88].copy_from_slice(&total_units.to_le_bytes());
    b[88..96].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `VaultFunded` (64 bytes incl. disc). Fields in IDL order.
pub const VAULT_FUNDED: [u8; 8] = [0xc0, 0x77, 0xf5, 0xc1, 0x37, 0xdf, 0xc3, 0x32];
#[inline(always)]
pub fn vault_funded(funder: &[u8; 32], amount: u64, new_balance: u64, slot: u64) -> [u8; 64] {
    let mut b = [0u8; 64];
    b[..8].copy_from_slice(&VAULT_FUNDED);
    b[8..40].copy_from_slice(funder);
    b[40..48].copy_from_slice(&amount.to_le_bytes());
    b[48..56].copy_from_slice(&new_balance.to_le_bytes());
    b[56..64].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `VaultInitialized` (144 bytes incl. disc). Fields in IDL order.
pub const VAULT_INITIALIZED: [u8; 8] = [0xb4, 0x2b, 0xcf, 0x02, 0x12, 0x47, 0x03, 0x4b];
#[inline(always)]
pub fn vault_initialized(vault: &[u8; 32], owner: &[u8; 32], house_authority: &[u8; 32], treasury: &[u8; 32], slot: u64) -> [u8; 144] {
    let mut b = [0u8; 144];
    b[..8].copy_from_slice(&VAULT_INITIALIZED);
    b[8..40].copy_from_slice(vault);
    b[40..72].copy_from_slice(owner);
    b[72..104].copy_from_slice(house_authority);
    b[104..136].copy_from_slice(treasury);
    b[136..144].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `VaultUnitValueUpdated` (74 bytes incl. disc). Fields in IDL order.
pub const VAULT_UNIT_VALUE_UPDATED: [u8; 8] = [0x7f, 0xd9, 0x88, 0x1b, 0x26, 0x19, 0xf7, 0x38];
#[inline(always)]
pub fn vault_unit_value_updated(vault: &[u8; 32], vault_assets: u64, total_units: u128, health_bps: u16, slot: u64) -> [u8; 74] {
    let mut b = [0u8; 74];
    b[..8].copy_from_slice(&VAULT_UNIT_VALUE_UPDATED);
    b[8..40].copy_from_slice(vault);
    b[40..48].copy_from_slice(&vault_assets.to_le_bytes());
    b[48..64].copy_from_slice(&total_units.to_le_bytes());
    b[64..66].copy_from_slice(&health_bps.to_le_bytes());
    b[66..74].copy_from_slice(&slot.to_le_bytes());
    b
}

/// `VaultUpdated` (48 bytes incl. disc). Fields in IDL order.
pub const VAULT_UPDATED: [u8; 8] = [0x5d, 0xbb, 0x91, 0xd8, 0x86, 0xc9, 0x03, 0x69];
#[inline(always)]
pub fn vault_updated(vault: &[u8; 32], slot: u64) -> [u8; 48] {
    let mut b = [0u8; 48];
    b[..8].copy_from_slice(&VAULT_UPDATED);
    b[8..40].copy_from_slice(vault);
    b[40..48].copy_from_slice(&slot.to_le_bytes());
    b
}

/// (IDL name, discriminator, total serialized size incl. disc) for the host ABI test.
pub const EVENTS: [(&str, [u8; 8], usize); 34] = [
    ("AllowlistChanged", ALLOWLIST_CHANGED, 81),
    ("GameLost", GAME_LOST, 90),
    ("GameRefunded", GAME_REFUNDED, 96),
    ("GameSettled", GAME_SETTLED, 148),
    ("GameStarted", GAME_STARTED, 121),
    ("GameWon", GAME_WON, 105),
    ("HouseDeposited", HOUSE_DEPOSITED, 56),
    ("HouseWithdrawCancelled", HOUSE_WITHDRAW_CANCELLED, 32),
    ("HouseWithdrawCompleted", HOUSE_WITHDRAW_COMPLETED, 40),
    ("HouseWithdrawRequested", HOUSE_WITHDRAW_REQUESTED, 40),
    ("LpDeposited", LP_DEPOSITED, 96),
    ("LpPositionClosed", LP_POSITION_CLOSED, 48),
    ("LpWithdrawCancelled", LP_WITHDRAW_CANCELLED, 64),
    ("LpWithdrawCompleted", LP_WITHDRAW_COMPLETED, 96),
    ("LpWithdrawRequested", LP_WITHDRAW_REQUESTED, 72),
    ("OperatorUnitsUnlocked", OPERATOR_UNITS_UNLOCKED, 136),
    ("OwnerAccepted", OWNER_ACCEPTED, 112),
    ("OwnerProposalCancelled", OWNER_PROPOSAL_CANCELLED, 48),
    ("OwnerProposed", OWNER_PROPOSED, 112),
    ("ReferralAccrued", REFERRAL_ACCRUED, 89),
    ("ReferralClaimed", REFERRAL_CLAIMED, 56),
    ("ReferralRepaired", REFERRAL_REPAIRED, 48),
    ("ReferralTierChanged", REFERRAL_TIER_CHANGED, 49),
    ("ReferrerSet", REFERRER_SET, 80),
    ("StatsUpdated", STATS_UPDATED, 92),
    ("TileRevealed", TILE_REVEALED, 91),
    ("TreasuryAccrued", TREASURY_ACCRUED, 128),
    ("TreasuryWithdrawal", TREASURY_WITHDRAWAL, 88),
    ("V2ConfigUpdated", V2_CONFIG_UPDATED, 48),
    ("V2Initialized", V2_INITIALIZED, 96),
    ("VaultFunded", VAULT_FUNDED, 64),
    ("VaultInitialized", VAULT_INITIALIZED, 144),
    ("VaultUnitValueUpdated", VAULT_UNIT_VALUE_UPDATED, 74),
    ("VaultUpdated", VAULT_UPDATED, 48),
];
