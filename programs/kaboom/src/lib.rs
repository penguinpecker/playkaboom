//! PlayKaboom — provably-fair Mines on Solana.
//!
//! Architecture: server-assisted commit-reveal.
//!   - On-chain: bets, fairness verification, settlements, payouts, player stats, referrals.
//!   - Off-chain: mine layout generation, tile reveals, proof publication.
//!
//! On-chain accounts:
//!   - Vault       — house bankroll, config, treasury withdrawal allowlist
//!   - GameSession — one active game per player
//!   - PlayerStats — lifetime player stats, optional referrer
//!   - ReferralAccount — per-referrer accrual + tier
//!
//! Security:
//!   - Commitment is immutable once `start_game` lands; settlement verifies SHA-256.
//!   - Three independent roles: owner, house_authority, treasury (Squads multisig keys).
//!   - Treasury withdrawals only land in pre-allowlisted addresses.
//!   - 300-slot expiry → player can refund without house cooperation.
//!   - Referral cuts come from the house edge stream — vault-funded, atomic.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use sha2::{Digest, Sha256};

declare_id!("Kab1TestProgam11111111111111111111111111111");

// ─── Constants ───────────────────────────────────────────────────────────────

pub const GRID_SIZE: u8 = 16;
pub const MIN_MINES: u8 = 1;
pub const MAX_MINES: u8 = 12;
pub const BPS: u64 = 10_000;
pub const GAME_EXPIRY_SLOTS: u64 = 300;
pub const MIN_BET_LAMPORTS: u64 = 1_000_000;

pub const MAX_HOUSE_EDGE_BPS: u16 = 1_000; // 10%
pub const MAX_BET_BPS: u16 = 1_000; // 10% of vault per bet
pub const MAX_PAYOUT_BPS: u16 = 5_000; // 50% of vault per payout

/// Treasury withdrawal allowlist size. Squads + cold storage + 6 spare.
pub const MAX_ALLOWLIST: usize = 8;

/// Referral payout in bps of the bet (= 25/30/35% of the 2% house edge).
pub const REFERRAL_BRONZE_BPS: u16 = 50; // 0.50% of bet
pub const REFERRAL_SILVER_BPS: u16 = 60; // 0.60%
pub const REFERRAL_GOLD_BPS: u16 = 70; // 0.70%
/// Volume thresholds for tier upgrades (in lamports).
pub const SILVER_VOLUME_LAMPORTS: u64 = 10_000_000_000; // 10 SOL
pub const GOLD_VOLUME_LAMPORTS: u64 = 100_000_000_000; // 100 SOL

// ─── PDA seeds ───────────────────────────────────────────────────────────────

pub const VAULT_SEED: &[u8] = b"kaboom_vault";
pub const GAME_SEED: &[u8] = b"kaboom_game";
pub const STATS_SEED: &[u8] = b"kaboom_stats";
pub const REFERRAL_SEED: &[u8] = b"kaboom_referral";

// ─── Program ─────────────────────────────────────────────────────────────────

#[program]
pub mod kaboom {
    use super::*;

    /// One-time setup. Treasury defaults to 50% split. Withdrawal allowlist
    /// starts empty (must be set via `update_vault` before any treasury withdrawal).
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
        vault.treasury_split_bps = 5_000; // 50% default
        vault.total_games = 0;
        vault.total_wagered = 0;
        vault.total_payouts = 0;
        vault.paused = false;
        vault.version = 1;
        vault.allowlist_count = 0;
        vault.withdraw_allowlist = [Pubkey::default(); MAX_ALLOWLIST];

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

