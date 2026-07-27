//! Per-click VRF-in-Ephemeral-Rollup Mines mode (additive).
//!
//! This is a SECOND game mode bolted onto the existing commit-reveal program.
//! It shares the same money machinery — the one `Vault` bankroll PDA, the
//! `VaultV2State.total_outstanding_max_payout` reservation accumulator, the
//! `calc_multiplier` / `worst_case_payout` math, the health floor, treasury
//! split, and referral rakeback — but replaces the server-signed reveal with a
//! MagicBlock VRF draw per tile inside an Ephemeral Rollup, so no house key
//! signs the reveal or settle path.
//!
//! Money never enters the rollup. The bet lives in `Vault` on L1; only the
//! money-less reveal-state PDA (`VrfGame`) is delegated to the ER.
//!
//! Recovering a bet: `refund_stalled_vrf` returns it from L1 in ~10s, but ONLY
//! once the reveal PDA is back under program ownership — while the account is
//! delegated its L1 copy is stale by design and paying against it would let a
//! player dodge a loss. A game that is still delegated must first be committed
//! back (the player's own `settle_and_undelegate_vrf`); if the rollup never
//! gives it back at all, the owner-gated `admin_release_vrf_claim` is the
//! backstop after ~24h.
//!
//! Gated on-chain by `VaultV2State.vrf_validator` + `vrf_max_payout_bps`, both
//! owner-set and both fail-closed when unset. NOTE: `vrf_mode_enabled` is also
//! checked but is NOT a reliable "off" signal — it already reads true on
//! mainnet from a previous struct layout. The backend independently chooses
//! which mode to route a player to.
//!
//! Reservation invariant (mirrors the commit-reveal mode exactly): increment
//! `total_outstanding_max_payout` by the worst-case payout ONCE at start, and
//! decrement it ONCE at resolution (`settle_vrf` or `refund_stalled_vrf`) —
//! never on the payout itself.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, vrf, vrf_callback};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_scoped_randomness_ix, RequestRandomnessParams,
};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

use crate::{
    calc_multiplier, enforce_min_health, mul_div_floor, units_to_assets, vault_assets,
    worst_case_payout, KaboomError, Vault, VaultV2State, BPS, GRID_SIZE, MAX_MINES, MIN_BET_LAMPORTS,
    MIN_MINES, REFERRAL_BRONZE_BPS, REFERRAL_GOLD_BPS, REFERRAL_SILVER_BPS, REFERRAL_SEED,
    GOLD_VOLUME_LAMPORTS, SILVER_VOLUME_LAMPORTS, VAULT_SEED, VAULT_V2_SEED,
};
use crate::{GameSessionV2, PlayerStats, ReferralAccount, GAME_V2_SEED, STATS_SEED};

// ─── Seeds / constants ───────────────────────────────────────────────────────

pub const VRF_CLAIM_SEED: &[u8] = b"kaboom_vrf_claim";
pub const VRF_GAME_SEED: &[u8] = b"kaboom_vrf_game";

/// Reveal-state statuses. `VrfGame.status` MUST stay the first field (offset 8)
/// so `refund_stalled_vrf` can read it raw while the account is still
/// delegation-program-owned.
pub const VRF_PLAYING: u8 = 0;
pub const VRF_WON: u8 = 1;
pub const VRF_LOST: u8 = 2;
pub const NO_TILE: u8 = 255;

/// ~10s at 400ms/slot. A stalled game's bet is reclaimable from L1 after this.
pub const STALL_SLOTS: u64 = 25;
/// ~24h at 400ms/slot. Only after this may the owner force-release a game the
/// rollup never gave back (see `admin_release_vrf_claim`). Deliberately far
/// longer than any real game so it can never race live play.
pub const ABANDON_SLOTS: u64 = 216_000;
/// Push ER state to L1 every ~1s so the committed status the refund guard reads
/// is fresh enough that a real loss cannot hide inside the refund window.
pub const COMMIT_FREQUENCY_MS: u32 = 1_000;

/// Byte offsets into raw `VrfGame` account data (8-byte disc, then the fields
/// in declaration order). Used when the account must be read without
/// deserializing it. Keep in lockstep with the struct below.
/// disc 0..8 | status 8 | player 9..41 | session_key 41..73 | bump 73 |
/// mine_count 74 | house_edge_bps 75..77 | safe_reveals 77 | reveal_count 78 |
/// pending 79 | pending_tile 80 | ...
pub const VRF_GAME_STATUS_OFFSET: usize = 8;
pub const VRF_GAME_SAFE_REVEALS_OFFSET: usize = 77;
pub const VRF_GAME_PENDING_OFFSET: usize = 79;
/// Smallest prefix the raw reads above require.
const VRF_GAME_MIN_RAW_LEN: usize = VRF_GAME_PENDING_OFFSET + 1;

pub const MAX_VRF_REVEALS: usize = 16;

