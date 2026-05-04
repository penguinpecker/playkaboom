//! PlayKaboom — provably-fair Mines on Solana.
//!
//! Architecture: server-assisted commit-reveal.
//!   - On-chain: bets, fairness verification, settlements, payouts.
//!   - Off-chain: mine layout generation, tile reveals, proof publication.
//!
//! Security:
//!   - Commitment is immutable once `start_game` lands; settlement verifies SHA-256.
//!   - Multiplier math uses u128 with checked/saturating ops.
//!   - Three independent roles: owner, house_authority, treasury.
//!   - 300-slot expiry → player can refund without house cooperation.
//!   - Single active game per player (prevents rent-griefing).
//!   - Withdrawals from vault require `treasury` signer (separate from `owner`).

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use sha2::{Digest, Sha256};

declare_id!("Kab1TestProgam11111111111111111111111111111");

// ─── Constants ───────────────────────────────────────────────────────────────

/// 4 × 4 grid.
pub const GRID_SIZE: u8 = 16;
/// Bounds on configurable mine count.
pub const MIN_MINES: u8 = 1;
pub const MAX_MINES: u8 = 12;
/// Basis-points denominator (10_000 == 100.00%).
pub const BPS: u64 = 10_000;
/// Game must complete within this many slots (~2 min at 400 ms/slot).
pub const GAME_EXPIRY_SLOTS: u64 = 300;
/// Floor on the bet — prevents dust spam and rounding pathology.
pub const MIN_BET_LAMPORTS: u64 = 1_000_000;
/// Hard caps enforced at config time.
pub const MAX_HOUSE_EDGE_BPS: u16 = 1_000; // 10%
pub const MAX_BET_BPS: u16 = 1_000; // 10% of available vault per bet
pub const MAX_PAYOUT_BPS: u16 = 5_000; // 50% of available vault per payout

// ─── PDA seeds ───────────────────────────────────────────────────────────────

pub const VAULT_SEED: &[u8] = b"kaboom_vault";
pub const GAME_SEED: &[u8] = b"kaboom_game";

// ─── Program ─────────────────────────────────────────────────────────────────

#[program]
pub mod kaboom {
    use super::*;

