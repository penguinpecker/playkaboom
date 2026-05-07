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

declare_id!("4rPEGzWoD2i8k3Pr5tnJsBV7AZEK2zQJCXZe4YgwcixT");

// ─── Constants ───────────────────────────────────────────────────────────────

pub const GRID_SIZE: u8 = 16;
pub const MIN_MINES: u8 = 1;
pub const MAX_MINES: u8 = 12;
pub const BPS: u64 = 10_000;
pub const GAME_EXPIRY_SLOTS: u64 = 300;
/// Player can self-close a Won/Lost-but-unsettled game after this window.
/// Used for recovery when the server settle ix never ran (e.g. lost game
/// token, server downtime). 600 slots ≈ 4 minutes at ~400 ms/slot.
pub const CLOSE_UNSETTLED_EXPIRY_SLOTS: u64 = 600;
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

// ─── Phase 2: LP vault constants ────────────────────────────────────────────

/// Locked anti-inflation seed at v2 init (1 SOL). Carved from existing vault
/// balance — no extra SOL required from owner. Defends against the ERC-4626
/// first-depositor donation attack by ensuring `total_units` starts large.
pub const ANTI_INFLATION_SEED_LAMPORTS: u64 = 1_000_000_000;

/// Default cooldown between `request_withdraw` and `complete_withdraw`.
/// 3 days at ~400ms/slot ≈ 648,000 slots. Configurable via `update_v2_config`.
pub const DEFAULT_WITHDRAW_COOLDOWN_SLOTS: u64 = 648_000;

/// Floor for `update_v2_config(withdraw_cooldown_slots = ...)`. Prevents
/// a Squads vote (or future config-update path) from setting cooldown to
/// zero, which would re-enable atomic donate-and-withdraw NAV griefing
/// (threat-model.md §M3). 1 minute (~150 slots) is the minimum we'll
/// allow even for testing — long enough that a single block can't
/// sandwich a deposit + complete_withdraw.
pub const MIN_WITHDRAW_COOLDOWN_SLOTS: u64 = 150;

/// Floor for `update_v2_config(min_health_bps = ...)`. Zero would let a
/// single vote disable the health-floor enforcement; we require any
/// configuration to leave at least a 1% safety buffer.
pub const MIN_HEALTH_BPS_FLOOR: u16 = 100;

/// Default minimum house ownership floor (50%). Configurable both directions.
pub const DEFAULT_MIN_HOUSE_SHARE_BPS: u16 = 5_000;

/// Default per-user position cap (10% of vault, multiplied by health).
pub const DEFAULT_MAX_USER_POSITION_BPS: u16 = 1_000;

/// Default health buffer required before any new bet or LP deposit (10%).
pub const DEFAULT_MIN_HEALTH_BPS: u16 = 1_000;

/// Default minimum LP deposit (0.01 SOL — anti-dust).
pub const DEFAULT_MIN_LP_DEPOSIT_LAMPORTS: u64 = 10_000_000;

// ─── PDA seeds ───────────────────────────────────────────────────────────────