/// MagicBlock ephemeral-VRF oracle queue. Program-wide constant, verified live
/// on mainnet (owned by the delegation program) and identical on devnet.
/// Pinned here so a game cannot be pointed at an attacker-run queue.
pub const VRF_ORACLE_QUEUE: Pubkey =
    anchor_lang::solana_program::pubkey!("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

// ─── Accounts ─────────────────────────────────────────────────────────────────

/// L1 escrow claim. NEVER delegated. Holds the money-side state so settle/refund
/// can always touch it regardless of ER status.
#[account]
pub struct VrfClaim {
    pub player: Pubkey,
    pub bet: u64,
    /// Worst-case payout reserved in `total_outstanding_max_payout` at start.
    /// Doubles as the HARD PAYOUT CAP at settle: a legitimate outcome can never
    /// pay more than the full-clear payout the vault already underwrote here.
    pub reserved: u64,
    pub mine_count: u8,
    /// House edge snapshotted on L1 at start. `settle_vrf` requires the
    /// rollup-committed edge to equal this, so the multiplier cannot be inflated
    /// by whoever writes the committed state.
    pub house_edge_bps: u16,
    pub start_slot: u64,
    pub settled: bool,
    pub bump: u8,
}
impl VrfClaim {
    pub const SIZE: usize = 32 + 8 + 8 + 1 + 2 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct VrfReveal {
    pub tile: u8,
    pub randomness: [u8; 32],
}

/// Reveal-state PDA. Delegated to the ER during play. Money-less.
#[account]
pub struct VrfGame {
    pub status: u8, // MUST be first (offset 8) — refund reads it raw.
    pub player: Pubkey,
    pub session_key: Pubkey,
    pub bump: u8,
    pub mine_count: u8,
    /// House edge snapshotted at start so the ER can compute the multiplier
    /// without reading the L1 Vault.
    pub house_edge_bps: u16,
    pub safe_reveals: u8,
    pub reveal_count: u8,
    pub pending: bool,
    pub pending_tile: u8,
    pub revealed_mask: u16,
    pub mine_mask: u16,
    pub multiplier_bps: u64,
    pub reveals: [VrfReveal; MAX_VRF_REVEALS],
}
impl VrfGame {
    pub const SIZE: usize = 1 + 32 + 32 + 1 + 1 + 2 + 1 + 1 + 1 + 1 + 2 + 2 + 8 + (33 * MAX_VRF_REVEALS);
}

// ─── Helper: per-click fair mine decision ─────────────────────────────────────

/// Until the first mine is hit every mine is still hidden among the unrevealed
/// tiles, so P(mine) = mine_count / (16 - safe_reveals). Draws a uniform index
/// in [0, remaining) from the VRF output and calls it a mine if it lands in the
/// first `mine_count` slots. Same distribution the hypergeometric multiplier
/// prices, so payout math and outcome stay consistent.
pub fn decide_mine(randomness: &[u8; 32], safe_reveals: u8, mine_count: u8) -> bool {
    let remaining = (GRID_SIZE.saturating_sub(safe_reveals)) as u64;
    if remaining == 0 {
        return false;
    }
    let mut r = [0u8; 8];
    r.copy_from_slice(&randomness[0..8]);
    let x = u64::from_le_bytes(r) % remaining;
    x < (mine_count as u64)
}

// ─── Instructions ─────────────────────────────────────────────────────────────

/// L1: lock the bet into the Vault, open the escrow claim + reveal state, and
/// register the per-game session key the player authorizes for ER reveals.
/// Reuses the exact caps / reservation / health checks as `start_game`.
pub fn start_game_vrf(
    ctx: Context<StartGameVrf>,
    mine_count: u8,
    bet: u64,
    session_key: Pubkey,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(
        ctx.accounts.v2_state.vrf_mode_enabled,
        KaboomError::VrfModeDisabled
    );
    // Fail-closed second gate. `vrf_mode_enabled` is NOT trustworthy as an
    // "off" signal (it already reads 1 on mainnet — see the field's doc in
    // lib.rs), so the mode is additionally gated on a pinned validator, which
    // is verified zero on the live account. Both must be set deliberately by
    // the owner before a single VRF game can be opened.
    require!(
        ctx.accounts.v2_state.vrf_validator != Pubkey::default(),
        KaboomError::VrfValidatorNotSet
    );
    require!(
        ctx.accounts.v2_state.vrf_max_payout_bps > 0,
        KaboomError::VrfValidatorNotSet
    );
    require!(!vault.paused, KaboomError::VaultPaused);
    require!(
        (MIN_MINES..=MAX_MINES).contains(&mine_count),
        KaboomError::InvalidMineCount
    );
    require!(bet >= MIN_BET_LAMPORTS, KaboomError::BetTooLow);

    let vault_info = vault.to_account_info();
    let available = vault_assets(&vault_info)?;

    // Health-scaled caps — identical to start_game.
    let v2 = &ctx.accounts.v2_state;
    let pre_health = crate::calc_health_bps(v2, available)?;
    let effective_max_bet_bps = (vault.max_bet_bps as u64)
        .checked_mul(pre_health as u64)
        .ok_or(KaboomError::MathOverflow)?
        / BPS;
    // VRF games use the tighter of the vault-wide ceiling and the VRF-specific
    // one. This is the aggregate bound on a forged-outcome attack: it caps what
    // any single game can reserve, and therefore what a rogue committer can
    // extract per game, independent of the vault's general risk appetite.
    let vrf_payout_bps = (vault.max_payout_bps).min(v2.vrf_max_payout_bps);
    let effective_max_payout_bps = (vrf_payout_bps as u64)
        .checked_mul(pre_health as u64)
        .ok_or(KaboomError::MathOverflow)?
        / BPS;
    let max_bet = mul_div_floor(available, effective_max_bet_bps, BPS)?;
    require!(bet <= max_bet, KaboomError::BetExceedsMax);

    let worst_payout_u64 = worst_case_payout(bet, mine_count, vault.house_edge_bps)?;
    let max_payout = mul_div_floor(available, effective_max_payout_bps, BPS)? as u128;
    require!(
        (worst_payout_u64 as u128) <= max_payout,
        KaboomError::VaultInsufficientFunds
    );

    let house_edge_bps = vault.house_edge_bps;

    // Lock the bet.
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        bet,
    )?;

    let clock = Clock::get()?;

    let claim = &mut ctx.accounts.claim;
    claim.player = ctx.accounts.player.key();
    claim.bet = bet;
    claim.reserved = worst_payout_u64;
    claim.mine_count = mine_count;
    claim.house_edge_bps = house_edge_bps;
    claim.start_slot = clock.slot;
    claim.settled = false;
    claim.bump = ctx.bumps.claim;

    let game = &mut ctx.accounts.game;
    game.status = VRF_PLAYING;
    game.player = ctx.accounts.player.key();
    game.session_key = session_key;
    game.bump = ctx.bumps.game;
    game.mine_count = mine_count;
    game.house_edge_bps = house_edge_bps;
    game.safe_reveals = 0;
    game.reveal_count = 0;
    game.pending = false;
    game.pending_tile = NO_TILE;
    game.revealed_mask = 0;
    game.mine_mask = 0;
    game.multiplier_bps = BPS;
    game.reveals = [VrfReveal::default(); MAX_VRF_REVEALS];

    // First-time stats init (mirrors StartGame in the commit-reveal mode).
    let stats = &mut ctx.accounts.player_stats;
    if stats.player == Pubkey::default() {
        stats.player = ctx.accounts.player.key();
        stats.bump = ctx.bumps.player_stats;
        stats.version = 1;
    }

    let vault_mut = &mut ctx.accounts.vault;
    vault_mut.total_games = vault_mut.total_games.saturating_add(1);
    vault_mut.total_wagered = vault_mut.total_wagered.saturating_add(bet);

    // Track obligation; enforce health floor on post-bet state (bet is now in).
    let v2_mut = &mut ctx.accounts.v2_state;
    v2_mut.total_outstanding_max_payout = v2_mut
        .total_outstanding_max_payout
        .checked_add(worst_payout_u64)
        .ok_or(KaboomError::MathOverflow)?;
    let new_assets = available.saturating_add(bet);
    enforce_min_health(v2_mut, new_assets)?;

    Ok(())
}

/// L1 -> ER: delegate the reveal-state PDA to the rollup. Player signs.
///
/// The target validator is taken from on-chain owner-set config, NEVER from the
/// caller — whoever holds the delegation is the party that writes the committed
/// result `settle_vrf` pays out on, so it must not be caller-controlled.
///
/// Precisely what the alternatives do (the delegation program's own source, not
/// inference): passing `None` does NOT mean "any validator" — the processor
/// substitutes its hardcoded `DEFAULT_VALIDATOR_IDENTITY`, which today is the
/// same MAS1 node we pin. True any-validator mode is a SEPARATE instruction
/// (`DelegateWithAnyValidator`) that writes the system program as authority; we
/// never call it. So the practical difference is that an explicit pin keeps the
/// choice ours rather than tracking whatever MagicBlock changes its default to.
///
/// ⚠️ The delegation program does NOT validate this value at delegate time — it
/// records whatever it is handed. Only commit and undelegate check it, and both
/// require that identity to SIGN. A wrong pin therefore fails SILENTLY: the
/// delegation succeeds and the game becomes unreachable, with the bet locked
/// until `admin_release_vrf_claim`. The pin and the ER endpoint the app talks to
/// must always name the same node.
pub fn delegate_vrf(ctx: Context<DelegateVrf>) -> Result<()> {
    let pinned = ctx.accounts.v2_state.vrf_validator;
    require!(pinned != Pubkey::default(), KaboomError::VrfValidatorNotSet);
    // If the caller passes a validator account at all, it must be the pinned
    // one — so a mismatch fails loudly instead of silently delegating elsewhere.
    if let Some(passed) = ctx.remaining_accounts.first() {
        require!(passed.key() == pinned, KaboomError::WrongVrfValidator);
    }
    ctx.accounts.delegate_game(
        &ctx.accounts.player,
        &[VRF_GAME_SEED, ctx.accounts.player.key().as_ref()],
        DelegateConfig {
            commit_frequency_ms: COMMIT_FREQUENCY_MS,
            validator: Some(pinned),
        },
    )?;
    Ok(())
}

/// ER: reveal signed by the SESSION KEY (no player popup). Locks the tile, then
/// requests a scoped VRF draw whose callback re-enters `reveal_callback_vrf`.
pub fn reveal_request_vrf(ctx: Context<RevealRequestVrf>, tile_index: u8, client_seed: u8) -> Result<()> {
    let g = &mut ctx.accounts.game;
    require!(
        ctx.accounts.session.key() == g.session_key,
        KaboomError::BadSessionKey
    );
    require!(g.status == VRF_PLAYING, KaboomError::GameNotPlaying);
    require!(tile_index < GRID_SIZE, KaboomError::InvalidTileIndex);
    require!(!g.pending, KaboomError::RevealPending);
    let bit = 1u16 << tile_index;
    require!(g.revealed_mask & bit == 0, KaboomError::TileAlreadyRevealed);

    g.pending = true;
    g.pending_tile = tile_index;

    let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.session.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::RevealCallbackVrf::DISCRIMINATOR.to_vec(),
        caller_seed: [client_seed; 32],
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: g.key(),
            is_signer: false,
            is_writable: true,
        }]),
        ..Default::default()
    });
    ctx.accounts
        .invoke_signed_vrf(&ctx.accounts.session.to_account_info(), &ix)?;
    Ok(())
}