    /// One-time setup. `owner` pays the rent, `treasury` is the only key that
    /// can withdraw vault profits, `house_authority` reveals tiles & settles.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        house_edge_bps: u16,
        max_bet_bps: u16,
        max_payout_bps: u16,
    ) -> Result<()> {
        require!(house_edge_bps <= MAX_HOUSE_EDGE_BPS, KaboomError::InvalidConfig);
        require!(
            max_bet_bps > 0 && max_bet_bps <= MAX_BET_BPS,
            KaboomError::InvalidConfig
        );
        require!(
            max_payout_bps > 0 && max_payout_bps <= MAX_PAYOUT_BPS,
            KaboomError::InvalidConfig
        );

        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.house_authority = ctx.accounts.house_authority.key();
        vault.treasury = ctx.accounts.treasury.key();
        vault.bump = ctx.bumps.vault;
        vault.house_edge_bps = house_edge_bps;
        vault.max_bet_bps = max_bet_bps;
        vault.max_payout_bps = max_payout_bps;
        vault.total_games = 0;
        vault.total_wagered = 0;
        vault.total_payouts = 0;
        vault.paused = false;
        vault.version = 1;

        emit!(VaultInitialized {
            vault: vault.key(),
            owner: vault.owner,
            house_authority: vault.house_authority,
            treasury: vault.treasury,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Anyone can deposit liquidity into the vault.
    pub fn fund_vault(ctx: Context<FundVault>, amount: u64) -> Result<()> {
        require!(amount > 0, KaboomError::InvalidAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.funder.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(VaultFunded {
            funder: ctx.accounts.funder.key(),
            amount,
            new_balance: ctx.accounts.vault.to_account_info().lamports(),
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Player begins a game. Server must have already generated:
    ///   commitment = SHA256(layout_le_bytes(2) || mine_count(1) || salt(32))
    pub fn start_game(
        ctx: Context<StartGame>,
        mine_count: u8,
        bet: u64,
        commitment: [u8; 32],
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(!vault.paused, KaboomError::VaultPaused);
        require!(
            (MIN_MINES..=MAX_MINES).contains(&mine_count),
            KaboomError::InvalidMineCount
        );
        require!(bet >= MIN_BET_LAMPORTS, KaboomError::BetTooLow);
        require!(commitment != [0u8; 32], KaboomError::InvalidCommitment);

        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let rent = Rent::get()?.minimum_balance(Vault::SPACE);
        let available = vault_lamports.saturating_sub(rent);

        // Bet cap.
        let max_bet = mul_div_floor(available, vault.max_bet_bps as u64, BPS)?;
        require!(bet <= max_bet, KaboomError::BetExceedsMax);

        // Worst-case payout (full clear) must fit inside max_payout.
        let worst_safe = GRID_SIZE.saturating_sub(mine_count);
        let worst_multiplier = calc_multiplier(worst_safe, mine_count, vault.house_edge_bps)?;
        let worst_payout = (bet as u128)
            .checked_mul(worst_multiplier as u128)
            .ok_or(KaboomError::MathOverflow)?
            .checked_div(BPS as u128)
            .ok_or(KaboomError::MathOverflow)?;
        let max_payout = mul_div_floor(available, vault.max_payout_bps as u64, BPS)? as u128;
        require!(
            worst_payout <= max_payout,
            KaboomError::VaultInsufficientFunds
        );

        // Lock the bet.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            bet,
        )?;

        let clock = Clock::get()?;
        let game = &mut ctx.accounts.game;
        game.player = ctx.accounts.player.key();
        game.bump = ctx.bumps.game;
        game.status = GameStatus::Playing;
        game.bet = bet;
        game.mine_count = mine_count;
        game.commitment = commitment;
        game.revealed_mask = 0;
        game.revealed_safe_mask = 0;
        game.safe_reveals = 0;
        game.multiplier_bps = BPS; // 1.0×
        game.start_slot = clock.slot;
        game.created_at = clock.unix_timestamp;
        game.settled = false;
        game.mine_layout = 0;
        game.salt = [0u8; 32];
        game.version = 1;

        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.total_games = vault_mut.total_games.saturating_add(1);
        vault_mut.total_wagered = vault_mut.total_wagered.saturating_add(bet);

        emit!(GameStarted {
            player: game.player,
            game: game.key(),
            bet,
            mine_count,
            commitment,
            slot: clock.slot,
        });
        Ok(())
    }

    /// House signs each tile reveal. The on-chain account merely records the
    /// claim; settlement is what binds it to the commitment.
    pub fn reveal_tile(ctx: Context<RevealTile>, tile_index: u8, is_mine: bool) -> Result<()> {
        require!(tile_index < GRID_SIZE, KaboomError::InvalidTileIndex);

        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::Playing,
            KaboomError::GameNotPlaying
        );

        let clock = Clock::get()?;
        require!(
            clock.slot <= game.start_slot.saturating_add(GAME_EXPIRY_SLOTS),
            KaboomError::GameExpired
        );

        let tile_bit: u16 = 1u16 << tile_index;
        require!(
            game.revealed_mask & tile_bit == 0,
            KaboomError::TileAlreadyRevealed
        );

        game.revealed_mask |= tile_bit;

        if is_mine {
            game.status = GameStatus::Lost;
            emit!(TileRevealed {
                player: game.player,
                game: game.key(),
                tile_index,
                is_mine: true,
                multiplier_bps: game.multiplier_bps,
                safe_reveals: game.safe_reveals,
                slot: clock.slot,
            });
            emit!(GameLost {
                player: game.player,
                game: game.key(),
                bet: game.bet,
                tile_index,
                safe_reveals: game.safe_reveals,
                slot: clock.slot,
            });
        } else {
            game.revealed_safe_mask |= tile_bit;
            game.safe_reveals = game.safe_reveals.saturating_add(1);

            let vault = &ctx.accounts.vault;
            game.multiplier_bps =
                calc_multiplier(game.safe_reveals, game.mine_count, vault.house_edge_bps)?;

            let total_safe = GRID_SIZE - game.mine_count;
            if game.safe_reveals >= total_safe {
                game.status = GameStatus::Won;
            }

            emit!(TileRevealed {
                player: game.player,
                game: game.key(),
                tile_index,
                is_mine: false,
                multiplier_bps: game.multiplier_bps,
                safe_reveals: game.safe_reveals,
                slot: clock.slot,
            });
        }

        Ok(())
    }

    /// Player exits with current multiplier. Requires ≥1 safe reveal.
    pub fn cash_out(ctx: Context<CashOut>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::Playing,
            KaboomError::GameNotPlaying
        );
        require!(game.safe_reveals > 0, KaboomError::NoTilesRevealed);

        let payout = (game.bet as u128)
            .checked_mul(game.multiplier_bps as u128)
            .ok_or(KaboomError::MathOverflow)?
            .checked_div(BPS as u128)
            .ok_or(KaboomError::MathOverflow)?;
        let payout = u64::try_from(payout).map_err(|_| KaboomError::MathOverflow)?;

        // Defense in depth: rent-aware solvency check at payout time.
        let vault_info = ctx.accounts.vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(Vault::SPACE);
        let available = vault_info.lamports().saturating_sub(rent);
        require!(payout <= available, KaboomError::VaultInsufficientFunds);

        // Direct lamport transfer (vault holds plain SOL, not a token account).
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(payout)
            .ok_or(KaboomError::MathOverflow)?;
        let player_info = ctx.accounts.player.to_account_info();
        **player_info.try_borrow_mut_lamports()? = player_info
            .lamports()
            .checked_add(payout)
            .ok_or(KaboomError::MathOverflow)?;

        game.status = GameStatus::Won;

        let vault = &mut ctx.accounts.vault;
        vault.total_payouts = vault.total_payouts.saturating_add(payout);

        emit!(GameWon {
            player: game.player,
            game: game.key(),
            bet: game.bet,
            payout,
            multiplier_bps: game.multiplier_bps,
            safe_reveals: game.safe_reveals,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// House publishes the proof: the actual layout + salt that hash to the commitment.
    /// Verifies every recorded reveal is consistent with the layout.
    pub fn settle_game(
        ctx: Context<SettleGame>,
        mine_layout: u16,
        salt: [u8; 32],
    ) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::Won || game.status == GameStatus::Lost,
            KaboomError::GameNotPlaying
        );
        require!(!game.settled, KaboomError::GameAlreadySettled);

        let layout_bytes = mine_layout.to_le_bytes();
        let mut hasher = Sha256::new();
        hasher.update(layout_bytes);
        hasher.update([game.mine_count]);
        hasher.update(salt);
        let computed = hasher.finalize();
        require!(
            computed.as_slice() == game.commitment,
            KaboomError::CommitmentMismatch
        );

        // Layout integrity.
        let actual_mine_count = mine_layout.count_ones() as u8;
        require!(
            actual_mine_count == game.mine_count,
            KaboomError::CommitmentMismatch
        );

        // No safe reveal can overlap a mine.
        require!(
            game.revealed_safe_mask & mine_layout == 0,
            KaboomError::RevealMismatch
        );

        // Every "mine" reveal must actually be a mine.
        let revealed_mine_mask = game.revealed_mask & !game.revealed_safe_mask;
        require!(
            revealed_mine_mask & mine_layout == revealed_mine_mask,
            KaboomError::RevealMismatch
        );

        // Lost games must have at least one mine reveal.
        if game.status == GameStatus::Lost {
            require!(revealed_mine_mask != 0, KaboomError::RevealMismatch);
        }

        game.mine_layout = mine_layout;
        game.salt = salt;
        game.settled = true;

        emit!(GameSettled {
            player: game.player,
            game: game.key(),
            mine_layout,
            commitment: game.commitment,
            verified: true,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// If the house has gone silent, the player can recover their bet after expiry.
    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::Playing,
            KaboomError::GameNotPlaying
        );

        let clock = Clock::get()?;
        require!(
            clock.slot > game.start_slot.saturating_add(GAME_EXPIRY_SLOTS),
            KaboomError::GameNotExpired
        );

        let vault_info = ctx.accounts.vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(Vault::SPACE);
        let available = vault_info.lamports().saturating_sub(rent);
        let refund = game.bet.min(available);

        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(refund)
            .ok_or(KaboomError::MathOverflow)?;
        let player_info = ctx.accounts.player.to_account_info();
        **player_info.try_borrow_mut_lamports()? = player_info
            .lamports()
            .checked_add(refund)
            .ok_or(KaboomError::MathOverflow)?;

        game.status = GameStatus::Expired;

        emit!(GameRefunded {
            player: game.player,
            game: game.key(),
            bet: game.bet,
            refund,
            slot: clock.slot,
        });
        Ok(())
    }

    /// Reclaim rent. Game must be Expired or settled.
    pub fn close_game(ctx: Context<CloseGame>) -> Result<()> {
        let game = &ctx.accounts.game;
        require!(
            game.status == GameStatus::Expired
                || (game.settled
                    && (game.status == GameStatus::Won || game.status == GameStatus::Lost)),
            KaboomError::GameNotFinished
        );
        Ok(())
    }

    /// Treasury withdraws profits. Owner can update config but not move funds.
    pub fn withdraw_to_treasury(ctx: Context<WithdrawToTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, KaboomError::InvalidAmount);

        let vault_info = ctx.accounts.vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(Vault::SPACE);
        let available = vault_info.lamports().saturating_sub(rent);
        let withdraw = amount.min(available);

        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(withdraw)
            .ok_or(KaboomError::MathOverflow)?;
        let treasury_info = ctx.accounts.treasury.to_account_info();
        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(withdraw)
            .ok_or(KaboomError::MathOverflow)?;

        emit!(TreasuryWithdrawal {
            treasury: ctx.accounts.treasury.key(),
            amount: withdraw,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Owner-only config update. Cannot move funds, cannot change owner.
    pub fn update_vault(
        ctx: Context<UpdateVault>,
        house_edge_bps: Option<u16>,
        max_bet_bps: Option<u16>,
        max_payout_bps: Option<u16>,
        paused: Option<bool>,
        new_house_authority: Option<Pubkey>,
        new_treasury: Option<Pubkey>,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        if let Some(edge) = house_edge_bps {
            require!(edge <= MAX_HOUSE_EDGE_BPS, KaboomError::InvalidConfig);
            vault.house_edge_bps = edge;
        }
        if let Some(b) = max_bet_bps {
            require!(b > 0 && b <= MAX_BET_BPS, KaboomError::InvalidConfig);
            vault.max_bet_bps = b;
        }
        if let Some(p) = max_payout_bps {
            require!(p > 0 && p <= MAX_PAYOUT_BPS, KaboomError::InvalidConfig);
            vault.max_payout_bps = p;
        }
        if let Some(p) = paused {
            vault.paused = p;
        }
        if let Some(auth) = new_house_authority {
            vault.house_authority = auth;
        }
        if let Some(t) = new_treasury {
            vault.treasury = t;
        }

        emit!(VaultUpdated {
            vault: vault.key(),
            slot: Clock::get()?.slot,
        });
        Ok(())
    }
}

// ─── Multiplier ──────────────────────────────────────────────────────────────

/// Multiplier in basis points. Hypergeometric expectation, with house edge.
///
/// Identity: ∏(i=0..n-1) ((total - i) / (safe_remaining - i)) * (1 - edge)
///
/// Returns BPS for `safe_reveals == 0`.
fn calc_multiplier(safe_reveals: u8, mine_count: u8, house_edge_bps: u16) -> Result<u64> {
    if safe_reveals == 0 {
        return Ok(BPS);
    }
    require!(
        (mine_count as u64) + (safe_reveals as u64) <= GRID_SIZE as u64,
        KaboomError::InvalidMineCount
    );

    let total = GRID_SIZE as u128;
    let mines = mine_count as u128;
    // Build numerator and denominator separately to avoid compounding rounding.
    let mut num: u128 = 1;
    let mut den: u128 = 1;
    for i in 0..safe_reveals as u128 {
        let tiles_remaining = total
            .checked_sub(i)
            .ok_or(KaboomError::MathOverflow)?;
        let safe_remaining = total
            .checked_sub(mines)
            .and_then(|v| v.checked_sub(i))
            .ok_or(KaboomError::MathOverflow)?;
        require!(safe_remaining > 0, KaboomError::InvalidMineCount);

        num = num
            .checked_mul(tiles_remaining)
            .ok_or(KaboomError::MathOverflow)?;
        den = den
            .checked_mul(safe_remaining)
            .ok_or(KaboomError::MathOverflow)?;
    }

    // result_bps = (num * BPS / den) * (BPS - edge) / BPS
    let raw_bps = num
        .checked_mul(BPS as u128)
        .ok_or(KaboomError::MathOverflow)?
        .checked_div(den)
        .ok_or(KaboomError::MathOverflow)?;
    let edge_factor = (BPS - house_edge_bps as u64) as u128;
    let final_bps = raw_bps
        .checked_mul(edge_factor)
        .ok_or(KaboomError::MathOverflow)?
        .checked_div(BPS as u128)
        .ok_or(KaboomError::MathOverflow)?;

    u64::try_from(final_bps).map_err(|_| KaboomError::MathOverflow.into())
}

/// Floor of `a * num / den` without intermediate overflow.
fn mul_div_floor(a: u64, num: u64, den: u64) -> Result<u64> {
    let v = (a as u128)
        .checked_mul(num as u128)
        .ok_or(KaboomError::MathOverflow)?
        .checked_div(den as u128)
        .ok_or(KaboomError::MathOverflow)?;
    u64::try_from(v).map_err(|_| KaboomError::MathOverflow.into())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub house_authority: Pubkey,
    pub treasury: Pubkey,
    pub bump: u8,
    pub house_edge_bps: u16,
    pub max_bet_bps: u16,
    pub max_payout_bps: u16,
    pub total_games: u64,
    pub total_wagered: u64,
    pub total_payouts: u64,
    pub paused: bool,
    pub version: u8,
    pub _reserved: [u8; 32],
}

impl Vault {
    pub const SPACE: usize = 8   // discriminator
        + 32 // owner
        + 32 // house_authority
        + 32 // treasury
        + 1  // bump
        + 2  // house_edge_bps
        + 2  // max_bet_bps
        + 2  // max_payout_bps
        + 8  // total_games
        + 8  // total_wagered
        + 8  // total_payouts
        + 1  // paused
        + 1  // version
        + 32; // _reserved
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum GameStatus {
    Playing,
    Won,
    Lost,
    Expired,
}

#[account]
pub struct GameSession {
    pub player: Pubkey,
    pub bump: u8,
    pub status: GameStatus,
    pub bet: u64,
    pub mine_count: u8,
    pub commitment: [u8; 32],
    pub revealed_mask: u16,
    pub revealed_safe_mask: u16,
    pub safe_reveals: u8,
    pub multiplier_bps: u64,
    pub start_slot: u64,
    pub created_at: i64,
    pub settled: bool,
    pub mine_layout: u16,
    pub salt: [u8; 32],
    pub version: u8,
    pub _reserved: [u8; 32],
}

impl GameSession {
    pub const SPACE: usize = 8   // discriminator
        + 32 // player
        + 1  // bump
        + 1  // status
        + 8  // bet
        + 1  // mine_count
        + 32 // commitment
        + 2  // revealed_mask
        + 2  // revealed_safe_mask
        + 1  // safe_reveals
        + 8  // multiplier_bps
        + 8  // start_slot
        + 8  // created_at
        + 1  // settled
        + 2  // mine_layout
        + 32 // salt
        + 1  // version
        + 32; // _reserved
}

// ─── Instruction accounts ────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = owner,
        space = Vault::SPACE,
        seeds = [VAULT_SEED],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: stored as the only key authorized to reveal/settle.
    pub house_authority: UncheckedAccount<'info>,

    /// CHECK: stored as the only key authorized to receive withdrawals.
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub funder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartGame<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = player,
        space = GameSession::SPACE,
        seeds = [GAME_SEED, player.key().as_ref()],
        bump,
    )]
    pub game: Account<'info, GameSession>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealTile<'info> {
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player.as_ref()],
        bump = game.bump,
    )]
    pub game: Account<'info, GameSession>,

    #[account(constraint = house_authority.key() == vault.house_authority @ KaboomError::Unauthorized)]
    pub house_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CashOut<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player.as_ref()],
        bump = game.bump,
        constraint = game.player == player.key() @ KaboomError::Unauthorized,
    )]
    pub game: Account<'info, GameSession>,

    #[account(mut)]
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleGame<'info> {
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player.as_ref()],
        bump = game.bump,
    )]
    pub game: Account<'info, GameSession>,

    #[account(constraint = house_authority.key() == vault.house_authority @ KaboomError::Unauthorized)]
    pub house_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player.as_ref()],
        bump = game.bump,
        constraint = game.player == player.key() @ KaboomError::Unauthorized,
    )]
    pub game: Account<'info, GameSession>,

    #[account(mut)]
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseGame<'info> {
    #[account(
        mut,
        seeds = [GAME_SEED, game.player.as_ref()],
        bump = game.bump,
        constraint = game.player == player.key() @ KaboomError::Unauthorized,
        close = player,
    )]
    pub game: Account<'info, GameSession>,

    #[account(mut)]
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawToTreasury<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
        constraint = vault.treasury == treasury.key() @ KaboomError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub treasury: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateVault<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ KaboomError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    pub owner: Signer<'info>,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum KaboomError {
    #[msg("Invalid mine count. Must be 1–12 and leave at least 1 safe tile.")]
    InvalidMineCount,
    #[msg("Invalid tile index. Must be 0–15.")]
    InvalidTileIndex,
    #[msg("Tile already revealed.")]
    TileAlreadyRevealed,
    #[msg("Game is not in playing state.")]
    GameNotPlaying,
    #[msg("Bet amount too low.")]
    BetTooLow,
    #[msg("Bet exceeds max allowed for current vault balance.")]
    BetExceedsMax,
    #[msg("Vault has insufficient funds for the worst-case payout.")]
    VaultInsufficientFunds,
    #[msg("Unauthorized.")]
    Unauthorized,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Invalid amount.")]
    InvalidAmount,
    #[msg("Invalid configuration parameter.")]
    InvalidConfig,
    #[msg("Invalid commitment (zero hash).")]
    InvalidCommitment,
    #[msg("Vault is paused.")]
    VaultPaused,
    #[msg("Game has expired. Player may call refund_expired.")]
    GameExpired,
    #[msg("Game has not expired yet.")]
    GameNotExpired,
    #[msg("Commitment hash does not match mine_layout + salt.")]
    CommitmentMismatch,
    #[msg("Revealed tiles do not match the layout.")]
    RevealMismatch,
    #[msg("Game already settled.")]
    GameAlreadySettled,
    #[msg("Game not finished. Must be settled or expired to close.")]
    GameNotFinished,
    #[msg("No tiles revealed. Reveal at least one safe tile before cashing out.")]
    NoTilesRevealed,
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub house_authority: Pubkey,
    pub treasury: Pubkey,
    pub slot: u64,
}

