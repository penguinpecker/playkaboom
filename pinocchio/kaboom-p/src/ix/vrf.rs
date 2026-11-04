//! `vrf` group: 11 handlers + `force_undelegate_vrf` (F3). Spec: `pinocchio/spec/vrf.md` (source: `programs/kaboom/src/vrf_mode.rs`).
//! None of these emit events or logs beyond the dispatcher's `Instruction: <Name>` line.

use pinocchio::{
    cpi::{invoke, invoke_signed, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

use ephemeral_rollups_pinocchio::vrf::{instruction::RequestRandomnessCpi, types::RequestRandomness};

use crate::consts::*;
use crate::error::{AnchorError, KaboomError as K};
use crate::helpers::*;
use crate::ix::disc;
use crate::state::{
    game_session_v2 as gs2, player_stats as ps, rd_pk, rd_u128, rd_u16, rd_u32, rd_u64,
    referral_account as ra, vault as vt, vault_v2_state as v2, vrf_claim as vc, vrf_game as vg, wr_bytes,
    wr_i64, wr_u16, wr_u32, wr_u64, VRF_GAME_MIN_RAW_LEN,
};

const NOT_ENOUGH_KEYS: AnchorError = AnchorError::AccountNotEnoughKeys;

/// `seeds = [...], bump, seeds::program = <program>` (canonical, non-init) -> 2006.
#[inline(never)]
fn check_pda_under(acc: &AccountView, seeds: &[&[u8]], program: &Address) -> ProgramResult {
    let (pda, _) = find_pda_for(seeds, program)?;
    if acc.address() == &pda {
        Ok(())
    } else {
        Err(AnchorError::ConstraintSeeds.into())
    }
}

/// Pass C for a `Box<Account<VrfClaim>>` keyed by `player`: seeds (stored bump) -> mut ->
/// `claim.player == player @ Unauthorized` -> close self-target (2011).
#[inline(never)]
fn check_claim(claim: &AccountView, player: &AccountView) -> ProgramResult {
    let pk = player.address().as_array();
    {
        let d = claim.try_borrow()?;
        check_pda_bump(claim, &[VRF_CLAIM_SEED, pk], d[vc::BUMP])?;
        check_mut(claim)?;
        require(rd_pk(&d, vc::PLAYER) == pk, K::Unauthorized)?;
    }
    check_close_target(claim, player)
}

/// `seeds = [VRF_GAME_SEED, game.player], bump = game.bump` on a loaded VrfGame -> 2006.
#[inline(never)]
fn check_game_seeds(game: &AccountView) -> ProgramResult {
    let d = game.try_borrow()?;
    check_pda_bump(game, &[VRF_GAME_SEED, rd_pk(&d, vg::PLAYER)], d[vg::BUMP])
}

/// F6 (MB-6): a program-owned VrfGame at the player's PDA with no claim is an orphan left by
/// admin_release_vrf_claim (the only path that closes a claim without its game). The claim `init`
/// just before this proved no live claim exists, so wipe the dead game and start the new one in it; its
/// rent carries over. Anything else (DLP-owned, zero-closed, foreign) falls through to `init`, which
/// fails exactly like Anchor.
#[inline(never)]
fn reuse_orphan_game(game: &mut AccountView, pk: &[u8; 32]) -> Result<Option<u8>, ProgramError> {
    if !game.owned_by(&ID) || game.try_borrow()?.get(..8) != Some(&vg::DISC[..]) {
        return Ok(None);
    }
    let bump = check_pda_find(game, &[VRF_GAME_SEED, pk])?; // 2006, before any write
    check_mut(game)?; // 2000
    game.try_borrow_mut()?.fill(0);
    Ok(Some(bump))
}

// ─── 1. start_game_vrf ──────────────────────────────────────────────────────

/// `start_game_vrf` -- spec `vrf.md` section 1 (vrf_mode.rs:208-332).
///
/// Accounts (IDL order): player(WS), vault(W), v2_state(W), claim(W), game(W), player_stats(W), system_program
/// Args: mine_count: u8, bet: u64, session_key: pubkey
#[inline(never)]
pub fn start_game_vrf(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let mut a = Args::new(args);
    let mine_count = a.u8()?;
    let bet = a.u64()?;
    let session_key = *a.pk()?;
    let [player, vault, v2s, claim, game, stats, system_program, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(player)?;
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    check_system_program(system_program)?;
    // Pass B
    let rent = rent()?;
    let pk = *player.address().as_array();
    let claim_bump = init_pda(player, claim, &[VRF_CLAIM_SEED, &pk], vc::SPACE, &rent)?;
    let game_bump = match reuse_orphan_game(game, &pk)? {
        Some(b) => b,
        None => init_pda(player, game, &[VRF_GAME_SEED, &pk], vg::SPACE, &rent)?,
    };
    let (stats_bump, stats_created) =
        init_if_needed_pda(player, stats, &[STATS_SEED, &pk], &ps::TYPE, ps::SPACE, &rent)?;
    // Pass C
    check_mut(player)?;
    check_vault_v2_mut(vault, v2s)?;

    // Handler
    let (available, house_edge_bps, worst) = {
        let vd = vault.try_borrow()?;
        let v2d = v2s.try_borrow()?;
        require(v2d[v2::VRF_MODE_ENABLED] != 0, K::VrfModeDisabled)?;
        require(rd_pk(&v2d, v2::VRF_VALIDATOR) != &[0u8; 32], K::VrfValidatorNotSet)?;
        require(rd_u16(&v2d, v2::VRF_MAX_PAYOUT_BPS) > 0, K::VrfValidatorNotSet)?;
        require(vd[vt::PAUSED] == 0, K::VaultPaused)?;
        require((MIN_MINES..=MAX_MINES).contains(&mine_count), K::InvalidMineCount)?;
        require(bet >= MIN_BET_LAMPORTS, K::BetTooLow)?;
        let available = vault_assets(vault, &rent)?;
        let pre_health = calc_health_bps(&v2d, available)? as u64;
        let max_bet_bps = (rd_u16(&vd, vt::MAX_BET_BPS) as u64).checked_mul(pre_health).ok_or(K::MathOverflow)? / BPS;
        let vrf_payout_bps = rd_u16(&vd, vt::MAX_PAYOUT_BPS).min(rd_u16(&v2d, v2::VRF_MAX_PAYOUT_BPS));
        let max_payout_bps = (vrf_payout_bps as u64).checked_mul(pre_health).ok_or(K::MathOverflow)? / BPS;
        let max_bet = mul_div_floor(available, max_bet_bps, BPS)?;
        require(bet <= max_bet, K::BetExceedsMax)?;
        let edge = rd_u16(&vd, vt::HOUSE_EDGE_BPS);
        let worst = worst_case_payout(bet, mine_count, edge)?;
        let max_payout = mul_div_floor(available, max_payout_bps, BPS)?;
        require(worst <= max_payout, K::VaultInsufficientFunds)?;
        (available, edge, worst)
    };

    transfer(player, vault, bet)?;
    let clock = clock()?;

    {
        let mut d = claim.try_borrow_mut()?;
        wr_bytes(&mut d, 0, &vc::DISC);
        wr_bytes(&mut d, vc::PLAYER, &pk);
        wr_u64(&mut d, vc::BET, bet);
        wr_u64(&mut d, vc::RESERVED, worst);
        d[vc::MINE_COUNT] = mine_count;
        wr_u16(&mut d, vc::HOUSE_EDGE_BPS, house_edge_bps);
        wr_u64(&mut d, vc::START_SLOT, clock.slot);
        d[vc::SETTLED] = 0;
        d[vc::BUMP] = claim_bump;
    }
    {
        // Fresh zeroed data: only the non-zero fields need writing (status, masks, counts, reveals = 0).
        let mut d = game.try_borrow_mut()?;
        wr_bytes(&mut d, 0, &vg::DISC);
        d[vg::STATUS] = VRF_PLAYING;
        wr_bytes(&mut d, vg::PLAYER, &pk);
        wr_bytes(&mut d, vg::SESSION_KEY, &session_key);
        d[vg::BUMP] = game_bump;
        d[vg::MINE_COUNT] = mine_count;
        wr_u16(&mut d, vg::HOUSE_EDGE_BPS, house_edge_bps);
        d[vg::PENDING_TILE] = NO_TILE;
        wr_u64(&mut d, vg::MULTIPLIER_BPS, BPS);
    }
    {
        let mut d = stats.try_borrow_mut()?;
        if stats_created {
            wr_bytes(&mut d, 0, &ps::DISC);
        }
        if rd_pk(&d, ps::PLAYER) == &[0u8; 32] {
            wr_bytes(&mut d, ps::PLAYER, &pk);
            d[ps::BUMP] = stats_bump;
            d[ps::VERSION] = 1;
        }
    }
    {
        let mut d = vault.try_borrow_mut()?;
        let g = rd_u64(&d, vt::TOTAL_GAMES).saturating_add(1);
        wr_u64(&mut d, vt::TOTAL_GAMES, g);
        let w = rd_u64(&d, vt::TOTAL_WAGERED).saturating_add(bet);
        wr_u64(&mut d, vt::TOTAL_WAGERED, w);
    }
    let mut d = v2s.try_borrow_mut()?;
    let out = rd_u64(&d, v2::TOTAL_OUTSTANDING_MAX_PAYOUT).checked_add(worst).ok_or(K::MathOverflow)?;
    wr_u64(&mut d, v2::TOTAL_OUTSTANDING_MAX_PAYOUT, out);
    enforce_min_health(&d, available.saturating_add(bet))
}

// ─── 2. delegate_vrf ────────────────────────────────────────────────────────

/// `delegate_vrf` -- spec `vrf.md` section 2 (vrf_mode.rs:393-416 + sdk 0.15.5 `delegate_account_inner`).
///
/// Accounts (IDL order): player(WS), buffer_game(W), delegation_record_game(W), delegation_metadata_game(W), game(W), v2_state, owner_program, delegation_program, system_program
/// Args: none
#[inline(never)]
pub fn delegate_vrf(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [player, buffer, record, metadata, game, v2s, owner_program, dlp, system_program, rem @ ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(player)?;
    load(v2s, &v2::TYPE)?;
    check_system_program(system_program)?;
    // Pass C
    check_mut(player)?;
    let gk = *game.address().as_array();
    let buffer_bump = check_pda_find(buffer, &[DLP_BUFFER_SEED, &gk])?;
    check_mut(buffer)?;
    check_pda_under(record, &[DLP_DELEGATION_SEED, &gk], dlp.address())?;
    check_mut(record)?;
    check_pda_under(metadata, &[DLP_METADATA_SEED, &gk], dlp.address())?;
    check_mut(metadata)?;
    let pk = *player.address().as_array();
    let game_bump = check_pda_find(game, &[VRF_GAME_SEED, &pk])?;
    check_mut(game)?;
    check_v2_seeds(v2s)?;
    check_address(owner_program, &ID)?;
    check_address(dlp, &DELEGATION_PROGRAM_ID)?;

    // Handler
    let pinned = *rd_pk(&v2s.try_borrow()?, v2::VRF_VALIDATOR);
    require(pinned != [0u8; 32], K::VrfValidatorNotSet)?;
    if let Some(passed) = rem.first() {
        require(passed.address().as_array() == &pinned, K::WrongVrfValidator)?;
    }
    {
        let d = game.try_borrow()?;
        check_vrf_game_delegable(game.owner(), &d)?;
    }
    delegate_game(player, buffer, record, metadata, game, owner_program, system_program, &pk, game_bump, buffer_bump, &pinned)
}

/// DLP `Delegate` instruction data (disc u64 0 ++ borsh `DelegateAccountArgs`):
/// commit_frequency_ms 1000, seeds `[VRF_GAME_SEED, player]`, validator `Some(pinned)`.
fn delegate_ix_data(pk: &[u8; 32], pinned: &[u8; 32]) -> [u8; 104] {
    let mut d = [0u8; 104];
    wr_u32(&mut d, 8, COMMIT_FREQUENCY_MS);
    wr_u32(&mut d, 12, 2);
    wr_u32(&mut d, 16, VRF_GAME_SEED.len() as u32);
    wr_bytes(&mut d, 20, VRF_GAME_SEED);
    wr_u32(&mut d, 35, 32);
    wr_bytes(&mut d, 39, pk);
    d[71] = 1;
    wr_bytes(&mut d, 72, pinned);
    d
}

/// sdk 0.15.5 `delegate_account_inner` with the pre-funded buffer branch kept (D8).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn delegate_game(
    player: &mut AccountView,
    buffer: &mut AccountView,
    record: &AccountView,
    metadata: &AccountView,
    game: &mut AccountView,
    owner_program: &AccountView,
    system_program: &AccountView,
    pk: &[u8; 32],
    game_bump: u8,
    buffer_bump: u8,
    pinned: &[u8; 32],
) -> ProgramResult {
    let gk = *game.address().as_array();
    let data_len = game.data_len();
    let bb = [buffer_bump];
    let buf_seeds = [Seed::from(DLP_BUFFER_SEED), Seed::from(&gk), Seed::from(&bb)];
    let buf_signer = [Signer::from(&buf_seeds)];
    // create_pda(rent_exempt = false): CreateAccount with 0 lamports, or Allocate + Assign if pre-funded.
    if buffer.lamports() == 0 {
        CreateAccount { from: player, to: buffer, lamports: 0, space: data_len as u64, owner: &ID }
            .invoke_signed(&buf_signer)?;
    } else {
        Allocate { account: buffer, space: data_len as u64 }.invoke_signed(&buf_signer)?;
        Assign { account: buffer, owner: &ID }.invoke_signed(&buf_signer)?;
    }
    {
        let src = game.try_borrow()?;
        let mut dst = buffer.try_borrow_mut()?;
        dst.copy_from_slice(&src);
    }
    game.try_borrow_mut()?.fill(0);
    if !game.owned_by(&SYSTEM_PROGRAM_ID) {
        // SAFETY: no outstanding reference to the owner field.
        unsafe { game.assign(&SYSTEM_PROGRAM_ID) };
    }
    let gb = [game_bump];
    let game_seeds = [Seed::from(VRF_GAME_SEED), Seed::from(pk), Seed::from(&gb)];
    let game_signer = [Signer::from(&game_seeds)];
    if !game.owned_by(&DELEGATION_PROGRAM_ID) {
        Assign { account: game, owner: &DELEGATION_PROGRAM_ID }.invoke_signed(&game_signer)?;
    }
    let data = delegate_ix_data(pk, pinned);
    let metas = [
        InstructionAccount::writable_signer(player.address()),
        InstructionAccount::writable_signer(game.address()),
        InstructionAccount::readonly(owner_program.address()),
        InstructionAccount::writable(buffer.address()),
        InstructionAccount::writable(record.address()),
        InstructionAccount::writable(metadata.address()),
        InstructionAccount::readonly(system_program.address()),
    ];
    let ix = InstructionView { program_id: &DELEGATION_PROGRAM_ID, accounts: &metas, data: &data };
    invoke_signed(
        &ix,
        &[&*player, &*game, owner_program, &*buffer, record, metadata, system_program],
        &game_signer,
    )?;
    // close_pda_with_system_transfer: same end state as moving the lamports directly, then
    // owner = System, data_len = 0.
    let l = buffer.lamports();
    move_lamports(buffer, player, l)?;
    buffer.close()
}

// ─── 3. reveal_request_vrf ──────────────────────────────────────────────────

/// `reveal_request_vrf` -- spec `vrf.md` section 3 (vrf_mode.rs:420-451).
///
/// Accounts (IDL order): session(WS), game(W), oracle_queue(W), program_identity, vrf_program, slot_hashes, system_program
/// Args: tile_index: u8, client_seed: u8
#[inline(never)]
pub fn reveal_request_vrf(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let mut a = Args::new(args);
    let tile_index = a.u8()?;
    let client_seed = a.u8()?;
    let [session, game, oracle_queue, program_identity, vrf_program, slot_hashes, system_program, ..] = accounts
    else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(session)?;
    load(game, &vg::TYPE)?;
    check_program(vrf_program, &VRF_PROGRAM_ID)?;
    check_system_program(system_program)?;
    // Pass C
    check_mut(session)?;
    check_game_seeds(game)?;
    check_mut(game)?;
    check_mut(oracle_queue)?;
    require(oracle_queue.address() == &VRF_ORACLE_QUEUE, K::WrongVrfValidator)?;
    if program_identity.address() != &IDENTITY_PDA {
        return Err(AnchorError::ConstraintSeeds.into());
    }
    check_address(slot_hashes, &SLOT_HASHES_ID)?;

    // Handler
    {
        let mut d = game.try_borrow_mut()?;
        require(session.address().as_array() == rd_pk(&d, vg::SESSION_KEY), K::BadSessionKey)?;
        require(d[vg::STATUS] == VRF_PLAYING, K::GameNotPlaying)?;
        require(tile_index < GRID_SIZE, K::InvalidTileIndex)?;
        require(d[vg::PENDING] == 0, K::RevealPending)?;
        let bit = 1u16 << tile_index;
        require(rd_u16(&d, vg::REVEALED_MASK) & bit == 0, K::TileAlreadyRevealed)?;
        d[vg::PENDING] = 1;
        d[vg::PENDING_TILE] = tile_index;
    }
    request_vrf(session, program_identity, oracle_queue, system_program, slot_hashes, vrf_program, game.address(), client_seed)
}

/// Scoped VRF request (data byte 10), callback `reveal_callback_vrf` with one meta `game (w)`,
/// signed by `["identity", 253]`.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn request_vrf(
    payer: &AccountView,
    program_identity: &AccountView,
    oracle_queue: &AccountView,
    system_program: &AccountView,
    slot_hashes: &AccountView,
    vrf_program: &AccountView,
    game: &Address,
    client_seed: u8,
) -> ProgramResult {
    let metas = [InstructionAccount::writable(game)];
    let cpi = RequestRandomnessCpi {
        payer,
        program_identity,
        oracle_queue,
        system_program,
        slot_hashes,
        vrf_program,
        request: RequestRandomness {
            high_priority: false,
            caller_seed: [client_seed; 32],
            callback_program_id: &ID,
            callback_discriminator: &disc::REVEAL_CALLBACK_VRF,
            callback_accounts_metas: &metas,
            callback_args: &[],
        },
    };
    let mut buf = [0u8; 126];
    let bump = [IDENTITY_BUMP];
    let seeds = [Seed::from(IDENTITY_SEED), Seed::from(&bump)];
    cpi.invoke_signed(&mut buf, &[Signer::from(&seeds)])
}

// ─── 4. reveal_callback_vrf ─────────────────────────────────────────────────

/// `reveal_callback_vrf` -- spec `vrf.md` section 4 (vrf_mode.rs:455-481).
///
/// Accounts (IDL order): vrf_program_identity(S), game(W)
/// Args: randomness: [u8; 32]
#[inline(never)]
pub fn reveal_callback_vrf(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let randomness = *Args::new(args).take::<32>()?;
    let [identity, game, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(identity)?;
    load(game, &vg::TYPE)?;
    // Pass C
    check_address(identity, &SCOPED_VRF_IDENTITY)?;
    check_mut(game)?;

    // Handler
    let mut d = game.try_borrow_mut()?;
    require(d[vg::PENDING] != 0, K::NoRevealPending)?;
    let tile = d[vg::PENDING_TILE];
    // Anchor panics on `1u16 << tile` for tile >= 16 (overflow-checks); fail likewise.
    let bit = 1u16.checked_shl(tile as u32).ok_or(ProgramError::ArithmeticOverflow)?;
    let idx = d[vg::REVEAL_COUNT] as usize;
    require(idx < MAX_VRF_REVEALS, K::TooManyReveals)?;
    let o = vg::REVEALS + vg::REVEAL_SIZE * idx;
    d[o] = tile;
    wr_bytes(&mut d, o + 1, &randomness);
    d[vg::REVEAL_COUNT] = d[vg::REVEAL_COUNT].saturating_add(1);

    let mine_count = d[vg::MINE_COUNT];
    let is_mine = decide_mine(&randomness, d[vg::SAFE_REVEALS], mine_count);
    let mask = rd_u16(&d, vg::REVEALED_MASK) | bit;
    wr_u16(&mut d, vg::REVEALED_MASK, mask);
    d[vg::PENDING] = 0;
    d[vg::PENDING_TILE] = NO_TILE;
    if is_mine {
        let mm = rd_u16(&d, vg::MINE_MASK) | bit;
        wr_u16(&mut d, vg::MINE_MASK, mm);
        d[vg::STATUS] = VRF_LOST;
    } else {
        let safe = d[vg::SAFE_REVEALS].saturating_add(1);
        d[vg::SAFE_REVEALS] = safe;
        let m = calc_multiplier(safe, mine_count, rd_u16(&d, vg::HOUSE_EDGE_BPS))?;
        wr_u64(&mut d, vg::MULTIPLIER_BPS, m);
        // calc_multiplier already guarantees mine_count <= 15 here.
        if safe >= GRID_SIZE - mine_count {
            d[vg::STATUS] = VRF_WON;
        }
    }
    Ok(())
}

// ─── 5. cash_out_vrf ────────────────────────────────────────────────────────

/// `cash_out_vrf` -- spec `vrf.md` section 5 (vrf_mode.rs:484-496).
///
/// Accounts (IDL order): signer(WS), game(W)
/// Args: none
#[inline(never)]
pub fn cash_out_vrf(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [signer, game, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    check_signer(signer)?;
    load(game, &vg::TYPE)?;
    check_mut(signer)?;
    check_game_seeds(game)?;
    check_mut(game)?;

    let mut d = game.try_borrow_mut()?;
    let k = signer.address().as_array();
    require(k == rd_pk(&d, vg::SESSION_KEY) || k == rd_pk(&d, vg::PLAYER), K::BadSessionKey)?;
    require(d[vg::STATUS] == VRF_PLAYING, K::GameNotPlaying)?;
    require(d[vg::PENDING] == 0, K::RevealPending)?;
    require(d[vg::SAFE_REVEALS] > 0, K::NoTilesRevealed)?;
    d[vg::STATUS] = VRF_WON;
    Ok(())
}

// ─── 6. settle_and_undelegate_vrf ───────────────────────────────────────────

/// bincode-1 `MagicBlockInstruction::ScheduleIntentBundle(MagicIntentBundleArgs { commit: None,
/// commit_and_undelegate: Some(Standalone([2]), Standalone), commit_finalize: None,
/// commit_finalize_and_undelegate: None, standalone_actions: [] })` (sdk 0.15.5, D12).
pub(crate) const SCHEDULE_CAU_GAME: [u8; 33] = [
    0x0b, 0, 0, 0, // variant 11
    0, // commit: None
    1, // commit_and_undelegate: Some
    0, 0, 0, 0, // CommitTypeArgs::Standalone
    1, 0, 0, 0, 0, 0, 0, 0, // Vec<u8> len 1
    2, // account index of game in [payer, magic_context, game]
    0, 0, 0, 0, // UndelegateTypeArgs::Standalone
    0, // commit_finalize: None
    0, // commit_finalize_and_undelegate: None
    0, 0, 0, 0, 0, 0, 0, 0, // standalone_actions: len 0
];

/// `settle_and_undelegate_vrf` -- spec `vrf.md` section 6 (vrf_mode.rs:506-521).
/// F3 deviation: a PLAYING game is ended by `end_playing` first (Anchor commits it as-is).
///
/// Accounts (IDL order): payer(WS), game(W), magic_program, magic_context(W)
/// Args: none
#[inline(never)]
pub fn settle_and_undelegate_vrf(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [payer, game, magic_program, magic_context, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(payer)?;
    load(game, &vg::TYPE)?;
    check_program(magic_program, &MAGIC_PROGRAM_ID)?;
    // Pass C
    check_mut(payer)?;
    check_game_seeds(game)?;
    check_mut(game)?;
    check_mut(magic_context)?;
    check_address(magic_context, &MAGIC_CONTEXT_ID)?;

    // Handler
    {
        let d = game.try_borrow()?;
        let k = payer.address().as_array();
        require(k == rd_pk(&d, vg::PLAYER) || k == rd_pk(&d, vg::SESSION_KEY), K::BadSessionKey)?;
    }
    end_playing(game)?;
    schedule_undelegate(payer, magic_context, game, magic_program)
}

/// F3: a game leaves the ER only in a state a permissionless or house crank can finish on L1.
/// PLAYING with progress -> WON (= cash_out_vrf), with none -> VOID (refundable); a pending reveal
/// blocks (6044), so `pending = 1` never reaches L1. Terminal states unchanged.
#[inline(never)]
fn end_playing(game: &mut AccountView) -> ProgramResult {
    let mut d = game.try_borrow_mut()?;
    if d[vg::STATUS] == VRF_PLAYING {
        require(d[vg::PENDING] == 0, K::RevealPending)?;
        d[vg::STATUS] = if d[vg::SAFE_REVEALS] > 0 { VRF_WON } else { VRF_VOID };
    }
    Ok(())
}

/// Magic-program CPI: commit + undelegate `game`, metas `[payer WS, magic_context W, game W]`.
#[inline(never)]
fn schedule_undelegate(payer: &AccountView, magic_context: &AccountView, game: &AccountView, magic_program: &AccountView) -> ProgramResult {
    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable(magic_context.address()),
        InstructionAccount::writable(game.address()),
    ];
    let ix = InstructionView { program_id: magic_program.address(), accounts: &metas, data: &SCHEDULE_CAU_GAME };
    invoke(&ix, &[payer, magic_context, game])
}

/// `force_undelegate_vrf` (F3 fix, MB-1; not in Anchor). ER only (on L1 the game is DLP-owned: 3007).
/// House-signed, EV-neutral close of an idle delegated game, then commit + undelegate: PLAYING with
/// progress -> WON (= cash_out_vrf), PLAYING with none -> VOID (refundable); terminal states unchanged.
///
/// Accounts: house(WS), game(W), magic_program, magic_context(W), vault
/// Args: none
#[inline(never)]
pub fn force_undelegate_vrf(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [house, game, magic_program, magic_context, vault, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(house)?;
    load(game, &vg::TYPE)?;
    check_program(magic_program, &MAGIC_PROGRAM_ID)?;
    load(vault, &vt::TYPE)?;
    // Pass C
    check_mut(house)?;
    check_game_seeds(game)?;
    check_mut(game)?;
    check_mut(magic_context)?;
    check_address(magic_context, &MAGIC_CONTEXT_ID)?;
    check_vault_seeds(vault)?;
    require(house.address().as_array() == rd_pk(&vault.try_borrow()?, vt::HOUSE_AUTHORITY), K::Unauthorized)?;
    // Handler
    end_playing(game)?;
    schedule_undelegate(house, magic_context, game, magic_program)
}

// ─── 7. settle_vrf ──────────────────────────────────────────────────────────

/// Replay (vrf_mode.rs:531-589). `d` = VrfGame data. Returns `(lost, expected_mult)`.
#[inline(never)]
fn replay(d: &[u8], claim_mines: u8, claim_edge: u16) -> Result<(bool, u64), ProgramError> {
    let status = d[vg::STATUS];
    let reveal_count = d[vg::REVEAL_COUNT];
    let mine_count = d[vg::MINE_COUNT];
    let committed_safe = d[vg::SAFE_REVEALS];
    let committed_mult = rd_u64(d, vg::MULTIPLIER_BPS);
    let edge = rd_u16(d, vg::HOUSE_EDGE_BPS);
    require(status == VRF_WON || status == VRF_LOST, K::GameNotPlaying)?;
    require(mine_count == claim_mines, K::ReplayMismatch)?;
    require(edge == claim_edge, K::ReplayMismatch)?;
    require(reveal_count as usize <= MAX_VRF_REVEALS, K::TooManyReveals)?;
    let mut safe: u8 = 0;
    let mut lost = false;
    for i in 0..reveal_count as usize {
        let o = vg::REVEALS + vg::REVEAL_SIZE * i;
        require((d[o] as u16) < GRID_SIZE as u16, K::InvalidTileIndex)?;
        if decide_mine(rd_pk(d, o + 1), safe, mine_count) {
            lost = true;
            break;
        }
        safe = safe.saturating_add(1);
    }
    require(safe == committed_safe, K::ReplayMismatch)?;
    require(status == if lost { VRF_LOST } else { VRF_WON }, K::ReplayMismatch)?;
    require(lost || safe > 0, K::ReplayMismatch)?;
    let expected = calc_multiplier(safe, mine_count, edge)?;
    require(committed_mult == expected, K::ReplayMismatch)?;
    Ok((lost, expected))
}

/// Player stats update (vrf_mode.rs:638-658). Returns the referrer if set.
#[inline(never)]
fn update_stats(stats: &mut AccountView, bet: u64, payout: u64, lost: bool, mult: u64, now: i64) -> Result<Option<[u8; 32]>, ProgramError> {
    let mut d = stats.try_borrow_mut()?;
    let v = rd_u64(&d, ps::GAMES_PLAYED).saturating_add(1);
    wr_u64(&mut d, ps::GAMES_PLAYED, v);
    let v = rd_u64(&d, ps::TOTAL_WAGERED).saturating_add(bet);
    wr_u64(&mut d, ps::TOTAL_WAGERED, v);
    wr_i64(&mut d, ps::LAST_PLAYED, now);
    if !lost {
        let v = rd_u64(&d, ps::GAMES_WON).saturating_add(1);
        wr_u64(&mut d, ps::GAMES_WON, v);
        let v = rd_u64(&d, ps::TOTAL_PAYOUTS).saturating_add(payout);
        wr_u64(&mut d, ps::TOTAL_PAYOUTS, v);
        let net_win = payout.saturating_sub(bet);
        if net_win > rd_u64(&d, ps::BIGGEST_WIN) {
            wr_u64(&mut d, ps::BIGGEST_WIN, net_win);
        }
        if mult > rd_u64(&d, ps::BIGGEST_MULTIPLIER_BPS) {
            wr_u64(&mut d, ps::BIGGEST_MULTIPLIER_BPS, mult);
        }
        let cur = rd_u32(&d, ps::CURRENT_STREAK).saturating_add(1);
        wr_u32(&mut d, ps::CURRENT_STREAK, cur);
        if cur > rd_u32(&d, ps::BEST_STREAK) {
            wr_u32(&mut d, ps::BEST_STREAK, cur);
        }
    } else {
        wr_u32(&mut d, ps::CURRENT_STREAK, 0);
    }
    Ok(if d[ps::REFERRER_TAG] == 1 { Some(*rd_pk(&d, ps::REFERRER)) } else { None })
}

/// Referral rakeback (vrf_mode.rs:661-706).
#[inline(never)]
fn pay_referral(vault: &mut AccountView, referral: &mut AccountView, referrer: &[u8; 32], bet: u64, rent: &pinocchio::sysvars::rent::Rent) -> ProgramResult {
    let (expected, _) = find_pda(&[REFERRAL_SEED, referrer])?;
    require(referral.address() == &expected, K::ReferralMismatch)?;
    load(referral, &ra::TYPE)?;
    let tier = {
        let d = referral.try_borrow()?;
        require(rd_pk(&d, ra::REFERRER) == referrer, K::ReferralMismatch)?;
        d[ra::TIER]
    };
    let cut = mul_div_floor(bet, referral_cut_bps(tier) as u64, BPS)?;
    let actual = cut.min(vault_assets(vault, rent)?);
    if actual > 0 {
        move_lamports(vault, referral, actual)?;
    }
    let mut d = referral.try_borrow_mut()?;
    let v = rd_u64(&d, ra::ACCRUED_LAMPORTS).saturating_add(actual);
    wr_u64(&mut d, ra::ACCRUED_LAMPORTS, v);
    let v = rd_u64(&d, ra::TOTAL_EARNED).saturating_add(actual);
    wr_u64(&mut d, ra::TOTAL_EARNED, v);
    let vol = rd_u64(&d, ra::REFERRED_VOLUME).saturating_add(bet);
    wr_u64(&mut d, ra::REFERRED_VOLUME, vol);
    let new_tier = tier_for_volume(vol);
    if new_tier != d[ra::TIER] {
        d[ra::TIER] = new_tier;
    }
    Ok(())
}

/// `settle_vrf` -- spec `vrf.md` section 7 (vrf_mode.rs:526-738).
///
/// Accounts (IDL order): payer(WS), player(W), claim(W), game(W), vault(W), v2_state(W), treasury(W), player_stats(W), system_program
/// Args: none
#[inline(never)]
pub fn settle_vrf(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [payer, player, claim, game, vault, v2s, treasury, stats, system_program, rem @ ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(payer)?;
    load(claim, &vc::TYPE)?;
    load(game, &vg::TYPE)?;
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    load(stats, &ps::TYPE)?;
    check_system_program(system_program)?;
    // Pass C
    check_mut(payer)?;
    check_mut(player)?;
    let pk = *player.address().as_array();
    check_claim(claim, player)?;
    {
        let d = game.try_borrow()?;
        check_pda_bump(game, &[VRF_GAME_SEED, &pk], d[vg::BUMP])?;
        check_mut(game)?;
        require(rd_pk(&d, vg::PLAYER) == &pk, K::Unauthorized)?;
    }
    check_close_target(game, player)?;
    check_vault_v2_mut(vault, v2s)?;
    check_mut(treasury)?;
    require(treasury.address().as_array() == rd_pk(&vault.try_borrow()?, vt::TREASURY), K::Unauthorized)?;
    {
        let d = stats.try_borrow()?;
        check_pda_bump(stats, &[STATS_SEED, &pk], d[ps::BUMP])?;
        check_mut(stats)?;
        require(rd_pk(&d, ps::PLAYER) == &pk, K::Unauthorized)?;
    }

    // Handler
    let rent = rent()?;
    let (bet, reserved, claim_mines, claim_edge) = {
        let d = claim.try_borrow()?;
        require(d[vc::SETTLED] == 0, K::GameAlreadySettled)?;
        (rd_u64(&d, vc::BET), rd_u64(&d, vc::RESERVED), d[vc::MINE_COUNT], rd_u16(&d, vc::HOUSE_EDGE_BPS))
    };
    let (lost, mult) = replay(&game.try_borrow()?, claim_mines, claim_edge)?;
    release_outstanding(v2s, reserved)?;

    let payout = if !lost {
        let p = mul_div_floor(bet, mult, BPS)?;
        require(p <= reserved, K::PayoutExceedsReserved)?;
        require(p <= vault_assets(vault, &rent)?, K::VaultInsufficientFunds)?;
        move_lamports(vault, player, p)?;
        let mut d = vault.try_borrow_mut()?;
        let v = rd_u64(&d, vt::TOTAL_PAYOUTS).saturating_add(p);
        wr_u64(&mut d, vt::TOTAL_PAYOUTS, v);
        p
    } else {
        0
    };

    let now = clock()?.unix_timestamp;
    if let Some(referrer) = update_stats(stats, bet, payout, lost, mult, now)? {
        // F5 (AUTH-2): a referred game cannot be settled without the referrer's PDA.
        let referral = rem.first_mut().ok_or(ProgramError::from(K::ReferralMismatch))?;
        pay_referral(vault, referral, &referrer, bet, &rent)?;
    }

    let (split, edge_now) = {
        let d = vault.try_borrow()?;
        (rd_u16(&d, vt::TREASURY_SPLIT_BPS), rd_u16(&d, vt::HOUSE_EDGE_BPS))
    };
    if split > 0 {
        let edge_share = mul_div_floor(bet, edge_now as u64, BPS)?;
        let treasury_cut = mul_div_floor(edge_share, split as u64, BPS)?;
        let assets_now = vault_assets(vault, &rent)?;
        let liquidity = {
            let d = v2s.try_borrow()?;
            let pending = units_to_assets(rd_u128(&d, v2::TOTAL_PENDING_UNITS), assets_now, rd_u128(&d, v2::TOTAL_UNITS))?;
            assets_now.saturating_sub(rd_u64(&d, v2::TOTAL_OUTSTANDING_MAX_PAYOUT)).saturating_sub(pending)
        };
        let actual = treasury_cut.min(liquidity);
        if actual > 0 {
            move_lamports(vault, treasury, actual)?;
        }
    }
    // `claim.settled = true` is a dead write: the claim is closed without being serialized.

    // Exit: close claim -> player, then game -> player.
    close_to(claim, player)?;
    close_to(game, player)
}

// ─── 8. refund_stalled_vrf ──────────────────────────────────────────────────

/// `refund_stalled_vrf` -- spec `vrf.md` section 8 (vrf_mode.rs:767-844).
///
/// Accounts (IDL order): caller(S), player(W), claim(W), game(W), vault(W), v2_state(W)
/// Args: none
#[inline(never)]
pub fn refund_stalled_vrf(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [caller, player, claim, game, vault, v2s, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(caller)?;
    load(claim, &vc::TYPE)?;
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    // Pass C
    check_mut(player)?;
    check_claim(claim, player)?;
    let pk = *player.address().as_array();
    check_pda_find(game, &[VRF_GAME_SEED, &pk])?;
    check_mut(game)?;
    check_vault_v2_mut(vault, v2s)?;

    // Handler
    let (bet, reserved, start_slot, claim_player) = {
        let d = claim.try_borrow()?;
        require(d[vc::SETTLED] == 0, K::GameAlreadySettled)?;
        (rd_u64(&d, vc::BET), rd_u64(&d, vc::RESERVED), rd_u64(&d, vc::START_SLOT), *rd_pk(&d, vc::PLAYER))
    };
    let ck = caller.address().as_array();
    let is_player = ck == &claim_player;
    require(is_player || ck == rd_pk(&vault.try_borrow()?, vt::HOUSE_AUTHORITY), K::Unauthorized)?;
    let now = clock()?.slot;
    require(now > start_slot.saturating_add(STALL_SLOTS), K::NotStalledYet)?;
    require(game.owned_by(&ID), K::GameStillDelegated)?;
    {
        let d = game.try_borrow()?;
        require(d.len() >= VRF_GAME_MIN_RAW_LEN, K::BadGameAccount)?;
        // F3: a VOID game (forced, zero progress) is refunded like a stalled PLAYING one.
        require(d[vg::STATUS] == VRF_PLAYING || d[vg::STATUS] == VRF_VOID, K::GameAlreadyResolved)?;
        require(rd_pk(&d, vg::PLAYER) == &pk, K::BadGameAccount)?;
        if !is_player {
            require(d[vg::SAFE_REVEALS] == 0 && d[vg::PENDING] == 0, K::Unauthorized)?;
        }
    }
    release_outstanding(v2s, reserved)?;
    let rent = rent()?;
    require(bet <= vault_assets(vault, &rent)?, K::VaultInsufficientFunds)?;
    move_lamports(vault, player, bet)?;
    // Manual close (D11): lamports to player, data zeroed, owner and length kept.
    zero_close_to(game, player)?;
    // Exit: close claim -> player.
    close_to(claim, player)
}

// ─── 9. admin_release_vrf_claim ─────────────────────────────────────────────

/// `admin_release_vrf_claim` -- spec `vrf.md` section 9 (vrf_mode.rs:864-896).
///
/// Accounts (IDL order): owner(S), player(W), claim(W), vault(W), v2_state(W)
/// Args: none
#[inline(never)]
pub fn admin_release_vrf_claim(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [owner, player, claim, vault, v2s, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(owner)?;
    load(claim, &vc::TYPE)?;
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    // Pass C
    require(owner.address().as_array() == rd_pk(&vault.try_borrow()?, vt::OWNER), K::Unauthorized)?;
    check_mut(player)?;
    check_claim(claim, player)?;
    check_vault_v2_mut(vault, v2s)?;

    // Handler
    let (bet, reserved, start_slot) = {
        let d = claim.try_borrow()?;
        require(d[vc::SETTLED] == 0, K::GameAlreadySettled)?;
        (rd_u64(&d, vc::BET), rd_u64(&d, vc::RESERVED), rd_u64(&d, vc::START_SLOT))
    };
    let now = clock()?.slot;
    require(now > start_slot.saturating_add(ABANDON_SLOTS), K::NotStalledYet)?;
    release_outstanding(v2s, reserved)?;
    let rent = rent()?;
    let payable = bet.min(admin_spendable(vault, &v2s.try_borrow()?, &rent)?);
    if payable > 0 {
        move_lamports(vault, player, payable)?;
    }
    // Exit: close claim -> player.
    close_to(claim, player)
}

// ─── 10. admin_close_orphaned_game_v2 ───────────────────────────────────────

/// `admin_close_orphaned_game_v2` -- spec `vrf.md` section 10 (vrf_mode.rs:916-983).
///
/// Accounts (IDL order): owner(S), player(W), game(W), vault(W), v2_state(W)
/// Args: none
#[inline(never)]
pub fn admin_close_orphaned_game_v2(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [owner, player, game, vault, v2s, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(owner)?;
    load(vault, &vt::TYPE)?;
    load(v2s, &v2::TYPE)?;
    // Pass C
    require(owner.address().as_array() == rd_pk(&vault.try_borrow()?, vt::OWNER), K::Unauthorized)?;
    check_mut(player)?;
    let pk = *player.address().as_array();
    check_pda_find(game, &[GAME_V2_SEED, &pk])?;
    check_mut(game)?;
    check_vault_v2_mut(vault, v2s)?;

    // Handler: game read raw (may be DLP-owned).
    let (bet, max_payout, settled) = {
        let d = game.try_borrow()?;
        require(d.len() >= gs2::MIN_RAW_LEN, K::BadGameAccount)?;
        require(d[..8] == gs2::DISC, K::BadGameAccount)?;
        require(rd_pk(&d, 8) == &pk, K::Unauthorized)?;
        (rd_u64(&d, gs2::BET), rd_u64(&d, gs2::MAX_PAYOUT), d[gs2::SETTLED] != 0)
    };
    require(!settled, K::GameAlreadySettled)?;
    release_outstanding(v2s, max_payout)?;
    let rent = rent()?;
    let payable = bet.min(admin_spendable(vault, &v2s.try_borrow()?, &rent)?);
    if payable > 0 {
        move_lamports(vault, player, payable)?;
    }
    if game.owned_by(&ID) {
        zero_close_to(game, player)?;
    }
    Ok(())
}

// ─── 11. process_undelegation ───────────────────────────────────────────────

/// Anchor-tolerant borsh `Vec<Vec<u8>>` (D9): short data -> 102, trailing bytes ignored, n = 0 allowed.
/// Returns `(n, first 16 seeds)`; seeds beyond 16 are validated but not kept (n > 15 fails later).
fn parse_seeds(args: &[u8]) -> Result<(usize, [&[u8]; 16]), ProgramError> {
    let mut a = Args::new(args);
    let n = a.u32()? as usize;
    let mut rest = a.rest();
    let mut seeds: [&[u8]; 16] = [&[]; 16];
    for i in 0..n {
        let mut r = Args::new(rest);
        let len = r.u32()? as usize;
        let body = r.rest();
        if body.len() < len {
            return Err(AnchorError::InstructionDidNotDeserialize.into());
        }
        if i < 16 {
            seeds[i] = &body[..len];
        }
        rest = &body[len..];
    }
    Ok((n, seeds))
}

/// `process_undelegation` -- spec `vrf.md` section 11 (`#[ephemeral]` 0.15.5 + the 0.16.2 buffer fix).
///
/// Accounts (IDL order): base_account(W), buffer, payer(W), system_program
/// Args: account_seeds: Vec<bytes>
#[inline(never)]
pub fn process_undelegation(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult {
    let (n, seeds) = parse_seeds(args)?;
    let [base, buffer, payer, system_program, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // sdk 0.16.2 `InitializeAfterUndelegation`, field order: base mut; buffer
    // `seeds = ["undelegate-buffer", base], bump, seeds::program = DLP` (2006); payer mut;
    // system_program `address = system_program::ID` (2012).
    check_mut(base)?;
    let canonical = Address::try_find_program_address(
        &[DLP_UNDELEGATE_BUFFER_SEED, base.address().as_array()],
        &DELEGATION_PROGRAM_ID,
    );
    if !matches!(canonical, Some((k, _)) if buffer.address() == &k) {
        return Err(AnchorError::ConstraintSeeds.into());
    }
    check_mut(payer)?;
    check_address(system_program, &SYSTEM_PROGRAM_ID)?;

    // Handler (sdk 0.16.2 `undelegate_account`; the canonical check there is already satisfied)
    if !buffer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !buffer.owned_by(&DELEGATION_PROGRAM_ID) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    if n > 15 {
        return Err(ProgramError::InvalidSeeds);
    }
    let (_, bump) = Address::try_find_program_address(&seeds[..n], &ID).ok_or(ProgramError::InvalidSeeds)?;
    let space = buffer.data_len();
    let min = rent_min(&rent()?, space)?;
    let bb = [bump];
    let signer_seeds: [Seed; 16] =
        core::array::from_fn(|i| if i < n { Seed::from(seeds[i]) } else { Seed::from(&bb[..]) });
    let signer = [Signer::from(&signer_seeds[..=n])];
    // create_pda(rent_exempt = true), incl. the pre-funded branch (rent - lamports, no max(1)).
    if base.lamports() == 0 {
        CreateAccount { from: payer, to: base, lamports: min, space: space as u64, owner: &ID }.invoke_signed(&signer)?;
    } else {
        let need = min.saturating_sub(base.lamports());
        if need > 0 {
            Transfer { from: payer, to: base, lamports: need }.invoke()?;
        }
        Allocate { account: base, space: space as u64 }.invoke_signed(&signer)?;
        Assign { account: base, owner: &ID }.invoke_signed(&signer)?;
    }
    let src = buffer.try_borrow()?;
    let mut dst = base.try_borrow_mut()?;
    dst.copy_from_slice(&src);
    Ok(())
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use ephemeral_rollups_pinocchio::intent_bundle::MagicIntentBundleBuilder;
    use ephemeral_rollups_pinocchio::types::{DelegateAccountArgs, MAX_DELEGATE_ACCOUNT_ARGS_SIZE};
    use pinocchio::account::{RuntimeAccount, NOT_BORROWED};

    fn acct(key: [u8; 32], signer: bool, writable: bool) -> RuntimeAccount {
        RuntimeAccount {
            borrow_state: NOT_BORROWED,
            is_signer: signer as u8,
            is_writable: writable as u8,
            address: Address::new_from_array(key),
            ..Default::default()
        }
    }

    /// D12: our hard-coded ScheduleIntentBundle payload == the MagicBlock builder's bytes.
    #[test]
    fn schedule_cau_bytes_match_builder() {
        let mut payer = acct([1; 32], true, true);
        let mut ctx = acct(*MAGIC_CONTEXT_ID.as_array(), false, true);
        let mut prog = acct(*MAGIC_PROGRAM_ID.as_array(), false, false);
        let mut game = acct([7; 32], false, true);
        let (p, c, m, g) = unsafe {
            (
                AccountView::new_unchecked(&mut payer),
                AccountView::new_unchecked(&mut ctx),
                AccountView::new_unchecked(&mut prog),
                AccountView::new_unchecked(&mut game),
            )
        };
        let games = [g];
        let mut buf = [0xAAu8; 256];
        MagicIntentBundleBuilder::new(p, c, m).commit_and_undelegate(&games).build_and_invoke(&mut buf).unwrap();
        assert_eq!(&buf[..33], &SCHEDULE_CAU_GAME[..]);
        assert_eq!(buf[33], 0xAA, "builder wrote more than 33 bytes");
    }

    /// Delegate CPI data == vendored borsh `DelegateAccountArgs` (same layout as sdk 0.15.5).
    #[test]
    fn delegate_data_matches_vendored() {
        let pk = [3u8; 32];
        let pinned = [9u8; 32];
        let mut args = [0u8; MAX_DELEGATE_ACCOUNT_ARGS_SIZE];
        let seeds: [&[u8]; 2] = [VRF_GAME_SEED, &pk];
        let s = DelegateAccountArgs {
            commit_frequency_ms: COMMIT_FREQUENCY_MS,
            seeds: &seeds,
            validator: Some(Address::new_from_array(pinned)),
        }
        .try_to_slice(&mut args)
        .unwrap();
        let ours = delegate_ix_data(&pk, &pinned);
        assert_eq!(&ours[..8], &[0u8; 8]);
        assert_eq!(&ours[8..], s);
    }

    #[test]
    fn undelegation_seed_parsing() {
        // [b"kaboom_vrf_game", player] + trailing byte
        let mut v = std::vec::Vec::new();
        v.extend_from_slice(&2u32.to_le_bytes());
        v.extend_from_slice(&15u32.to_le_bytes());
        v.extend_from_slice(VRF_GAME_SEED);
        v.extend_from_slice(&32u32.to_le_bytes());
        v.extend_from_slice(&[5u8; 32]);
        v.push(0xFF);
        let (n, s) = parse_seeds(&v).unwrap();
        assert_eq!(n, 2);
        assert_eq!(s[0], VRF_GAME_SEED);
        assert_eq!(s[1], &[5u8; 32][..]);
        assert_eq!(parse_seeds(&0u32.to_le_bytes()).unwrap().0, 0);
        let e102 = ProgramError::Custom(102);
        assert_eq!(parse_seeds(&[0, 0]).unwrap_err(), e102);
        assert_eq!(parse_seeds(&v[..40]).unwrap_err(), e102);
        assert_eq!(parse_seeds(&1u32.to_le_bytes()).unwrap_err(), e102);
    }
}