/// ER: VRF-authenticated. Decides the locked tile at P(mine)=mines/remaining and
/// RECORDS the raw randomness so L1 can replay + verify at settle.
pub fn reveal_callback_vrf(ctx: Context<RevealCallbackVrf>, randomness: [u8; 32]) -> Result<()> {
    let g = &mut ctx.accounts.game;
    require!(g.pending, KaboomError::NoRevealPending);
    let tile = g.pending_tile;
    let bit = 1u16 << tile;

    let idx = g.reveal_count as usize;
    require!(idx < MAX_VRF_REVEALS, KaboomError::TooManyReveals);
    g.reveals[idx] = VrfReveal { tile, randomness };
    g.reveal_count = g.reveal_count.saturating_add(1);

    let is_mine = decide_mine(&randomness, g.safe_reveals, g.mine_count);
    g.revealed_mask |= bit;
    g.pending = false;
    g.pending_tile = NO_TILE;
    if is_mine {
        g.mine_mask |= bit;
        g.status = VRF_LOST;
    } else {
        g.safe_reveals = g.safe_reveals.saturating_add(1);
        g.multiplier_bps = calc_multiplier(g.safe_reveals, g.mine_count, g.house_edge_bps)?;
        if g.safe_reveals >= GRID_SIZE - g.mine_count {
            g.status = VRF_WON;
        }
    }
    Ok(())
}