#[event]
pub struct VaultFunded {
    pub funder: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
    pub slot: u64,
}

#[event]
pub struct VaultUpdated {
    pub vault: Pubkey,
    pub slot: u64,
}

#[event]
pub struct TreasuryWithdrawal {
    pub treasury: Pubkey,
    pub amount: u64,
    pub slot: u64,
}

#[event]
pub struct GameStarted {
    pub player: Pubkey,
    pub game: Pubkey,
    pub bet: u64,
    pub mine_count: u8,
    pub commitment: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct TileRevealed {
    pub player: Pubkey,
    pub game: Pubkey,
    pub tile_index: u8,
    pub is_mine: bool,
    pub multiplier_bps: u64,
    pub safe_reveals: u8,
    pub slot: u64,
}

#[event]
pub struct GameWon {
    pub player: Pubkey,
    pub game: Pubkey,
    pub bet: u64,
    pub payout: u64,
    pub multiplier_bps: u64,
    pub safe_reveals: u8,
    pub slot: u64,
}

#[event]
pub struct GameLost {
    pub player: Pubkey,
    pub game: Pubkey,
    pub bet: u64,
    pub tile_index: u8,
    pub safe_reveals: u8,
    pub slot: u64,
}

#[event]
pub struct GameSettled {
    pub player: Pubkey,
    pub game: Pubkey,
    pub mine_layout: u16,
    pub commitment: [u8; 32],
    pub verified: bool,
    pub slot: u64,
}

#[event]
pub struct GameRefunded {
    pub player: Pubkey,
    pub game: Pubkey,
    pub bet: u64,
    pub refund: u64,
    pub slot: u64,
}