pub const VAULT_SEED: &[u8] = b"kaboom_vault";
pub const VAULT_V2_SEED: &[u8] = b"kaboom_v2_state";
pub const LP_SEED: &[u8] = b"kaboom_lp";
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
        vault.pending_owner = Pubkey::default();

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
        // FIX (2026-05-07): the referrer key MUST come from the AccountInfo's
        // pubkey, not from the freshly-init'd ReferralAccount.referrer field
        // (which is Pubkey::default() on first call). Previous implementation
        // read referral_account.referrer first → set everything to default →
        // every claim_referral failed `Unauthorized` because the field stayed
        // zero. Caught by scripts/test-referral-end-to-end.ts on devnet.
        let referrer_key = ctx.accounts.referrer.key();
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

        // Health-factor scales the static caps. Pre-fund-transfer health uses
        // the *current* vault assets and the proposed obligation includes this
        // bet's worst-case payout.
        let v2 = &ctx.accounts.v2_state;
        let pre_health = calc_health_bps(v2, available)?;
        let effective_max_bet_bps = (vault.max_bet_bps as u64)
            .checked_mul(pre_health as u64)
            .ok_or(KaboomError::MathOverflow)?
            / BPS;
        let effective_max_payout_bps = (vault.max_payout_bps as u64)
            .checked_mul(pre_health as u64)
            .ok_or(KaboomError::MathOverflow)?
            / BPS;
        let max_bet = mul_div_floor(available, effective_max_bet_bps, BPS)?;
        require!(bet <= max_bet, KaboomError::BetExceedsMax);

        let worst_payout_u64 = worst_case_payout(bet, mine_count, vault.house_edge_bps)?;
        let worst_payout = worst_payout_u64 as u128;
        let max_payout = mul_div_floor(available, effective_max_payout_bps, BPS)? as u128;
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
        game.max_payout = worst_payout_u64;

        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.total_games = vault_mut.total_games.saturating_add(1);
        vault_mut.total_wagered = vault_mut.total_wagered.saturating_add(bet);

        // Track new obligation; enforce health floor on post-bet vault state.
        let v2_mut = &mut ctx.accounts.v2_state;
        v2_mut.total_outstanding_max_payout = v2_mut
            .total_outstanding_max_payout
            .checked_add(worst_payout_u64)
            .ok_or(KaboomError::MathOverflow)?;
        // bet just transferred in → assets grew; health check on new state.
        let new_assets = available.saturating_add(bet);
        enforce_min_health(v2_mut, new_assets)?;

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

        // NOTE: do NOT release `total_outstanding_max_payout` here.
        // settle_game / close_unsettled_game / refund_expired are the
        // single owners of obligation release. Releasing here AND in
        // settle_game caused a double-decrement on every cashed-out
        // win (saturating_sub clamped to 0, so health was over-reported
        // afterwards). Fixed 2026-05-07: every game-end path now
        // decrements obligations exactly once.

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
        let max_payout_release = game.max_payout;

        // Release this game's obligation BEFORE referral payout / unit value
        // recompute, so health/unit_value reflect the post-resolution state.
        {
            let v2 = &mut ctx.accounts.v2_state;
            v2.total_outstanding_max_payout = v2
                .total_outstanding_max_payout
                .saturating_sub(max_payout_release);
        }

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
        // C1 fix (2026-05-07): explicitly assert the supplied account is the
        // canonical PDA for stats.referrer before any lamport movement. The
        // Account::try_from below already validates discriminator + program-
        // owner, and the ra.referrer field-equality check below also catches
        // most substitution attacks — but explicit PDA derivation is the
        // belt-and-suspenders we want here. See threat-model.md §C1.
        if let Some(referrer_key) = stats.referrer {
            if let Some(referral_info) = ctx.remaining_accounts.first() {
                let (expected_referral_pda, _) = Pubkey::find_program_address(
                    &[REFERRAL_SEED, referrer_key.as_ref()],
                    &crate::ID,
                );
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

        // Recompute unit_value snapshot for indexers / APY.
        {
            let vault_info = ctx.accounts.vault.to_account_info();
            let assets_now = vault_assets(&vault_info)?;
            let v2 = &ctx.accounts.v2_state;
            let h = calc_health_bps(v2, assets_now)?;
            emit!(VaultUnitValueUpdated {
                vault: ctx.accounts.vault.key(),
                vault_assets: assets_now,
                total_units: v2.total_units,
                health_bps: h,
                slot: Clock::get()?.slot,
            });
        }

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

    /// Owner-signed (Squads) one-shot migration for legacy `ReferralAccount`s.
    /// Pre-2026-05-07 (commit 658251e), `set_referrer` wrote the field BEFORE
    /// initialising it, so every account created before the fix has
    /// `referrer = Pubkey::default()`. That makes their `claim_referral` fail
    /// the `referral_account.referrer == referrer.key()` constraint forever.
    ///
    /// Idempotent: re-running on a correctly-set account is a no-op. Anchor's
    /// seed constraint on `referral_account` guarantees `referrer.key()` is the
    /// canonical PDA-derivation pubkey, so the value we write is safe.
    pub fn repair_referral(ctx: Context<RepairReferral>) -> Result<()> {
        let referral = &mut ctx.accounts.referral_account;
        let referrer_key = ctx.accounts.referrer.key();

        if referral.referrer == referrer_key {
            return Ok(());
        }

        require!(
            referral.referrer == Pubkey::default(),
            KaboomError::Unauthorized
        );

        referral.referrer = referrer_key;

        emit!(ReferralRepaired {
            referrer: referrer_key,
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
        let max_payout_release = game.max_payout;

        let v2 = &mut ctx.accounts.v2_state;
        v2.total_outstanding_max_payout = v2
            .total_outstanding_max_payout
            .saturating_sub(max_payout_release);

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

    /// Self-recovery: player can close their own Won/Lost game that the
    /// server failed to settle (e.g. they lost their gameToken). Available
    /// after CLOSE_UNSETTLED_EXPIRY_SLOTS so the server has ample time to
    /// settle in the happy path. Decrements the v2 obligation counter so
    /// total_outstanding_max_payout stays accurate.
    ///
    /// Trade-off: the player forfeits the on-chain settlement proof for
    /// this game (verifier won't be able to confirm the layout matched the
    /// commitment). Their cash_out (Won) or implicit forfeit (Lost) has
    /// already moved the SOL on-chain — this ix only reclaims rent + slot.
    pub fn close_unsettled_game(ctx: Context<CloseUnsettledGame>) -> Result<()> {
        let game = &ctx.accounts.game;
        require!(
            game.status == GameStatus::Won || game.status == GameStatus::Lost,
            KaboomError::GameNotFinished
        );
        require!(!game.settled, KaboomError::GameAlreadySettled);
        let clock = Clock::get()?;
        require!(
            clock.slot > game.start_slot.saturating_add(CLOSE_UNSETTLED_EXPIRY_SLOTS),
            KaboomError::GameNotExpired
        );
        let v2 = &mut ctx.accounts.v2_state;
        v2.total_outstanding_max_payout = v2
            .total_outstanding_max_payout
            .saturating_sub(game.max_payout);
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

        // C2 fix (2026-05-07): refuse executable destinations. The runtime
        // silently demotes write-perm on executables / sysvars / precompiles,
        // and a future feature-gate could brick a previously-fine address.
        // Defense-in-depth — see threat-model.md §C2.
        require!(
            !ctx.accounts.destination.executable,
            KaboomError::InvalidAmount
        );

        // M5 fix (2026-05-07): explicit aliasing guard so destination ≠ vault.
        // Belt-and-suspenders for pre-Anchor-1.0 (we're 0.31.1); prevents a
        // self-transfer that other paths might allow if seeds were ever
        // misconfigured.
        require!(
            dest_key != ctx.accounts.vault.key(),
            KaboomError::InvalidConfig
        );

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

    /// Step 1 of two-step ownership transfer: current owner proposes a new owner.
    /// Stored in `vault.pending_owner` until the new owner accepts (or current
    /// owner cancels). Setting `new_owner = current owner` or zero is rejected.
    pub fn propose_owner(ctx: Context<UpdateVault>, new_owner: Pubkey) -> Result<()> {
        require!(new_owner != Pubkey::default(), KaboomError::InvalidConfig);
        require!(
            new_owner != ctx.accounts.vault.owner,
            KaboomError::InvalidConfig
        );
        let vault = &mut ctx.accounts.vault;
        vault.pending_owner = new_owner;
        emit!(OwnerProposed {
            vault: vault.key(),
            current_owner: vault.owner,
            proposed_owner: new_owner,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Defensive: current owner cancels a pending transfer.
    pub fn cancel_proposed_owner(ctx: Context<UpdateVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.pending_owner != Pubkey::default(),
            KaboomError::NoPendingOwner
        );
        vault.pending_owner = Pubkey::default();
        emit!(OwnerProposalCancelled {
            vault: vault.key(),
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Step 2 of two-step ownership transfer: the proposed new owner signs to accept.
    /// After this lands, `vault.owner` is updated and `pending_owner` is cleared.
    /// All subsequent privileged ops require the new owner's signature.
    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.pending_owner != Pubkey::default(),
            KaboomError::NoPendingOwner
        );
        require!(
            vault.pending_owner == ctx.accounts.new_owner.key(),
            KaboomError::Unauthorized
        );
        let old_owner = vault.owner;
        vault.owner = vault.pending_owner;
        vault.pending_owner = Pubkey::default();
        emit!(OwnerAccepted {
            vault: vault.key(),
            old_owner,
            new_owner: vault.owner,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    // ═══ Phase 2: LP vault ════════════════════════════════════════════════════

    /// One-shot migration. Carves the existing vault balance into:
    ///   seed_units   = ANTI_INFLATION_SEED_LAMPORTS (locked forever)
    ///   house_units  = vault_assets - seed_units
    ///   total_units  = vault_assets
    ///
    /// All Phase 2 config takes default values. Owner can adjust later via
    /// `update_v2_config`. Owner-signed (Squads). Idempotent by virtue of `init`
    /// on `v2_state` — second call fails.
    pub fn initialize_v2(ctx: Context<InitializeV2>) -> Result<()> {
        let vault_info = ctx.accounts.vault.to_account_info();
        let assets = vault_assets(&vault_info)?;
        require!(
            assets >= ANTI_INFLATION_SEED_LAMPORTS,
            KaboomError::InsufficientLiquidity
        );

        let seed = ANTI_INFLATION_SEED_LAMPORTS as u128;
        let house = (assets - ANTI_INFLATION_SEED_LAMPORTS) as u128;
        let total = assets as u128;

        let v2 = &mut ctx.accounts.v2_state;
        v2.bump = ctx.bumps.v2_state;
        v2.total_outstanding_max_payout = 0;
        v2.total_units = total;
        v2.house_units = house;
        v2.house_pending_units = 0;
        v2.house_pending_unlock_slot = 0;
        v2.seed_units = seed;
        v2.total_pending_units = 0;
        v2.min_house_share_bps = DEFAULT_MIN_HOUSE_SHARE_BPS;
        v2.max_user_position_bps = DEFAULT_MAX_USER_POSITION_BPS;
        v2.min_health_bps = DEFAULT_MIN_HEALTH_BPS;
        v2.withdraw_cooldown_slots = DEFAULT_WITHDRAW_COOLDOWN_SLOTS;
        v2.min_lp_deposit = DEFAULT_MIN_LP_DEPOSIT_LAMPORTS;

        emit!(V2Initialized {
            vault: ctx.accounts.vault.key(),
            seed_units: seed,
            house_units: house,
            total_units: total,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// Owner-only Phase 2 config update.
    pub fn update_v2_config(
        ctx: Context<UpdateV2Config>,
        min_house_share_bps: Option<u16>,
        max_user_position_bps: Option<u16>,
        min_health_bps: Option<u16>,
        withdraw_cooldown_slots: Option<u64>,
        min_lp_deposit: Option<u64>,
    ) -> Result<()> {
        let v2 = &mut ctx.accounts.v2_state;
        if let Some(v) = min_house_share_bps {
            require!(v <= BPS as u16, KaboomError::InvalidConfig);
            v2.min_house_share_bps = v;
        }
        if let Some(v) = max_user_position_bps {
            require!(v <= BPS as u16, KaboomError::InvalidConfig);
            v2.max_user_position_bps = v;
        }
        if let Some(v) = min_health_bps {
            // M3 fix (2026-05-07): require a non-zero floor so a misconfig
            // can't turn off health enforcement entirely. See
            // threat-model.md §M3.
            require!(
                v >= MIN_HEALTH_BPS_FLOOR && v <= BPS as u16,
                KaboomError::InvalidConfig
            );
            v2.min_health_bps = v;
        }
        if let Some(v) = withdraw_cooldown_slots {
            // M3 fix (2026-05-07): require a non-zero floor so cooldown can
            // never be set to 0 (would re-enable atomic donate-and-withdraw
            // NAV griefing — see threat-model.md §H2 + §M3).
            require!(
                v >= MIN_WITHDRAW_COOLDOWN_SLOTS,
                KaboomError::InvalidConfig
            );
            v2.withdraw_cooldown_slots = v;
        }
        if let Some(v) = min_lp_deposit {
            v2.min_lp_deposit = v;
        }
        emit!(V2ConfigUpdated {
            vault: ctx.accounts.vault.key(),
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    /// User deposits SOL into the vault → mints `units` to their LpPosition.
    pub fn lp_deposit(ctx: Context<LpDeposit>, amount: u64) -> Result<()> {
        let v2_min = ctx.accounts.v2_state.min_lp_deposit;
        require!(!ctx.accounts.vault.paused, KaboomError::VaultPaused);
        require!(amount >= v2_min, KaboomError::DepositBelowMin);

        let vault_info = ctx.accounts.vault.to_account_info();
        let assets_pre = vault_assets(&vault_info)?;
        let total_units_pre = ctx.accounts.v2_state.total_units;

        let units_minted = deposit_to_units(amount, assets_pre, total_units_pre)?;
        require!(units_minted > 0, KaboomError::MathOverflow);

        // Transfer SOL into vault.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: vault_info.clone(),
                },
            ),
            amount,
        )?;

        let assets_after = assets_pre.saturating_add(amount);
        let v2 = &mut ctx.accounts.v2_state;
        let total_units_after = total_units_pre
            .checked_add(units_minted)
            .ok_or(KaboomError::MathOverflow)?;
        v2.total_units = total_units_after;

        // Initialise position if first deposit.
        let position = &mut ctx.accounts.position;
        if position.user == Pubkey::default() {
            position.user = ctx.accounts.user.key();
            position.bump = ctx.bumps.position;
            position.created_slot = Clock::get()?.slot;
        }
        position.units = position
            .units
            .checked_add(units_minted)
            .ok_or(KaboomError::MathOverflow)?;

        // Enforce house floor + user cap on the post-state.
        let user_units_after = user_units_total(v2)?;
        enforce_house_floor(v2.house_units, user_units_after, v2.min_house_share_bps)?;

        let position_units = position
            .units
            .checked_add(position.pending_units)
            .ok_or(KaboomError::MathOverflow)?;
        let position_value = units_to_assets(position_units, assets_after, v2.total_units)?;
        let h = calc_health_bps(v2, assets_after)?;
        enforce_user_position_cap(position_value, assets_after, h, v2.max_user_position_bps)?;
        enforce_min_health(v2, assets_after)?;

        emit!(LpDeposited {
            user: ctx.accounts.user.key(),
            amount_lamports: amount,
            units_minted,
            total_units_after,
            vault_assets_after: assets_after,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    pub fn request_withdraw(ctx: Context<UserLpAction>, units: u128) -> Result<()> {
        let position = &mut ctx.accounts.position;
        let v2 = &mut ctx.accounts.v2_state;

        require!(
            position.pending_units == 0,
            KaboomError::PendingWithdrawAlreadyExists
        );
        require!(units > 0, KaboomError::InvalidAmount);
        require!(units <= position.units, KaboomError::InsufficientUnits);

        position.units = position
            .units
            .checked_sub(units)
            .ok_or(KaboomError::MathOverflow)?;
        position.pending_units = units;
        let unlock = Clock::get()?
            .slot
            .saturating_add(v2.withdraw_cooldown_slots);
        position.pending_unlock_slot = unlock;

        v2.total_pending_units = v2
            .total_pending_units
            .checked_add(units)
            .ok_or(KaboomError::MathOverflow)?;

        emit!(LpWithdrawRequested {
            user: ctx.accounts.user.key(),
            units,
            unlock_slot: unlock,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    pub fn cancel_withdraw(ctx: Context<UserLpAction>) -> Result<()> {
        let position = &mut ctx.accounts.position;
        let v2 = &mut ctx.accounts.v2_state;
        require!(
            position.pending_units > 0,
            KaboomError::NoPendingWithdraw
        );
        let units = position.pending_units;
        position.units = position
            .units
            .checked_add(units)
            .ok_or(KaboomError::MathOverflow)?;
        position.pending_units = 0;
        position.pending_unlock_slot = 0;
        v2.total_pending_units = v2
            .total_pending_units
            .checked_sub(units)
            .ok_or(KaboomError::MathOverflow)?;

        emit!(LpWithdrawCancelled {
            user: ctx.accounts.user.key(),
            units_returned: units,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    pub fn complete_withdraw(ctx: Context<UserLpAction>) -> Result<()> {
        let position = &mut ctx.accounts.position;
        let v2 = &mut ctx.accounts.v2_state;
        require!(
            position.pending_units > 0,
            KaboomError::NoPendingWithdraw
        );
        let now = Clock::get()?.slot;
        require!(
            now >= position.pending_unlock_slot,
            KaboomError::CooldownNotElapsed
        );

        let units = position.pending_units;
        let vault_info = ctx.accounts.vault.to_account_info();
        let assets_pre = vault_assets(&vault_info)?;
        let assets_out = units_to_assets(units, assets_pre, v2.total_units)?;
        require!(
            assets_out <= assets_pre,
            KaboomError::InsufficientLiquidity
        );

        // Burn units, decrement counters, transfer SOL out.
        position.pending_units = 0;
        position.pending_unlock_slot = 0;
        v2.total_pending_units = v2
            .total_pending_units
            .checked_sub(units)
            .ok_or(KaboomError::MathOverflow)?;
        v2.total_units = v2
            .total_units
            .checked_sub(units)
            .ok_or(KaboomError::MathOverflow)?;

        if assets_out > 0 {
            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(assets_out)
                .ok_or(KaboomError::MathOverflow)?;
            let user_info = ctx.accounts.user.to_account_info();
            **user_info.try_borrow_mut_lamports()? = user_info
                .lamports()
                .checked_add(assets_out)
                .ok_or(KaboomError::MathOverflow)?;
        }

        let assets_after = assets_pre.saturating_sub(assets_out);
        emit!(LpWithdrawCompleted {
            user: ctx.accounts.user.key(),
            units_burned: units,
            amount_lamports: assets_out,
            total_units_after: v2.total_units,
            vault_assets_after: assets_after,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    pub fn close_lp_position(ctx: Context<CloseLpPosition>) -> Result<()> {
        let position = &ctx.accounts.position;
        require!(
            position.units == 0 && position.pending_units == 0,
            KaboomError::LpPositionNotEmpty
        );
        emit!(LpPositionClosed {
            user: ctx.accounts.user.key(),
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    // ─── House LP ─────────────────────────────────────────────────────────────

    pub fn house_deposit(ctx: Context<HouseDepositCtx>, amount: u64) -> Result<()> {
        require!(amount > 0, KaboomError::InvalidAmount);
        let vault_info = ctx.accounts.vault.to_account_info();
        let assets_pre = vault_assets(&vault_info)?;
        let total_units_pre = ctx.accounts.v2_state.total_units;
        let units_minted = deposit_to_units(amount, assets_pre, total_units_pre)?;
        require!(units_minted > 0, KaboomError::MathOverflow);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: vault_info.clone(),
                },
            ),
            amount,
        )?;

        let v2 = &mut ctx.accounts.v2_state;
        v2.total_units = total_units_pre
            .checked_add(units_minted)
            .ok_or(KaboomError::MathOverflow)?;
        v2.house_units = v2
            .house_units
            .checked_add(units_minted)
            .ok_or(KaboomError::MathOverflow)?;

        emit!(HouseDeposited {
            amount_lamports: amount,
            units_minted,
            total_units_after: v2.total_units,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    pub fn house_request_withdraw(ctx: Context<HouseLpAction>, units: u128) -> Result<()> {
        let v2 = &mut ctx.accounts.v2_state;
        require!(v2.house_pending_units == 0, KaboomError::PendingWithdrawAlreadyExists);
        require!(units > 0, KaboomError::InvalidAmount);
        require!(units <= v2.house_units, KaboomError::InsufficientUnits);

        // Floor check on the post-request state. house_pending_units is NOT
        // counted in the numerator (per design — pending units are exiting).
        let house_after = v2.house_units.checked_sub(units).ok_or(KaboomError::MathOverflow)?;
        let user_total = user_units_total(v2)?;
        enforce_house_floor(house_after, user_total, v2.min_house_share_bps)?;

        v2.house_units = house_after;
        v2.house_pending_units = units;
        let unlock = Clock::get()?.slot.saturating_add(v2.withdraw_cooldown_slots);
        v2.house_pending_unlock_slot = unlock;

        emit!(HouseWithdrawRequested {
            units,
            unlock_slot: unlock,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    pub fn house_cancel_withdraw(ctx: Context<HouseLpAction>) -> Result<()> {
        let v2 = &mut ctx.accounts.v2_state;
        require!(v2.house_pending_units > 0, KaboomError::NoPendingWithdraw);
        let units = v2.house_pending_units;
        v2.house_units = v2.house_units.checked_add(units).ok_or(KaboomError::MathOverflow)?;
        v2.house_pending_units = 0;
        v2.house_pending_unlock_slot = 0;

        emit!(HouseWithdrawCancelled {
            units_returned: units,
            slot: Clock::get()?.slot,
        });
        Ok(())
    }

    pub fn house_complete_withdraw(ctx: Context<HouseLpAction>) -> Result<()> {
        let v2 = &mut ctx.accounts.v2_state;
        require!(v2.house_pending_units > 0, KaboomError::NoPendingWithdraw);
        let now = Clock::get()?.slot;
        require!(now >= v2.house_pending_unlock_slot, KaboomError::CooldownNotElapsed);

        let units = v2.house_pending_units;
        let vault_info = ctx.accounts.vault.to_account_info();
        let assets_pre = vault_assets(&vault_info)?;
        let assets_out = units_to_assets(units, assets_pre, v2.total_units)?;
        require!(assets_out <= assets_pre, KaboomError::InsufficientLiquidity);

        v2.house_pending_units = 0;
        v2.house_pending_unlock_slot = 0;
        v2.total_units = v2.total_units.checked_sub(units).ok_or(KaboomError::MathOverflow)?;

        if assets_out > 0 {
            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(assets_out)
                .ok_or(KaboomError::MathOverflow)?;
            let owner_info = ctx.accounts.owner.to_account_info();
            **owner_info.try_borrow_mut_lamports()? = owner_info
                .lamports()
                .checked_add(assets_out)
                .ok_or(KaboomError::MathOverflow)?;
        }

        emit!(HouseWithdrawCompleted {
            units_burned: units,
            amount_lamports: assets_out,
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

/// Worst-case payout for a freshly-started game given (bet, mine_count, edge).
fn worst_case_payout(bet: u64, mine_count: u8, house_edge_bps: u16) -> Result<u64> {
    let worst_safe = GRID_SIZE.saturating_sub(mine_count);
    let worst_multiplier = calc_multiplier(worst_safe, mine_count, house_edge_bps)?;
    mul_div_floor(bet, worst_multiplier, BPS)
}

// ─── Phase 2: LP / health-factor helpers ─────────────────────────────────────

fn vault_assets(vault_info: &AccountInfo) -> Result<u64> {
    let rent = Rent::get()?.minimum_balance(Vault::SPACE);
    Ok(vault_info.lamports().saturating_sub(rent))
}

/// units = amount × total_units / vault_assets_pre  (floor div, vault-favorable)
/// First deposit (total_units == 0): units = amount (1 lamport = 1 unit).
fn deposit_to_units(amount: u64, vault_assets_pre: u64, total_units: u128) -> Result<u128> {
    if total_units == 0 {
        return Ok(amount as u128);
    }
    require!(vault_assets_pre > 0, KaboomError::MathOverflow);
    (amount as u128)
        .checked_mul(total_units)
        .ok_or(KaboomError::MathOverflow.into())
        .and_then(|v| v.checked_div(vault_assets_pre as u128).ok_or(KaboomError::MathOverflow.into()))
}

/// assets = units × vault_assets / total_units  (floor div)
fn units_to_assets(units: u128, vault_assets: u64, total_units: u128) -> Result<u64> {
    if total_units == 0 || units == 0 {
        return Ok(0);
    }
    let v = units
        .checked_mul(vault_assets as u128)
        .ok_or(KaboomError::MathOverflow)?
        .checked_div(total_units)
        .ok_or(KaboomError::MathOverflow)?;
    u64::try_from(v).map_err(|_| KaboomError::MathOverflow.into())
}

fn user_units_total(v2: &VaultV2State) -> Result<u128> {
    v2.total_units
        .checked_sub(v2.seed_units)
        .and_then(|v| v.checked_sub(v2.house_units))
        .and_then(|v| v.checked_sub(v2.house_pending_units))
        .ok_or(KaboomError::MathOverflow.into())
}

fn calc_health_bps(v2: &VaultV2State, vault_assets_now: u64) -> Result<u16> {
    if vault_assets_now == 0 {
        return Ok(0);
    }
    let pending_value = units_to_assets(v2.total_pending_units, vault_assets_now, v2.total_units)?;
    let obligations = v2
        .total_outstanding_max_payout
        .checked_add(pending_value)
        .ok_or(KaboomError::MathOverflow)?;
    let free = vault_assets_now.saturating_sub(obligations);
    let h = (free as u128)
        .checked_mul(BPS as u128)
        .ok_or(KaboomError::MathOverflow)?
        .checked_div(vault_assets_now as u128)
        .ok_or(KaboomError::MathOverflow)?;
    Ok(u16::try_from(h.min(BPS as u128)).unwrap())
}

fn enforce_min_health(v2: &VaultV2State, vault_assets_now: u64) -> Result<()> {
    if v2.min_health_bps == 0 {
        return Ok(());
    }
    let h = calc_health_bps(v2, vault_assets_now)?;
    require!(h >= v2.min_health_bps, KaboomError::HealthFloorBreached);
    Ok(())
}

fn enforce_house_floor(
    house_units_after: u128,
    user_units_total_after: u128,
    min_house_share_bps: u16,
) -> Result<()> {
    if min_house_share_bps == 0 {
        return Ok(());
    }
    let denom = house_units_after
        .checked_add(user_units_total_after)
        .ok_or(KaboomError::MathOverflow)?;
    if denom == 0 {
        return Ok(());
    }
    let lhs = house_units_after
        .checked_mul(BPS as u128)
        .ok_or(KaboomError::MathOverflow)?;
    let rhs = (min_house_share_bps as u128)
        .checked_mul(denom)
        .ok_or(KaboomError::MathOverflow)?;
    require!(lhs >= rhs, KaboomError::HouseShareFloorBreached);
    Ok(())
}

fn enforce_user_position_cap(
    user_position_value: u64,
    vault_assets_now: u64,
    health_bps_value: u16,
    max_user_position_bps: u16,
) -> Result<()> {
    if max_user_position_bps == 0 {
        return Ok(());
    }
    let cap = (vault_assets_now as u128)
        .checked_mul(max_user_position_bps as u128)
        .ok_or(KaboomError::MathOverflow)?
        .checked_div(BPS as u128)
        .ok_or(KaboomError::MathOverflow)?
        .checked_mul(health_bps_value as u128)
        .ok_or(KaboomError::MathOverflow)?
        .checked_div(BPS as u128)
        .ok_or(KaboomError::MathOverflow)?;
    require!(
        (user_position_value as u128) <= cap,
        KaboomError::UserPositionCapExceeded
    );
    Ok(())
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
    /// Pending new owner for the two-step ownership transfer flow. Cleared on
    /// `accept_ownership` or `cancel_proposed_owner`. `Pubkey::default()` (all
    /// zeros) means "no pending transfer." Backwards-compatible with v1 vaults
    /// — the byte slot was previously `_reserved: [u8; 32]`, also zero-init.
    pub pending_owner: Pubkey,
}

impl Vault {
    pub const SPACE: usize = 8   // discriminator
        + 32 + 32 + 32 // owner + house_authority + treasury
        + 1            // bump
        + 2 + 2 + 2 + 2 // 4 u16 bps fields
        + 8 + 8 + 8    // 3 u64 counters
        + 1 + 1 + 1    // paused + version + allowlist_count
        + 32 * MAX_ALLOWLIST
        + 32; // pending_owner
}

/// Phase 2 LP / health-factor state. Stored in a separate PDA so we can extend
/// without reallocating the existing `Vault` (which v1 deployed at a fixed
/// size). All Phase 2 ixs load both `Vault` and `VaultV2State`.
#[account]
pub struct VaultV2State {
    pub bump: u8,

    // Health / obligation tracking
    /// Sum across every active GameSession of `bet × (multiplier @ settled-on-mine_count = 0)`.
    /// Maintained O(1) by start_game (++) and settle_game/cash_out/refund_expired (--).
    pub total_outstanding_max_payout: u64,

    // LP unit accounting
    pub total_units: u128,           // seed + house + sum(user units + pending)
    pub house_units: u128,           // house's LP position; obeys cooldown
    pub house_pending_units: u128,
    pub house_pending_unlock_slot: u64,
    pub seed_units: u128,            // anti-inflation seed; never moves
    pub total_pending_units: u128,   // sum of USER pending_units (not house's)

    // Phase 2 config (all owner-settable via update_v2_config)
    pub min_house_share_bps: u16,
    pub max_user_position_bps: u16,
    pub min_health_bps: u16,
    pub withdraw_cooldown_slots: u64,
    pub min_lp_deposit: u64,

    pub _reserved: [u8; 64],
}

impl VaultV2State {
    pub const SPACE: usize = 8   // disc
        + 1                       // bump
        + 8                       // total_outstanding_max_payout
        + 16 + 16 + 16 + 8 + 16 + 16 // 5 u128 + 1 u64 in LP block
        + 2 + 2 + 2               // 3 u16 bps
        + 8 + 8                   // withdraw_cooldown_slots + min_lp_deposit
        + 64;                     // reserved
}

/// Per-user LP position. PDA seeds: [LP_SEED, user.key()].
#[account]
pub struct LpPosition {
    pub user: Pubkey,
    pub units: u128,
    pub pending_units: u128,
    pub pending_unlock_slot: u64,
    pub created_slot: u64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl LpPosition {
    pub const SPACE: usize = 8 + 32 + 16 + 16 + 8 + 8 + 1 + 32;
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
    /// Worst-case payout reserved at start_game; used to decrement
    /// `VaultV2State.total_outstanding_max_payout` on resolution. Old games
    /// (started pre-v2) have this as 0 — handled gracefully.
    pub max_payout: u64,
    pub _reserved: [u8; 24],
}

impl GameSession {
    pub const SPACE: usize = 8
        + 32 + 1 + 1
        + 8 + 1 + 32
        + 2 + 2 + 1
        + 8 + 8 + 8
        + 1 + 2 + 32
        + 1 + 8 + 24;
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

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

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

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

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

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

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
pub struct RepairReferral<'info> {
    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ KaboomError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: only used for seed derivation. The `seeds` constraint on
    /// `referral_account` validates that `referrer.key()` is the canonical
    /// PDA-derivation pubkey for that account.
    pub referrer: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [REFERRAL_SEED, referrer.key().as_ref()],
        bump = referral_account.bump,
    )]
    pub referral_account: Account<'info, ReferralAccount>,

    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

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
pub struct CloseUnsettledGame<'info> {
    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

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

/// Accounts for `accept_ownership` — signed by the proposed new owner, not the current owner.
#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
        constraint = vault.pending_owner == new_owner.key() @ KaboomError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    pub new_owner: Signer<'info>,
}

// ─── Phase 2 Accounts ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeV2<'info> {
    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ KaboomError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = owner,
        seeds = [VAULT_V2_SEED],
        bump,
        space = VaultV2State::SPACE,
    )]
    pub v2_state: Account<'info, VaultV2State>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateV2Config<'info> {
    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ KaboomError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct LpDeposit<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

    #[account(
        init_if_needed,
        payer = user,
        space = LpPosition::SPACE,
        seeds = [LP_SEED, user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, LpPosition>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UserLpAction<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

    #[account(
        mut,
        seeds = [LP_SEED, user.key().as_ref()],
        bump = position.bump,
        constraint = position.user == user.key() @ KaboomError::Unauthorized,
    )]
    pub position: Account<'info, LpPosition>,

    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseLpPosition<'info> {
    #[account(
        mut,
        seeds = [LP_SEED, user.key().as_ref()],
        bump = position.bump,
        constraint = position.user == user.key() @ KaboomError::Unauthorized,
        close = user,
    )]
    pub position: Account<'info, LpPosition>,

    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct HouseDepositCtx<'info> {
    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ KaboomError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct HouseLpAction<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
        constraint = vault.owner == owner.key() @ KaboomError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut, seeds = [VAULT_V2_SEED], bump = v2_state.bump)]
    pub v2_state: Account<'info, VaultV2State>,

    #[account(mut)]
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
    #[msg("No pending owner to accept or cancel.")]
    NoPendingOwner,
    // ─── Phase 2: LP vault ──────────────────────────────────────────────────
    #[msg("V2 already initialized.")]
    V2AlreadyInitialized,
    #[msg("V2 not yet initialized.")]
    V2NotInitialized,
    #[msg("Deposit below minimum.")]
    DepositBelowMin,
    #[msg("Deposit would exceed per-user position cap.")]
    UserPositionCapExceeded,
    #[msg("Deposit would push vault below minimum house share.")]
    HouseShareFloorBreached,
    #[msg("Deposit or new obligation would push health below minimum.")]
    HealthFloorBreached,
    #[msg("Pending withdrawal already exists; cancel it first.")]
    PendingWithdrawAlreadyExists,
    #[msg("No pending withdrawal to cancel or complete.")]
    NoPendingWithdraw,
    #[msg("Withdrawal cooldown not yet elapsed.")]
    CooldownNotElapsed,
    #[msg("Insufficient units in LP position.")]
    InsufficientUnits,
    #[msg("Vault has insufficient liquidity to honour this withdrawal.")]
    InsufficientLiquidity,
    #[msg("LP position still has units; cannot close.")]
    LpPositionNotEmpty,
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
pub struct OwnerProposed {
    pub vault: Pubkey,
    pub current_owner: Pubkey,
    pub proposed_owner: Pubkey,
    pub slot: u64,
}

#[event]
pub struct OwnerProposalCancelled {
    pub vault: Pubkey,
    pub slot: u64,
}

#[event]
pub struct OwnerAccepted {
    pub vault: Pubkey,
    pub old_owner: Pubkey,
    pub new_owner: Pubkey,
    pub slot: u64,
}

// ─── Phase 2 events ──────────────────────────────────────────────────────────

#[event]
pub struct V2Initialized {
    pub vault: Pubkey,
    pub seed_units: u128,
    pub house_units: u128,
    pub total_units: u128,
    pub slot: u64,
}

#[event]
pub struct V2ConfigUpdated {
    pub vault: Pubkey,
    pub slot: u64,
}

#[event]
pub struct LpDeposited {
    pub user: Pubkey,
    pub amount_lamports: u64,
    pub units_minted: u128,
    pub total_units_after: u128,
    pub vault_assets_after: u64,
    pub slot: u64,
}

#[event]
pub struct LpWithdrawRequested {
    pub user: Pubkey,
    pub units: u128,
    pub unlock_slot: u64,
    pub slot: u64,
}

#[event]
pub struct LpWithdrawCancelled {
    pub user: Pubkey,
    pub units_returned: u128,
    pub slot: u64,
}

#[event]
pub struct LpWithdrawCompleted {
    pub user: Pubkey,
    pub units_burned: u128,
    pub amount_lamports: u64,
    pub total_units_after: u128,
    pub vault_assets_after: u64,
    pub slot: u64,
}

#[event]
pub struct LpPositionClosed {
    pub user: Pubkey,
    pub slot: u64,
}

#[event]
pub struct HouseDeposited {
    pub amount_lamports: u64,
    pub units_minted: u128,
    pub total_units_after: u128,
    pub slot: u64,
}

#[event]
pub struct HouseWithdrawRequested {
    pub units: u128,
    pub unlock_slot: u64,
    pub slot: u64,
}

#[event]
pub struct HouseWithdrawCancelled {
    pub units_returned: u128,
    pub slot: u64,
}

#[event]
pub struct HouseWithdrawCompleted {
    pub units_burned: u128,
    pub amount_lamports: u64,
    pub slot: u64,
}

#[event]
pub struct VaultUnitValueUpdated {
    pub vault: Pubkey,
    pub vault_assets: u64,
    pub total_units: u128,
    pub health_bps: u16,
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

#[event]
pub struct ReferralRepaired {
    pub referrer: Pubkey,
    pub slot: u64,
}