/// ER: exit with the current multiplier (session key or player may sign).
pub fn cash_out_vrf(ctx: Context<CashOutVrf>) -> Result<()> {
    let g = &mut ctx.accounts.game;
    let signer = ctx.accounts.signer.key();
    require!(
        signer == g.session_key || signer == g.player,
        KaboomError::BadSessionKey
    );
    require!(g.status == VRF_PLAYING, KaboomError::GameNotPlaying);
    require!(!g.pending, KaboomError::RevealPending);
    require!(g.safe_reveals > 0, KaboomError::NoTilesRevealed);
    g.status = VRF_WON;
    Ok(())
}

/// ER -> L1: commit the reveal-state PDA back to base and undelegate.
///
/// Restricted to the player and their session key. Left open, any third party
/// could yank a stranger's live game out of the rollup for the price of a fee:
/// the game lands on L1 still Playing, cash-out is rollup-only so it becomes
/// unreachable, and the victim is left with a bare bet refund — their accrued
/// multiplier destroyed. Operator recovery of a genuinely stuck game does not
/// need this path (see `admin_release_vrf_claim`).
pub fn settle_and_undelegate_vrf(ctx: Context<SettleAndUndelegateVrf>) -> Result<()> {
    let signer = ctx.accounts.payer.key();
    let g = &ctx.accounts.game;
    require!(
        signer == g.player || signer == g.session_key,
        KaboomError::BadSessionKey
    );
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.game.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

/// L1: independently REPLAY the game from the recorded VRF outputs, verify the
/// committed summary matches, release the reservation, pay the winner, take the
/// treasury cut, credit the referrer, and update stats. No house signature.
pub fn settle_vrf<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleVrf<'info>>,
) -> Result<()> {
    require!(!ctx.accounts.claim.settled, KaboomError::GameAlreadySettled);

    let (status, reveal_count, mine_count, committed_safe, committed_mult, edge) = {
        let g = &ctx.accounts.game;
        (
            g.status,
            g.reveal_count,
            g.mine_count,
            g.safe_reveals,
            g.multiplier_bps,
            g.house_edge_bps,
        )
    };
    require!(
        status == VRF_WON || status == VRF_LOST,
        KaboomError::GameNotPlaying
    );

    // The replay below only proves the committed state is SELF-consistent. Every
    // input to it except the bet arrives from the rollup-committed account, so
    // pin each one that prices the payout to the L1 claim (written at start,
    // never delegated) before trusting any of it.
    require!(
        mine_count == ctx.accounts.claim.mine_count,
        KaboomError::ReplayMismatch
    );
    require!(
        edge == ctx.accounts.claim.house_edge_bps,
        KaboomError::ReplayMismatch
    );
    // Bounds the loop below: reveal_count is an attacker-writable u8 indexing a
    // fixed 16-slot array. Out of range would panic settle forever while refund
    // is simultaneously blocked by the terminal status — stranding bet + reservation.
    require!(
        (reveal_count as usize) <= MAX_VRF_REVEALS,
        KaboomError::TooManyReveals
    );

    // Replay from recorded randomness — the L1 re-verification.
    let mut safe_reveals: u8 = 0;
    let mut lost = false;
    for i in 0..(reveal_count as usize) {
        let rec = ctx.accounts.game.reveals[i];
        require!((rec.tile as u16) < GRID_SIZE as u16, KaboomError::InvalidTileIndex);
        if decide_mine(&rec.randomness, safe_reveals, mine_count) {
            lost = true;
            break;
        }
        safe_reveals = safe_reveals.saturating_add(1);
    }
    require!(safe_reveals == committed_safe, KaboomError::ReplayMismatch);
    require!(
        status == if lost { VRF_LOST } else { VRF_WON },
        KaboomError::ReplayMismatch
    );
    // A win always has at least one safe reveal (cash_out requires it, and a
    // full clear implies it). Without this, a zero-reveal "win" would settle as
    // a 1x push that still pays the referral and treasury cuts out of the vault.
    require!(lost || safe_reveals > 0, KaboomError::ReplayMismatch);
    let expected_mult = calc_multiplier(safe_reveals, mine_count, edge)?;
    require!(committed_mult == expected_mult, KaboomError::ReplayMismatch);

    // Release this game's obligation exactly once (never on the payout path).
    let reserved = ctx.accounts.claim.reserved;
    {
        let v2 = &mut ctx.accounts.v2_state;
        v2.total_outstanding_max_payout =
            v2.total_outstanding_max_payout.saturating_sub(reserved);
    }

    let bet = ctx.accounts.claim.bet;

    // Pay out on a win (bet * multiplier). Money never left L1.
    let payout: u64 = if !lost {
        let p = mul_div_floor(bet, expected_mult, BPS)?;
        // HARD CAP. `reserved` is the full-clear payout computed on L1 at start
        // from this bet + mine count, so every legitimate outcome is <= it.
        //
        // Scope, precisely: this bounds a forged commit to ONE game's reserved
        // worst case — it removes the single-transaction whole-vault drain, but
        // it is NOT an aggregate bound. Whoever writes the committed state can
        // force a full clear on EVERY game, and `reserved` is capped at start
        // only by max_payout_bps (5000 = 50% of assets on the live vault), so
        // repeated forgeries still add up. The real defence against forgery is
        // the pinned `vrf_validator` plus the VRF callback's scoped identity
        // signer; this cap is the backstop that bounds the blast radius per
        // game. Size any canary seed against the repeated case, not this one.
        require!(p <= reserved, KaboomError::PayoutExceedsReserved);
        let vault_info = ctx.accounts.vault.to_account_info();
        let available = vault_assets(&vault_info)?;
        require!(p <= available, KaboomError::VaultInsufficientFunds);
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(p)
            .ok_or(KaboomError::MathOverflow)?;
        let player_info = ctx.accounts.player.to_account_info();
        **player_info.try_borrow_mut_lamports()? = player_info
            .lamports()
            .checked_add(p)
            .ok_or(KaboomError::MathOverflow)?;
        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.total_payouts = vault_mut.total_payouts.saturating_add(p);
        p
    } else {
        0
    };

    // Player stats (mirror settle_game). Guaranteed to exist — start_game_vrf
    // created it and the context constraint binds it to this player.
    let stats = &mut ctx.accounts.player_stats;
    stats.games_played = stats.games_played.saturating_add(1);
    stats.total_wagered = stats.total_wagered.saturating_add(bet);
    stats.last_played = Clock::get()?.unix_timestamp;
    if !lost {
        stats.games_won = stats.games_won.saturating_add(1);
        stats.total_payouts = stats.total_payouts.saturating_add(payout);
        let net_win = payout.saturating_sub(bet);
        if net_win > stats.biggest_win {
            stats.biggest_win = net_win;
        }
        if expected_mult > stats.biggest_multiplier_bps {
            stats.biggest_multiplier_bps = expected_mult;
        }
        stats.current_streak = stats.current_streak.saturating_add(1);
        if stats.current_streak > stats.best_streak {
            stats.best_streak = stats.current_streak;
        }
    } else {
        stats.current_streak = 0;
    }

    // Referral rakeback (drawn from the house-edge stream) — mirror settle_game.
    if let Some(referrer_key) = stats.referrer {
        if let Some(referral_info) = ctx.remaining_accounts.first() {
            let (expected_referral_pda, _) =
                Pubkey::find_program_address(&[REFERRAL_SEED, referrer_key.as_ref()], &crate::ID);
            require!(
                referral_info.key() == expected_referral_pda,
                KaboomError::ReferralMismatch
            );
            let mut ra: Account<ReferralAccount> = Account::try_from(referral_info)?;
            require!(ra.referrer == referrer_key, KaboomError::ReferralMismatch);

            let cut_bps = match ra.tier {
                0 => REFERRAL_BRONZE_BPS,
                1 => REFERRAL_SILVER_BPS,
                _ => REFERRAL_GOLD_BPS,
            };
            let cut = mul_div_floor(bet, cut_bps as u64, BPS)?;
            let vault_info = ctx.accounts.vault.to_account_info();
            let vault_available = vault_assets(&vault_info)?;
            let actual_cut = cut.min(vault_available);
            if actual_cut > 0 {
                **vault_info.try_borrow_mut_lamports()? = vault_info
                    .lamports()
                    .checked_sub(actual_cut)
                    .ok_or(KaboomError::MathOverflow)?;
                **referral_info.try_borrow_mut_lamports()? = referral_info
                    .lamports()
                    .checked_add(actual_cut)
                    .ok_or(KaboomError::MathOverflow)?;
            }
            ra.accrued_lamports = ra.accrued_lamports.saturating_add(actual_cut);
            ra.total_earned = ra.total_earned.saturating_add(actual_cut);
            ra.referred_volume = ra.referred_volume.saturating_add(bet);
            let new_tier = if ra.referred_volume >= GOLD_VOLUME_LAMPORTS {
                2
            } else if ra.referred_volume >= SILVER_VOLUME_LAMPORTS {
                1
            } else {
                0
            };
            if new_tier != ra.tier {
                ra.tier = new_tier;
            }
            ra.exit(&crate::ID)?;
        }
    }

    // Treasury / LP profit split — mirror settle_game.
    let treasury_split_bps = ctx.accounts.vault.treasury_split_bps;
    let house_edge_bps = ctx.accounts.vault.house_edge_bps;
    if treasury_split_bps > 0 {
        let edge_share = mul_div_floor(bet, house_edge_bps as u64, BPS)?;
        let treasury_cut = mul_div_floor(edge_share, treasury_split_bps as u64, BPS)?;
        let vault_info = ctx.accounts.vault.to_account_info();
        let v2_ref = &ctx.accounts.v2_state;
        let assets_now = vault_assets(&vault_info)?;
        let pending_value =
            units_to_assets(v2_ref.total_pending_units, assets_now, v2_ref.total_units)?;
        let liquidity = assets_now
            .saturating_sub(v2_ref.total_outstanding_max_payout)
            .saturating_sub(pending_value);
        let actual_treasury_cut = treasury_cut.min(liquidity);
        if actual_treasury_cut > 0 {
            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(actual_treasury_cut)
                .ok_or(KaboomError::MathOverflow)?;
            let treasury_info = ctx.accounts.treasury.to_account_info();
            **treasury_info.try_borrow_mut_lamports()? = treasury_info
                .lamports()
                .checked_add(actual_treasury_cut)
                .ok_or(KaboomError::MathOverflow)?;
        }
    }

    ctx.accounts.claim.settled = true;
    Ok(())
}