    /// Player attaches a referrer (one-time, immutable). Initializes their
    /// PlayerStats if not yet, plus the referrer's ReferralAccount if it's
    /// the first time anyone referred them. Player pays rent.
    ///
    /// Cannot reference yourself. Can be called before or after first game,
    /// but only succeeds if `player_stats.referrer == None`.
    pub fn set_referrer(ctx: Context<SetReferrer>) -> Result<()> {
        let referrer_key = ctx.accounts.referral_account.referrer;
        require!(
            referrer_key != ctx.accounts.player.key(),
            KaboomError::SelfReferral
        );

        let stats = &mut ctx.accounts.player_stats;

        // First-time stats init?
        if stats.player == Pubkey::default() {
            stats.player = ctx.accounts.player.key();
            stats.bump = ctx.bumps.player_stats;
            stats.version = 1;
        }
        require!(stats.referrer.is_none(), KaboomError::ReferrerAlreadySet);
        stats.referrer = Some(referrer_key);

        // First-time referral account init?
        let referral = &mut ctx.accounts.referral_account;
        if referral.referrer == Pubkey::default() {
            referral.referrer = referrer_key;
            referral.bump = ctx.bumps.referral_account;
            referral.tier = 0;
            referral.version = 1;
        }
        referral.referred_count = referral.referred_count.saturating_add(1);

        emit!(ReferrerSet {
            player: ctx.accounts.player.key(),
            referrer: referrer_key,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Player begins a game. Initializes their PlayerStats if not yet.
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

        let max_bet = mul_div_floor(available, vault.max_bet_bps as u64, BPS)?;
        require!(bet <= max_bet, KaboomError::BetExceedsMax);

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

        // First-time stats init?
        let stats = &mut ctx.accounts.player_stats;
        if stats.player == Pubkey::default() {
            stats.player = ctx.accounts.player.key();
            stats.bump = ctx.bumps.player_stats;
            stats.version = 1;
        }

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
        game.multiplier_bps = BPS;
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

    /// House signs each tile reveal.
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

        let vault_info = ctx.accounts.vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(Vault::SPACE);
        let available = vault_info.lamports().saturating_sub(rent);
        require!(payout <= available, KaboomError::VaultInsufficientFunds);

        // Direct lamport transfer.
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

    /// House publishes the proof and updates per-player stats. If the player
    /// has a referrer, credits their `ReferralAccount` with the rakeback cut
    /// (drawn from the vault's house-edge bucket).
    ///
    /// Required accounts:
    ///   vault, game, player_stats, house_authority, system_program
    /// Optional `remaining_accounts[0]`: ReferralAccount (mut) — must match
    /// `player_stats.referrer`'s PDA. If absent, no credit happens (server
    /// must include it whenever the player has a referrer).
    pub fn settle_game<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleGame<'info>>,
        mine_layout: u16,
        salt: [u8; 32],
    ) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::Won || game.status == GameStatus::Lost,
            KaboomError::GameNotPlaying
        );
        require!(!game.settled, KaboomError::GameAlreadySettled);

        // Verify commitment.
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

        let actual_mine_count = mine_layout.count_ones() as u8;
        require!(
            actual_mine_count == game.mine_count,
            KaboomError::CommitmentMismatch
        );
        require!(
            game.revealed_safe_mask & mine_layout == 0,
            KaboomError::RevealMismatch
        );
        let revealed_mine_mask = game.revealed_mask & !game.revealed_safe_mask;
        require!(
            revealed_mine_mask & mine_layout == revealed_mine_mask,
            KaboomError::RevealMismatch
        );
        if game.status == GameStatus::Lost {
            require!(revealed_mine_mask != 0, KaboomError::RevealMismatch);
        }

        game.mine_layout = mine_layout;
        game.salt = salt;
        game.settled = true;

        // Update player stats.
        let stats = &mut ctx.accounts.player_stats;
        if stats.player == Pubkey::default() {
            stats.player = game.player;
            stats.bump = ctx.bumps.player_stats;
            stats.version = 1;
        }
        stats.games_played = stats.games_played.saturating_add(1);
        stats.total_wagered = stats.total_wagered.saturating_add(game.bet);
        stats.last_played = Clock::get()?.unix_timestamp;

        let payout: u64 = if game.status == GameStatus::Won {
            (game.bet as u128)
                .checked_mul(game.multiplier_bps as u128)
                .ok_or(KaboomError::MathOverflow)?
                .checked_div(BPS as u128)
                .ok_or(KaboomError::MathOverflow)?
                .try_into()
                .map_err(|_| KaboomError::MathOverflow)?
        } else {
            0
        };

        if game.status == GameStatus::Won {
            stats.games_won = stats.games_won.saturating_add(1);
            stats.total_payouts = stats.total_payouts.saturating_add(payout);
            let net_win = payout.saturating_sub(game.bet);
            if net_win > stats.biggest_win {
                stats.biggest_win = net_win;
            }
            if game.multiplier_bps > stats.biggest_multiplier_bps {
                stats.biggest_multiplier_bps = game.multiplier_bps;
            }
            stats.current_streak = stats.current_streak.saturating_add(1);
            if stats.current_streak > stats.best_streak {
                stats.best_streak = stats.current_streak;
            }
        } else {
            stats.current_streak = 0;
        }

        // Referral credit, if referrer is set AND ReferralAccount provided.
        if let Some(referrer_key) = stats.referrer {
            if let Some(referral_info) = ctx.remaining_accounts.first() {
                let mut ra: Account<ReferralAccount> = Account::try_from(referral_info)?;
                require!(ra.referrer == referrer_key, KaboomError::ReferralMismatch);

                let cut_bps = match ra.tier {
                    0 => REFERRAL_BRONZE_BPS,
                    1 => REFERRAL_SILVER_BPS,
                    _ => REFERRAL_GOLD_BPS,
                };
                let cut = mul_div_floor(game.bet, cut_bps as u64, BPS)?;

                let vault_info = ctx.accounts.vault.to_account_info();
                let rent = Rent::get()?.minimum_balance(Vault::SPACE);
                let vault_available = vault_info.lamports().saturating_sub(rent);
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
                ra.referred_volume = ra.referred_volume.saturating_add(game.bet);

                let new_tier = if ra.referred_volume >= GOLD_VOLUME_LAMPORTS {
                    2
                } else if ra.referred_volume >= SILVER_VOLUME_LAMPORTS {
                    1
                } else {
                    0
                };
                if new_tier != ra.tier {
                    ra.tier = new_tier;
                    emit!(ReferralTierChanged {
                        referrer: ra.referrer,
                        new_tier,
                        slot: Clock::get()?.slot,
                    });
                }

                ra.exit(&crate::ID)?;

                emit!(ReferralAccrued {
                    referrer: referrer_key,
                    player: game.player,
                    amount: actual_cut,
                    tier: ra.tier,
                    slot: Clock::get()?.slot,
                });
            }
        }

        emit!(GameSettled {
            player: game.player,
            game: game.key(),
            mine_count: game.mine_count,
            mine_layout,
            salt,
            commitment: game.commitment,
            verified: true,
            slot: Clock::get()?.slot,
        });
        emit!(StatsUpdated {
            player: stats.player,
            games_played: stats.games_played,
            games_won: stats.games_won,
            total_wagered: stats.total_wagered,
            total_payouts: stats.total_payouts,
            biggest_win: stats.biggest_win,
            current_streak: stats.current_streak,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Referrer withdraws their accrued rakeback to their wallet.
    pub fn claim_referral(ctx: Context<ClaimReferral>) -> Result<()> {
        let referral = &mut ctx.accounts.referral_account;
        let amount = referral.accrued_lamports;
        require!(amount > 0, KaboomError::NothingToClaim);

        let referral_info = referral.to_account_info();
        let rent = Rent::get()?.minimum_balance(ReferralAccount::SPACE);
        let withdrawable = referral_info.lamports().saturating_sub(rent);
        let payout = amount.min(withdrawable);

        **referral_info.try_borrow_mut_lamports()? = referral_info
            .lamports()
            .checked_sub(payout)
            .ok_or(KaboomError::MathOverflow)?;
        let referrer_info = ctx.accounts.referrer.to_account_info();
        **referrer_info.try_borrow_mut_lamports()? = referrer_info
            .lamports()
            .checked_add(payout)
            .ok_or(KaboomError::MathOverflow)?;

        referral.accrued_lamports = referral.accrued_lamports.saturating_sub(payout);

        emit!(ReferralClaimed {
            referrer: referral.referrer,
            amount: payout,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Player recovers their bet if the house has gone silent past expiry.
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

    /// Treasury withdraws to an allowlisted destination. Treasury signer required.
    pub fn withdraw_to_treasury(
        ctx: Context<WithdrawToTreasury>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, KaboomError::InvalidAmount);

        let vault = &ctx.accounts.vault;
        let dest_key = ctx.accounts.destination.key();
        let allowed = vault
            .withdraw_allowlist
            .iter()
            .take(vault.allowlist_count as usize)
            .any(|k| *k == dest_key);
        require!(allowed, KaboomError::DestinationNotAllowlisted);

        let vault_info = ctx.accounts.vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(Vault::SPACE);
        let available = vault_info.lamports().saturating_sub(rent);
        let withdraw = amount.min(available);

        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(withdraw)
            .ok_or(KaboomError::MathOverflow)?;
        let dest_info = ctx.accounts.destination.to_account_info();
        **dest_info.try_borrow_mut_lamports()? = dest_info
            .lamports()
            .checked_add(withdraw)
            .ok_or(KaboomError::MathOverflow)?;

        emit!(TreasuryWithdrawal {
            treasury: ctx.accounts.treasury.key(),
            destination: dest_key,
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
        treasury_split_bps: Option<u16>,
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
        if let Some(t) = treasury_split_bps {
            require!(t <= BPS as u16, KaboomError::InvalidConfig);
            vault.treasury_split_bps = t;
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

    /// Owner adds an address to the treasury withdrawal allowlist.
    pub fn allowlist_add(ctx: Context<UpdateVault>, address: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            (vault.allowlist_count as usize) < MAX_ALLOWLIST,
            KaboomError::AllowlistFull
        );
        let existing = vault
            .withdraw_allowlist
            .iter()
            .take(vault.allowlist_count as usize)
            .any(|k| *k == address);
        require!(!existing, KaboomError::AlreadyAllowlisted);
        let slot = vault.allowlist_count as usize;
        vault.withdraw_allowlist[slot] = address;
        vault.allowlist_count = vault.allowlist_count.saturating_add(1);

        emit!(AllowlistChanged {
            vault: vault.key(),
            address,
            added: true,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Owner removes an address from the allowlist (compacts the slot).
    pub fn allowlist_remove(ctx: Context<UpdateVault>, address: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let count = vault.allowlist_count as usize;
        let mut found = None;
        for i in 0..count {
            if vault.withdraw_allowlist[i] == address {
                found = Some(i);
                break;
            }
        }
        let idx = found.ok_or(KaboomError::AddressNotInAllowlist)?;
        // Compact: move last into found slot, zero last.
        let last = count - 1;
        if idx != last {
            vault.withdraw_allowlist[idx] = vault.withdraw_allowlist[last];
        }
        vault.withdraw_allowlist[last] = Pubkey::default();
        vault.allowlist_count = (count - 1) as u8;

        emit!(AllowlistChanged {
            vault: vault.key(),
            address,
            added: false,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }
}

// ─── Multiplier ──────────────────────────────────────────────────────────────

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
    pub treasury_split_bps: u16,
    pub total_games: u64,
    pub total_wagered: u64,
    pub total_payouts: u64,
    pub paused: bool,
    pub version: u8,
    pub allowlist_count: u8,
    pub withdraw_allowlist: [Pubkey; MAX_ALLOWLIST],
    pub _reserved: [u8; 32],
}

impl Vault {
    pub const SPACE: usize = 8   // discriminator
        + 32 + 32 + 32 // owner + house_authority + treasury
        + 1            // bump
        + 2 + 2 + 2 + 2 // 4 u16 bps fields
        + 8 + 8 + 8    // 3 u64 counters
        + 1 + 1 + 1    // paused + version + allowlist_count
        + 32 * MAX_ALLOWLIST
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
    pub const SPACE: usize = 8
        + 32 + 1 + 1
        + 8 + 1 + 32
        + 2 + 2 + 1
        + 8 + 8 + 8
        + 1 + 2 + 32
        + 1 + 32;
}

/// Per-player lifetime stats. Source of truth for leaderboards.
#[account]
pub struct PlayerStats {
    pub player: Pubkey,
    pub bump: u8,
    pub version: u8,
    pub games_played: u64,
    pub games_won: u64,
    pub total_wagered: u64,
    pub total_payouts: u64,
    pub biggest_win: u64,
    pub biggest_multiplier_bps: u64,
    pub current_streak: u32,
    pub best_streak: u32,
    pub last_played: i64,
    pub referrer: Option<Pubkey>,
    pub _reserved: [u8; 64],
}

impl PlayerStats {
    pub const SPACE: usize = 8
        + 32 + 1 + 1
        + 8 + 8 + 8 + 8 + 8 + 8
        + 4 + 4 + 8
        + 1 + 32 // Option<Pubkey> = 1 tag + 32 bytes
        + 64;
}

/// Per-referrer accrual + tier.
#[account]
pub struct ReferralAccount {
    pub referrer: Pubkey,
    pub bump: u8,
    pub version: u8,
    pub tier: u8, // 0=bronze, 1=silver, 2=gold
    pub accrued_lamports: u64,
    pub total_earned: u64,
    pub referred_count: u32,
    pub referred_volume: u64,
    pub _reserved: [u8; 32],
}

impl ReferralAccount {
    pub const SPACE: usize = 8
        + 32 + 1 + 1 + 1
        + 8 + 8 + 4 + 8
        + 32;
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
pub struct SetReferrer<'info> {
    #[account(
        init_if_needed,
        payer = player,
        space = PlayerStats::SPACE,
        seeds = [STATS_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_stats: Account<'info, PlayerStats>,

    /// CHECK: referrer pubkey is read from `referral_account`'s seeds.
    pub referrer: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = player,
        space = ReferralAccount::SPACE,
        seeds = [REFERRAL_SEED, referrer.key().as_ref()],
        bump,
    )]
    pub referral_account: Account<'info, ReferralAccount>,

    #[account(mut)]
    pub player: Signer<'info>,

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

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerStats::SPACE,
        seeds = [STATS_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_stats: Account<'info, PlayerStats>,

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
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GAME_SEED, game.player.as_ref()],
        bump = game.bump,
    )]
    pub game: Account<'info, GameSession>,

    #[account(
        mut,
        seeds = [STATS_SEED, game.player.as_ref()],
        bump,
    )]
    pub player_stats: Account<'info, PlayerStats>,

    #[account(constraint = house_authority.key() == vault.house_authority @ KaboomError::Unauthorized)]
    pub house_authority: Signer<'info>,
    // Optional: remaining_accounts[0] = ReferralAccount of stats.referrer (mut)
}

#[derive(Accounts)]
pub struct ClaimReferral<'info> {
    #[account(
        mut,
        seeds = [REFERRAL_SEED, referrer.key().as_ref()],
        bump = referral_account.bump,
        constraint = referral_account.referrer == referrer.key() @ KaboomError::Unauthorized,
    )]
    pub referral_account: Account<'info, ReferralAccount>,

    #[account(mut)]
    pub referrer: Signer<'info>,
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

    pub treasury: Signer<'info>,

    /// CHECK: must match an entry in `vault.withdraw_allowlist`.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
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
    #[msg("Invalid mine count.")]
    InvalidMineCount,
    #[msg("Invalid tile index.")]
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
    #[msg("Game has expired.")]
    GameExpired,
    #[msg("Game has not expired yet.")]
    GameNotExpired,
    #[msg("Commitment hash does not match mine_layout + salt.")]
    CommitmentMismatch,
    #[msg("Revealed tiles do not match the layout.")]
    RevealMismatch,
    #[msg("Game already settled.")]
    GameAlreadySettled,
    #[msg("Game not finished.")]
    GameNotFinished,
    #[msg("No tiles revealed.")]
    NoTilesRevealed,
    #[msg("Cannot refer yourself.")]
    SelfReferral,
    #[msg("Referrer already set.")]
    ReferrerAlreadySet,
    #[msg("Referral account does not match player_stats.referrer.")]
    ReferralMismatch,
    #[msg("Nothing to claim.")]
    NothingToClaim,
    #[msg("Withdrawal destination is not on the allowlist.")]
    DestinationNotAllowlisted,
    #[msg("Allowlist is full.")]
    AllowlistFull,
    #[msg("Address is already on the allowlist.")]
    AlreadyAllowlisted,
    #[msg("Address is not on the allowlist.")]
    AddressNotInAllowlist,
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
pub struct AllowlistChanged {
    pub vault: Pubkey,
    pub address: Pubkey,
    pub added: bool,
    pub slot: u64,
}

#[event]
pub struct TreasuryWithdrawal {
    pub treasury: Pubkey,
    pub destination: Pubkey,
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
    pub mine_count: u8,
    pub mine_layout: u16,
    pub salt: [u8; 32],
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

#[event]
pub struct StatsUpdated {
    pub player: Pubkey,
    pub games_played: u64,
    pub games_won: u64,
    pub total_wagered: u64,
    pub total_payouts: u64,
    pub biggest_win: u64,
    pub current_streak: u32,
    pub slot: u64,
}

#[event]
pub struct ReferrerSet {
    pub player: Pubkey,
    pub referrer: Pubkey,
    pub slot: u64,
}

#[event]
pub struct ReferralAccrued {
    pub referrer: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub tier: u8,
    pub slot: u64,
}

#[event]
pub struct ReferralTierChanged {
    pub referrer: Pubkey,
    pub new_tier: u8,
    pub slot: u64,
}

#[event]
pub struct ReferralClaimed {
    pub referrer: Pubkey,
    pub amount: u64,
    pub slot: u64,
}