/// L1: reclaim the bet when the game ended up back on L1 without a result.
///
/// ⚠️ SECURITY — why this refuses to touch a DELEGATED game.
/// While the reveal PDA is delegated, L1's copy of it is STALE BY DESIGN: the
/// delegation SDK zeroes the account at hand-off (and zero == `VRF_PLAYING`),
/// and the true status only lands on L1 when the rollup commits. Reading the raw
/// status byte in that window therefore proves nothing — a player could lose in
/// the rollup and refund before the loss ever reached L1, taking a free option
/// on every game (measured +91.75% EV/game at 15 mines; profitable at a ~2%
/// success rate, so even a narrow race was enough).
///
/// The only sound test is OWNERSHIP: if the account is owned by this program it
/// is not currently delegated, so whatever it says is final. That is what we
/// require. Two states qualify, both safe:
///   • never delegated (start landed, delegation didn't) — status Playing, no reveals;
///   • delegated, then committed + undelegated while still Playing (player quit
///     mid-game) — refunding is not better for them than cashing out, since a
///     safe reveal pays > 1x at any house edge below 625 bps (live edge is 200;
///     the configurable ceiling is 1000, above which a 1-mine/1-reveal refund
///     would edge out a cash-out by a few percent — worth re-checking if the
///     edge is ever raised that far).
/// A genuinely stuck DELEGATED game is recovered by undelegating it first (the
/// player's own settle-and-undelegate, or force-undelegate once MagicBlock ships
/// it to mainnet) — never by paying out against a state we cannot see.
///
/// This also removes the design's dependence on the rollup validator honouring
/// `commit_frequency_ms`, which is a best-effort hint we cannot enforce.
pub fn refund_stalled_vrf(ctx: Context<RefundStalledVrf>) -> Result<()> {
    require!(!ctx.accounts.claim.settled, KaboomError::GameAlreadySettled);
    // Only the player themselves or the operator relay may cancel a game.
    let caller = ctx.accounts.caller.key();
    let is_player = caller == ctx.accounts.claim.player;
    require!(
        is_player || caller == ctx.accounts.vault.house_authority,
        KaboomError::Unauthorized
    );
    let now = Clock::get()?.slot;
    require!(
        now > ctx.accounts.claim.start_slot.saturating_add(STALL_SLOTS),
        KaboomError::NotStalledYet
    );

    // Ownership is the real guard (see above); the status read is only
    // meaningful BECAUSE the account is undelegated here.
    {
        let game_info = ctx.accounts.game.to_account_info();
        require!(game_info.owner == &crate::ID, KaboomError::GameStillDelegated);
        let data = ctx.accounts.game.try_borrow_data()?;
        require!(data.len() >= VRF_GAME_MIN_RAW_LEN, KaboomError::BadGameAccount);
        require!(
            data[VRF_GAME_STATUS_OFFSET] == VRF_PLAYING,
            KaboomError::GameAlreadyResolved
        );
        // Defensive: the PDA is seed-derived, but confirm it really is this
        // player's game before paying against it.
        let player_bytes = ctx.accounts.player.key().to_bytes();
        require!(
            data[VRF_GAME_STATUS_OFFSET + 1..VRF_GAME_STATUS_OFFSET + 33] == player_bytes[..],
            KaboomError::BadGameAccount
        );
        // The operator relay may only cancel a game that made NO progress.
        // Refunding is worse than cashing out once tiles are revealed, so
        // letting the house cancel a game with a live multiplier would let it
        // wipe a winning position. The player may still cancel their own.
        if !is_player {
            require!(
                data[VRF_GAME_SAFE_REVEALS_OFFSET] == 0 && data[VRF_GAME_PENDING_OFFSET] == 0,
                KaboomError::Unauthorized
            );
        }
    }

    let (bet, reserved) = (ctx.accounts.claim.bet, ctx.accounts.claim.reserved);
    {
        let v2 = &mut ctx.accounts.v2_state;
        v2.total_outstanding_max_payout =
            v2.total_outstanding_max_payout.saturating_sub(reserved);
    }
    let vault_info = ctx.accounts.vault.to_account_info();
    require!(bet <= vault_assets(&vault_info)?, KaboomError::VaultInsufficientFunds);
    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(bet)
        .ok_or(KaboomError::MathOverflow)?;
    {
        let player_info = ctx.accounts.player.to_account_info();
        let new_bal = player_info.lamports().checked_add(bet).ok_or(KaboomError::MathOverflow)?;
        **player_info.try_borrow_mut_lamports()? = new_bal;
    }

    // Free the reveal PDA (guaranteed program-owned by the check above) so the
    // player can start a new VRF game — `start_game_vrf` uses `init`, so without
    // this the wallet would be locked out of the mode forever.
    {
        let game_info = ctx.accounts.game.to_account_info();
        let g = game_info.lamports();
        **game_info.try_borrow_mut_lamports()? = 0;
        game_info.try_borrow_mut_data()?.fill(0);
        let player_info = ctx.accounts.player.to_account_info();
        let new_bal = player_info.lamports().checked_add(g).ok_or(KaboomError::MathOverflow)?;
        **player_info.try_borrow_mut_lamports()? = new_bal;
    }
    // The claim account auto-closes to the player via `close = player`.
    Ok(())
}

/// L1, owner-gated: last-resort recovery for a game that can never resolve.
///
/// If the rollup stops committing while a game is delegated, that game is
/// unreachable from L1 by every normal path — settle needs a terminal committed
/// status, refund needs the account back under program ownership, and the
/// operator cannot undelegate because reaching the rollup is exactly what
/// failed. Without this instruction the game's `reserved` would stay in
/// `total_outstanding_max_payout` FOREVER, and since that accumulator gates the
/// health floor for BOTH game modes and caps LP withdrawals, a single stranded
/// game would permanently shrink the usable bankroll. (The live vault already
/// carries 2.1952 SOL of exactly this kind of stale obligation from the
/// commit-reveal era, with no way to clear it.)
///
/// Deliberately conservative: owner-signed (Squads), and only after a long
/// window — far beyond any normal game, so it can never race a live one. The
/// bet is returned to the player, which is the honest default for a game that
/// never produced a result; the owner is the only party who can call it, and
/// doing so only ever costs the house.
pub fn admin_release_vrf_claim(ctx: Context<AdminReleaseVrfClaim>) -> Result<()> {
    require!(!ctx.accounts.claim.settled, KaboomError::GameAlreadySettled);
    let now = Clock::get()?.slot;
    require!(
        now > ctx.accounts.claim.start_slot.saturating_add(ABANDON_SLOTS),
        KaboomError::NotStalledYet
    );

    let (bet, reserved) = (ctx.accounts.claim.bet, ctx.accounts.claim.reserved);
    {
        let v2 = &mut ctx.accounts.v2_state;
        v2.total_outstanding_max_payout =
            v2.total_outstanding_max_payout.saturating_sub(reserved);
    }
    let vault_info = ctx.accounts.vault.to_account_info();
    let payable = bet.min(vault_assets(&vault_info)?);
    if payable > 0 {
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(payable)
            .ok_or(KaboomError::MathOverflow)?;
        let player_info = ctx.accounts.player.to_account_info();
        let new_bal = player_info
            .lamports()
            .checked_add(payable)
            .ok_or(KaboomError::MathOverflow)?;
        **player_info.try_borrow_mut_lamports()? = new_bal;
    }
    // The claim closes to the player via `close = player`. The reveal PDA is
    // left alone — it may still be delegated, and its rent is recovered
    // separately if the rollup ever releases it.
    Ok(())
}

/// L1, owner-gated: clean up an ER-era `GameSessionV2` orphaned by this upgrade.
///
/// The removed MagicBlock ER scaffolding (`start_game_er` / `reveal_tile_er` /
/// `settle_game_er` / `delegate_game`) was the ONLY code that could ever touch a
/// `GameSessionV2`. `refund_expired` and `close_unsettled_game` operate on the
/// v1 `GameSession` discriminator and reject these outright. So without this
/// instruction, every such account left on mainnet at upgrade time becomes
/// permanently unresolvable — its rent stranded, its bet stranded, and worst of
/// all its `max_payout` locked into `total_outstanding_max_payout` forever,
/// where it silently shrinks the usable bankroll for BOTH game modes and caps
/// LP withdrawals.
///
/// Two such accounts exist on mainnet today (0.001 SOL bets, abandoned ~70 days
/// ago with zero reveals), carrying 0.5488 SOL of obligation each. Recovering
/// them via the old ER path would mean invoking exactly the auth- and
/// commitment-buggy handlers this upgrade exists to delete, on a live vault.
/// This is the safe alternative: read-only on the game, owner-signed, and
/// deliberately unable to pay out more than the recorded bet.
pub fn admin_close_orphaned_game_v2(ctx: Context<AdminCloseOrphanedGameV2>) -> Result<()> {
    let game = &ctx.accounts.game;
    require!(!game.settled, KaboomError::GameAlreadySettled);

    let (bet, max_payout) = (game.bet, game.max_payout);
    {
        let v2 = &mut ctx.accounts.v2_state;
        v2.total_outstanding_max_payout =
            v2.total_outstanding_max_payout.saturating_sub(max_payout);
    }
    // Return the bet. Never more — this instruction cannot express a win.
    let vault_info = ctx.accounts.vault.to_account_info();
    let payable = bet.min(vault_assets(&vault_info)?);
    if payable > 0 {
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(payable)
            .ok_or(KaboomError::MathOverflow)?;
        let player_info = ctx.accounts.player.to_account_info();
        let new_bal = player_info
            .lamports()
            .checked_add(payable)
            .ok_or(KaboomError::MathOverflow)?;
        **player_info.try_borrow_mut_lamports()? = new_bal;
    }
    // The game account closes to the player via `close = player`, returning rent.
    Ok(())
}

// NOTE: force-undelegate (validator-stall forced-exit) handlers are DEFERRED.
// Not deployed on mainnet DLP yet, and not needed for fund safety — refund_stalled_vrf
// already recovers the bet from L1. Re-add when MagicBlock ships PR#183 and the
// dlp_api solana-version skew is resolved. Reference impl: ~/Projects/kaboom-mb-spike.

// ─── Contexts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct StartGameVrf<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,
    #[account(
        init,
        payer = player,
        space = 8 + VrfClaim::SIZE,
        seeds = [VRF_CLAIM_SEED, player.key().as_ref()],
        bump,
    )]
    pub claim: Account<'info, VrfClaim>,
    #[account(
        init,
        payer = player,
        space = 8 + VrfGame::SIZE,
        seeds = [VRF_GAME_SEED, player.key().as_ref()],
        bump,
    )]
    pub game: Account<'info, VrfGame>,
    /// Created HERE, paid by the player — mirroring the commit-reveal mode's
    /// StartGame. Creating it at settle instead would make the house pay ~0.0023
    /// SOL of permanently unreclaimable rent for every fresh wallet that ever
    /// finishes a game, which is a drain on the shared signer that also serves
    /// the live commit-reveal game.
    #[account(
        init_if_needed,
        payer = player,
        space = PlayerStats::SPACE,
        seeds = [STATS_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_stats: Box<Account<'info, PlayerStats>>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateVrf<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: reveal-state PDA to delegate.
    #[account(mut, del, seeds = [VRF_GAME_SEED, player.key().as_ref()], bump)]
    pub game: AccountInfo<'info>,
    /// Source of the pinned validator — read-only config, never caller-supplied.
    #[account(seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,
}

#[vrf]
#[derive(Accounts)]
pub struct RevealRequestVrf<'info> {
    #[account(mut)]
    pub session: Signer<'info>,
    #[account(mut, seeds = [VRF_GAME_SEED, game.player.as_ref()], bump = game.bump)]
    pub game: Account<'info, VrfGame>,
    /// CHECK: address-pinned to the MagicBlock ephemeral VRF queue. Left free,
    /// a caller could point a game at a queue they control and simply never
    /// fulfil the draw, parking the game in Playing forever.
    #[account(mut, address = VRF_ORACLE_QUEUE @ KaboomError::WrongVrfValidator)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct RevealCallbackVrf<'info> {
    #[account(mut)]
    pub game: Account<'info, VrfGame>,
}

#[derive(Accounts)]
pub struct CashOutVrf<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [VRF_GAME_SEED, game.player.as_ref()], bump = game.bump)]
    pub game: Account<'info, VrfGame>,
}

#[commit]
#[derive(Accounts)]
pub struct SettleAndUndelegateVrf<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [VRF_GAME_SEED, game.player.as_ref()], bump = game.bump)]
    pub game: Account<'info, VrfGame>,
}

#[derive(Accounts)]
pub struct SettleVrf<'info> {
    /// Permissionless caller / fee payer; also funds player_stats init.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The player being paid. Keys the claim/game/stats PDAs; claim.player must match.
    /// CHECK: paid party; validated via claim.player == player.key().
    #[account(mut)]
    pub player: AccountInfo<'info>,
    // Closed to the player at settle so the per-player PDAs are freed for the
    // next game (rent reclaimed). Without this, `init` on the next game fails.
    #[account(
        mut,
        close = player,
        seeds = [VRF_CLAIM_SEED, player.key().as_ref()],
        bump = claim.bump,
        constraint = claim.player == player.key() @ KaboomError::Unauthorized,
    )]
    pub claim: Box<Account<'info, VrfClaim>>,
    #[account(
        mut,
        close = player,
        seeds = [VRF_GAME_SEED, player.key().as_ref()],
        bump = game.bump,
        constraint = game.player == player.key() @ KaboomError::Unauthorized,
    )]
    pub game: Box<Account<'info, VrfGame>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Box<Account<'info, VaultV2State>>,
    #[account(mut, address = vault.treasury @ KaboomError::Unauthorized)]
    /// CHECK: treasury target; validated against vault.treasury.
    pub treasury: AccountInfo<'info>,
    /// Already created (and paid for) by the player in start_game_vrf — never
    /// initialised here, so the permissionless settle caller cannot be made to
    /// fund rent for an account of someone else's choosing.
    #[account(
        mut,
        seeds = [STATS_SEED, player.key().as_ref()],
        bump = player_stats.bump,
        constraint = player_stats.player == player.key() @ KaboomError::Unauthorized,
    )]
    pub player_stats: Box<Account<'info, PlayerStats>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundStalledVrf<'info> {
    /// Must be the player or the operator relay (checked in the handler) — a
    /// signerless refund would let anyone cancel someone else's live game.
    pub caller: Signer<'info>,
    /// Refunded party. Keys the claim/game PDAs; claim.player must match.
    /// CHECK: refunded party; validated via claim.player == player.key().
    #[account(mut)]
    pub player: AccountInfo<'info>,
    #[account(
        mut,
        close = player,
        seeds = [VRF_CLAIM_SEED, player.key().as_ref()],
        bump = claim.bump,
        constraint = claim.player == player.key() @ KaboomError::Unauthorized,
    )]
    pub claim: Box<Account<'info, VrfClaim>>,
    /// CHECK: reveal-state PDA, possibly still delegation-program-owned; read raw.
    /// Closed manually in the handler only if still program-owned (a not-yet-
    /// delegated stall); a delegated one stays until force-undelegate.
    #[account(mut, seeds = [VRF_GAME_SEED, player.key().as_ref()], bump)]
    pub game: UncheckedAccount<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Box<Account<'info, VaultV2State>>,
}

#[derive(Accounts)]
pub struct AdminCloseOrphanedGameV2<'info> {
    #[account(constraint = vault.owner == owner.key() @ KaboomError::Unauthorized)]
    pub owner: Signer<'info>,
    /// CHECK: refunded party; validated via game.player == player.key().
    #[account(mut)]
    pub player: AccountInfo<'info>,
    #[account(
        mut,
        close = player,
        seeds = [GAME_V2_SEED, player.key().as_ref()],
        bump = game.bump,
        constraint = game.player == player.key() @ KaboomError::Unauthorized,
    )]
    pub game: Box<Account<'info, GameSessionV2>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Box<Account<'info, VaultV2State>>,
}

#[derive(Accounts)]
pub struct AdminReleaseVrfClaim<'info> {
    #[account(constraint = vault.owner == owner.key() @ KaboomError::Unauthorized)]
    pub owner: Signer<'info>,
    /// CHECK: refunded party; validated via claim.player == player.key().
    #[account(mut)]
    pub player: AccountInfo<'info>,
    #[account(
        mut,
        close = player,
        seeds = [VRF_CLAIM_SEED, player.key().as_ref()],
        bump = claim.bump,
        constraint = claim.player == player.key() @ KaboomError::Unauthorized,
    )]
    pub claim: Box<Account<'info, VrfClaim>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Box<Account<'info, VaultV2State>>,
}

