//! VRF group differential tests (spec/vrf.md): start_game_vrf, delegate_vrf, reveal_request_vrf,
//! reveal_callback_vrf, cash_out_vrf, settle_and_undelegate_vrf, settle_vrf, refund_stalled_vrf,
//! admin_release_vrf_claim, admin_close_orphaned_game_v2, process_undelegation.
//!
//! Every test runs the same tx on the Anchor reference and on kaboom-p and asserts DIFF-POLICY parity
//! (`assert_same` / `assert_ok` / `assert_err` / `assert_failed`). A test whose name starts with
//! `diff_` reproduces a real disagreement and is expected to FAIL until the port is fixed.
//! CU lines: run with `--nocapture` and grep `^CU `.
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const BET: u64 = 10_000_000;

// ───────────────────────────── helpers ─────────────────────────────

fn cu(tag: &str, d: &Diff) {
    let (a, p) = d.cu();
    println!("CU {tag}: anchor {a} port {p}");
}

/// Both sides failed with exactly this (non-custom) instruction error.
fn assert_ierr(d: &Diff, e: InstructionError) {
    d.assert_failed();
    assert_eq!(d.anchor.err, Some(TransactionError::InstructionError(0, e)), "{}", d.report());
}

fn unsign(mut i: Instruction, idx: usize) -> Instruction { i.accounts[idx].is_signer = false; i }
fn ro(mut i: Instruction, idx: usize) -> Instruction { i.accounts[idx].is_writable = false; i }
fn sub(mut i: Instruction, idx: usize, k: Address) -> Instruction { i.accounts[idx].pubkey = k; i }
fn short(mut i: Instruction, n: usize) -> Instruction { i.accounts.truncate(n); i }
fn with_data(mut i: Instruction, n: usize) -> Instruction { i.data.resize(n, 0); i }

fn le16(d: &mut [u8], o: usize, v: u16) { d[o..o + 2].copy_from_slice(&v.to_le_bytes()) }
fn le64(d: &mut [u8], o: usize, v: u64) { d[o..o + 8].copy_from_slice(&v.to_le_bytes()) }
fn le128(d: &mut [u8], o: usize, v: u128) { d[o..o + 16].copy_from_slice(&v.to_le_bytes()) }

fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    if rem == 0 { return false; }
    u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
/// Randomness that makes the next reveal a mine (or not) for this game state.
fn rand_for(safe: u8, mines: u8, mine: bool) -> [u8; 32] {
    (0..=255u8).map(|b| [b; 32]).find(|r| is_mine(r, safe, mines) == mine).expect("no randomness")
}

fn start_ix(player: Address, mines: u8, bet: u64, session: Address) -> Instruction {
    ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), player_stats: pda::stats(&player), ..Default::default() }
        .ix(mines, bet, session)
}
fn deleg_ix(player: Address, validator: Option<Address>) -> Instruction {
    let mut i = delegate_vrf_ix(player);
    if let Some(v) = validator { i.accounts.push(AccountMeta::new_readonly(v, false)); }
    i
}
fn req_ix(session: Address, game: Address, tile: u8) -> Instruction {
    ix::RevealRequestVrf { session, game, ..Default::default() }.ix(tile, 9)
}
fn cb_ix(game: Address, r: [u8; 32]) -> Instruction {
    ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(r)
}
fn cash_ix(signer: Address, game: Address) -> Instruction { ix::CashOutVrf { signer, game }.ix() }
fn sau_ix(payer: Address, game: Address) -> Instruction { ix::SettleAndUndelegateVrf { payer, game, ..Default::default() }.ix() }
fn settle_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury, player_stats: pda::stats(&player), ..Default::default() }.ix()
}
fn refund_ix(caller: Address, player: Address) -> Instruction {
    ix::RefundStalledVrf { caller, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), ..Default::default() }.ix()
}
fn release_ix(owner: Address, player: Address) -> Instruction {
    ix::AdminReleaseVrfClaim { owner, player, claim: pda::vrf_claim(&player), ..Default::default() }.ix()
}
fn orphan_ix(owner: Address, player: Address) -> Instruction {
    ix::AdminCloseOrphanedGameV2 { owner, player, game: pda::game_v2(&player), ..Default::default() }.ix()
}
fn game_seeds(player: &Address) -> Vec<Vec<u8>> { vec![b"kaboom_vrf_game".to_vec(), player.as_ref().to_vec()] }
fn undeleg_ix(base: Address, buffer: Address, payer: Address, seeds: Vec<Vec<u8>>) -> Instruction {
    let mut u = ix::ProcessUndelegation { base_account: base, buffer, payer, ..Default::default() }.ix(seeds);
    u.accounts[1].is_signer = true;
    u.accounts[2].is_signer = true;
    u
}

struct V {
    p: Pair,
    w: World,
    validator: Address,
    player: Address,
    session: Address,
    game: Address,
    claim: Address,
    stats: Address,
}

/// house_world + enable_vrf (validator pinned).
fn world() -> (Pair, World, Address) {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    (p, w, validator)
}

fn v_from(p: Pair, w: World, validator: Address, player: Address, session: Address) -> V {
    V { p, w, validator, player, session, game: pda::vrf_game(&player), claim: pda::vrf_claim(&player), stats: pda::stats(&player) }
}

/// A VRF game in progress (program-owned; L1 undelegated == ER view for the handlers).
fn started(mines: u8) -> V {
    let (mut p, w, validator) = world();
    let player = p.user("player");
    let session = p.user("session");
    p.start_game_vrf(player, mines, BET, session);
    v_from(p, w, validator, player, session)
}

/// Same, with a referrer set on the player's stats before the game.
fn started_ref(mines: u8) -> (V, Address) {
    let (mut p, w, validator) = world();
    let player = p.user("player");
    let session = p.user("session");
    let referrer = p.user("referrer");
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
    p.start_game_vrf(player, mines, BET, session);
    (v_from(p, w, validator, player, session), referrer)
}

/// Callback on `game` with randomness chosen so the reveal of `tile` is (not) a mine.
fn reveal(p: &mut Pair, game: Address, tile: u8, mine: bool) -> Diff {
    let g = p.get(&game).unwrap().data;
    let r = rand_for(g[77], g[74], mine);
    p.patch(game, |d| { d[79] = 1; d[80] = tile; });
    p.run(&[cb_ix(game, r)])
}

fn status(p: &Pair, game: &Address) -> u8 { p.get(game).unwrap().data[8] }

/// One safe reveal, then cash out if still playing: a Won game ready for settle_vrf.
fn won(mines: u8) -> V {
    let mut v = started(mines);
    reveal(&mut v.p, v.game, 3, false).assert_ok();
    if status(&v.p, &v.game) == 0 { v.p.ok(&[cash_ix(v.session, v.game)]); }
    v
}
fn lost() -> V {
    let mut v = started(1);
    reveal(&mut v.p, v.game, 3, true).assert_ok();
    assert_eq!(status(&v.p, &v.game), 2);
    v
}

fn set_lamports(p: &mut Pair, k: Address, lamports: u64) {
    let mut a = p.get(&k).unwrap();
    a.lamports = lamports;
    p.set_account(k, a);
}
fn copy_to(p: &mut Pair, from: Address, label: &str) -> Address {
    let a = p.get(&from).unwrap();
    let k = key(label);
    p.set_account(k, a);
    k
}
fn sys_empty(p: &mut Pair, k: Address) {
    p.set_account(k, Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
}

/// Fake the DLP's undelegation output for `player`'s game (ER bytes in the canonical buffer) and
/// return the process_undelegation ix.
fn undeleg_setup(p: &mut Pair, player: Address) -> (Instruction, Vec<u8>) {
    let game = pda::vrf_game(&player);
    let er = p.get(&game).unwrap().data;
    let buffer = pda::undelegate_buffer(&game);
    sys_empty(p, game);
    p.set_data(buffer, ids::DLP, er.clone());
    let payer = p.user("dlp-payer");
    (undeleg_ix(game, buffer, payer, game_seeds(&player)), er)
}

// ───────────────────────────── 1. start_game_vrf ─────────────────────────────

#[test]
fn sgv_happy_fresh_stats() {
    let (mut p, _w, _) = world();
    let (player, session) = (p.user("player"), key("session"));
    let d = p.run(&[start_ix(player, 1, BET, session)]);
    d.assert_ok();
    cu("start_game_vrf (fresh stats)", &d);
    let c = p.read(&pda::vrf_claim(&player), accounts::VrfClaim::decode);
    assert_eq!((c.player, c.bet, c.mine_count, c.start_slot, c.settled), (player, BET, 1, START_SLOT, false));
    let g = p.read(&pda::vrf_game(&player), accounts::VrfGame::decode);
    assert_eq!((g.status, g.session_key, g.pending_tile, g.multiplier_bps), (0, session, 255, 10_000));
    let s = p.read(&pda::stats(&player), accounts::PlayerStats::decode);
    assert_eq!((s.player, s.version), (player, 1));
    assert_eq!(p.read(&ids::V2_STATE, accounts::VaultV2State::decode).total_outstanding_max_payout, c.reserved);
}

#[test]
fn sgv_happy_existing_stats() {
    let (v, _r) = started_ref(1);
    let s = v.p.read(&v.stats, accounts::PlayerStats::decode);
    assert_eq!(s.player, v.player);
    // a second player, stats pre-existing via set_referrer: measure CU of that path
    let (mut p, _w, _) = world();
    let player = p.user("player");
    let referrer = key("referrer");
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
    let d = p.run(&[start_ix(player, 1, BET, key("s"))]);
    d.assert_ok();
    cu("start_game_vrf (existing stats)", &d);
}

#[test]
fn sgv_existing_stats_player_default_gets_filled() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    let st = accounts::PlayerStats { player: Address::default(), bump: 0, version: 0, games_played: 7, games_won: 0, total_wagered: 0, total_payouts: 0,
        biggest_win: 0, biggest_multiplier_bps: 0, current_streak: 0, best_streak: 0, last_played: 0, referrer: None, _reserved: [0; 64] };
    p.set_program_account(pda::stats(&player), st.encode());
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_ok();
    let s = p.read(&pda::stats(&player), accounts::PlayerStats::decode);
    assert_eq!((s.player, s.version, s.games_played), (player, 1, 7));
}

#[test]
fn sgv_existing_stats_other_player_untouched() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    let other = key("other");
    let st = accounts::PlayerStats { player: other, bump: 9, version: 3, games_played: 0, games_won: 0, total_wagered: 0, total_payouts: 0,
        biggest_win: 0, biggest_multiplier_bps: 0, current_streak: 0, best_streak: 0, last_played: 0, referrer: Some(key("r")), _reserved: [5; 64] };
    p.set_program_account(pda::stats(&player), st.encode());
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_ok();
}

#[test]
fn sgv_mines_15_and_min_bet_boundary() {
    let (mut p, _w, _) = world();
    let a = p.user("a");
    p.run(&[start_ix(a, 15, 1_000_000, key("s"))]).assert_ok();
    let b = p.user("b");
    p.run(&[start_ix(b, 1, 999_999, key("s"))]).assert_err(6004);
}

#[test]
fn sgv_prefunded_claim_game_stats() {
    for (label, f) in [("claim", 0usize), ("game", 1), ("stats", 2), ("all-over-rent", 3)] {
        let (mut p, _w, _) = world();
        let player = p.user("player");
        let ks = [pda::vrf_claim(&player), pda::vrf_game(&player), pda::stats(&player)];
        if f < 3 { p.fund(ks[f], 1); } else { for k in ks { p.fund(k, 5 * SOL / 1000); } }
        let d = p.run(&[start_ix(player, 1, BET, key("s"))]);
        d.assert_ok();
        cu(&format!("start_game_vrf (pre-funded {label})"), &d);
    }
}

#[test]
fn sgv_init_pda_owned_elsewhere() {
    for slot in [0usize, 1, 2] {
        let (mut p, _w, _) = world();
        let player = p.user("player");
        let ks = [pda::vrf_claim(&player), pda::vrf_game(&player), pda::stats(&player)];
        p.set_account(ks[slot], Account { lamports: 1, data: vec![], owner: ids::VRF_PROGRAM, executable: false, rent_epoch: 0 });
        let d = p.run(&[start_ix(player, 1, BET, key("s"))]);
        println!("sgv_init_pda_owned_elsewhere {slot}: {}", d.report().lines().next().unwrap());
        d.assert_failed();
    }
}

#[test]
fn sgv_second_start_fails() {
    let mut v = started(1);
    v.p.run(&[start_ix(v.player, 1, BET, v.session)]).assert_failed();
}

#[test]
fn sgv_vrf_disabled() {
    let mut p = Pair::new();
    p.house_world();
    let player = p.user("player");
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(6042);
}

#[test]
fn sgv_validator_not_set() {
    let (mut p, _w, _) = world();
    p.patch(ids::V2_STATE, |d| d[128..160].fill(0));
    let player = p.user("player");
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(6053);
}

#[test]
fn sgv_vrf_max_payout_zero() {
    let (mut p, _w, _) = world();
    p.patch(ids::V2_STATE, |d| le16(d, 160, 0));
    let player = p.user("player");
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(6053);
}

#[test]
fn sgv_paused() {
    let (mut p, _w, _) = world();
    p.patch(ids::VAULT, |d| d[137] = 1);
    let player = p.user("player");
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(6012);
}

#[test]
fn sgv_invalid_mine_count() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    for m in [0u8, 16, 255] {
        p.run(&[start_ix(player, m, BET, key("s"))]).assert_err(6000);
    }
}

#[test]
fn sgv_bet_exceeds_max_and_worst_case() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    let available = p.lamports(&ids::VAULT) - rent_min(accounts::Vault::SPACE);
    let max_bet = available * 100 / 10_000;
    p.run(&[start_ix(player, 1, max_bet + 1, key("s"))]).assert_err(6005);
    p.run(&[start_ix(player, 1, u64::MAX, key("s"))]).assert_err(6005);
    p.run(&[start_ix(player, 1, max_bet, key("s"))]).assert_err(6006); // passes max_bet, worst case too big
    p.run(&[start_ix(player, 3, BET, key("s"))]).assert_err(6006);
}

#[test]
fn sgv_health_floor() {
    let (mut p, _w, _) = world();
    p.patch(ids::V2_STATE, |d| le16(d, 109, 10_000));
    let player = p.user("player");
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(6034);
}

#[test]
fn sgv_health_zero_blocks_bet() {
    let (mut p, _w, _) = world();
    p.patch(ids::V2_STATE, |d| le64(d, 9, 1_000 * SOL));
    let player = p.user("player");
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(6005);
}

#[test]
fn sgv_health_math_overflow() {
    let (mut p, _w, _) = world();
    p.patch(ids::V2_STATE, |d| { le64(d, 9, u64::MAX); le128(d, 17, 1); le128(d, 89, 1); });
    let player = p.user("player");
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(6008);
}

#[test]
fn sgv_signer_and_mut() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    let i = || start_ix(player, 1, BET, key("s"));
    p.run(&[unsign(i(), 0)]).assert_err(3010);
    p.run(&[ro(i(), 0)]).assert_failed(); // payer of the inits not writable
    p.run(&[ro(i(), 1)]).assert_err(2000);
    p.run(&[ro(i(), 2)]).assert_err(2000);
    p.run(&[ro(i(), 3)]).assert_failed();
    p.run(&[ro(i(), 4)]).assert_failed();
    p.run(&[ro(i(), 5)]).assert_failed();
}

#[test]
fn sgv_wrong_pdas() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    let other = key("other");
    let i = || start_ix(player, 1, BET, key("s"));
    p.run(&[sub(i(), 3, pda::vrf_claim(&other))]).assert_err(2006);
    p.run(&[sub(i(), 4, pda::vrf_game(&other))]).assert_err(2006);
    p.run(&[sub(i(), 5, pda::stats(&other))]).assert_err(2006);
    p.run(&[sub(i(), 3, pda::vrf_game(&player))]).assert_failed(); // game PDA twice (claim + game slots)
    p.run(&[sub(i(), 4, pda::vrf_claim(&player))]).assert_failed();
}

#[test]
fn sgv_vault_v2_substitution() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    let i = || start_ix(player, 1, BET, key("s"));
    p.run(&[sub(i(), 1, ids::V2_STATE)]).assert_err(3002);
    p.run(&[sub(i(), 2, ids::VAULT)]).assert_err(3002);
    p.run(&[sub(i(), 1, key("nothing"))]).assert_err(3012);
    let foreign = key("foreign-vault");
    let va = p.get(&ids::VAULT).unwrap();
    p.set_data(foreign, ids::VRF_PROGRAM, va.data.clone());
    p.run(&[sub(i(), 1, foreign)]).assert_err(3007);
    let fake = key("fake-vault");
    p.set_program_account(fake, va.data.clone());
    p.run(&[sub(i(), 1, fake)]).assert_err(2006);
    let tiny = key("tiny");
    p.set_program_account(tiny, vec![1, 2, 3]);
    p.run(&[sub(i(), 1, tiny)]).assert_err(3001);
    let fake_v2 = key("fake-v2");
    p.set_program_account(fake_v2, p.get(&ids::V2_STATE).unwrap().data);
    p.run(&[sub(i(), 2, fake_v2)]).assert_err(2006);
}

#[test]
fn sgv_bad_bool_bytes() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    p.patch(ids::V2_STATE, |d| d[127] = 2);
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(3003);
    p.patch(ids::V2_STATE, |d| d[127] = 1);
    p.patch(ids::VAULT, |d| d[137] = 2);
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(3003);
}

#[test]
fn sgv_truncated_v2() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    let mut a = p.get(&ids::V2_STATE).unwrap();
    a.data.truncate(150);
    p.set_account(ids::V2_STATE, a);
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_err(3003);
}

#[test]
fn sgv_system_program_wrong() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    p.run(&[sub(start_ix(player, 1, BET, key("s")), 6, ids::VRF_PROGRAM)]).assert_err(3008);
    p.run(&[sub(start_ix(player, 1, BET, key("s")), 6, key("sysx"))]).assert_err(3008);
}

#[test]
fn sgv_stats_existing_bad() {
    let base = accounts::PlayerStats { player: Address::default(), bump: 0, version: 0, games_played: 0, games_won: 0, total_wagered: 0, total_payouts: 0,
        biggest_win: 0, biggest_multiplier_bps: 0, current_streak: 0, best_streak: 0, last_played: 0, referrer: None, _reserved: [0; 64] };
    let cases: Vec<(&str, Box<dyn Fn(&mut Pair, Address)>, Option<u32>)> = vec![
        ("wrong owner", Box::new(|p: &mut Pair, k| p.set_data(k, ids::VRF_PROGRAM, base.encode())), Some(3007)),
        ("wrong disc", Box::new(|p: &mut Pair, k| { let mut d = base.encode(); d[0] ^= 1; p.set_program_account(k, d) }), Some(3002)),
        ("short <8", Box::new(|p: &mut Pair, k| p.set_program_account(k, vec![0; 4])), Some(3001)),
        ("bad option tag", Box::new(|p: &mut Pair, k| { let mut d = base.encode(); d[106] = 2; p.set_program_account(k, d) }), Some(3003)),
        ("too big", Box::new(|p: &mut Pair, k| { let mut d = base.encode(); d.resize(250, 0); p.set_program_account(k, d) }), Some(2019)),
        ("below rent", Box::new(|p: &mut Pair, k| p.set_account(k, Account { lamports: 1, data: base.encode(), owner: PROGRAM_ID, executable: false, rent_epoch: 0 })), Some(2005)),
    ];
    for (name, f, code) in cases {
        let (mut p, _w, _) = world();
        let player = p.user("player");
        f(&mut p, pda::stats(&player));
        let d = p.run(&[start_ix(player, 1, BET, key("s"))]);
        println!("sgv_stats_existing_bad {name}: {}", d.report().lines().next().unwrap());
        match code { Some(c) => { d.assert_err(c); } None => { d.assert_failed(); } }
    }
}

#[test]
fn sgv_short_accounts_and_data() {
    let (mut p, _w, _) = world();
    let player = p.user("player");
    p.run(&[short(start_ix(player, 1, BET, key("s")), 6)]).assert_failed();
    p.run(&[short(start_ix(player, 1, BET, key("s")), 0)]).assert_failed();
    p.run(&[with_data(start_ix(player, 1, BET, key("s")), 48)]).assert_err(102);
    p.run(&[with_data(start_ix(player, 1, BET, key("s")), 8)]).assert_err(102);
    p.run(&[with_data(start_ix(player, 1, BET, key("s")), 60)]).assert_ok(); // trailing bytes ignored
}

#[test]
fn sgv_player_cannot_pay() {
    let (mut p, _w, _) = world();
    let player = key("poor");
    p.fund(player, 4_000_000); // covers rents (~6.5M)? no: fails somewhere in the inits / bet transfer
    p.run(&[start_ix(player, 1, BET, key("s"))]).assert_failed();
    let player2 = key("poor2");
    p.fund(player2, rent_min(69) + rent_min(621) + rent_min(203) + BET - 1);
    p.run(&[start_ix(player2, 1, BET, key("s"))]).assert_failed();
}

#[test]
fn sgv_session_is_player_or_default() {
    let (mut p, _w, _) = world();
    let a = p.user("a");
    p.run(&[start_ix(a, 1, BET, a)]).assert_ok();
    let b = p.user("b");
    p.run(&[start_ix(b, 1, BET, Address::default())]).assert_ok();
}

// ───────────────────────────── 2. delegate_vrf ─────────────────────────────

#[test]
fn dv_happy_with_validator() {
    let mut v = started(1);
    let d = v.p.run(&[deleg_ix(v.player, Some(v.validator))]);
    d.assert_ok().assert_cpi_same();
    cu("delegate_vrf", &d);
    let g = v.p.get(&v.game).unwrap();
    assert_eq!(g.owner, ids::DLP);
    assert!(v.p.get(&pda::buffer(&v.game)).is_none_or(|a| a.lamports == 0));
}

#[test]
fn dv_happy_no_remaining_and_extra_remaining() {
    let mut v = started(1);
    v.p.run(&[deleg_ix(v.player, None)]).assert_ok().assert_cpi_same();
    let mut v = started(1);
    let mut i = deleg_ix(v.player, Some(v.validator));
    i.accounts.push(AccountMeta::new_readonly(key("junk"), false));
    v.p.run(&[i]).assert_ok();
}

#[test]
fn dv_prefunded_buffer() {
    let mut v = started(1);
    let buf = pda::buffer(&v.game);
    v.p.fund(buf, 1);
    let d = v.p.run(&[deleg_ix(v.player, Some(v.validator))]);
    d.assert_ok(); // CPI-level close differs (lamport move vs Transfer): accepted
    cu("delegate_vrf (pre-funded buffer)", &d);
    assert!(v.p.get(&buf).is_none_or(|a| a.lamports == 0));
}

#[test]
fn dv_prefunded_buffer_large() {
    let mut v = started(1);
    v.p.fund(pda::buffer(&v.game), SOL);
    v.p.run(&[deleg_ix(v.player, Some(v.validator))]).assert_ok();
}

#[test]
fn dv_wrong_validator() {
    let mut v = started(1);
    v.p.run(&[deleg_ix(v.player, Some(key("evil-validator")))]).assert_err(6054);
}

#[test]
fn dv_validator_not_set() {
    let mut v = started(1);
    v.p.patch(ids::V2_STATE, |d| d[128..160].fill(0));
    v.p.run(&[deleg_ix(v.player, None)]).assert_err(6053);
}

#[test]
fn dv_already_delegated_and_missing_game() {
    let mut v = started(1);
    v.p.ok(&[deleg_ix(v.player, None)]);
    v.p.run(&[deleg_ix(v.player, None)]).assert_failed(); // DLP-owned game: 6052 or a DLP-side failure
    let (mut p, _w, _) = world();
    let nobody = p.user("nobody");
    p.run(&[deleg_ix(nobody, None)]).assert_err(6052);
}

#[test]
fn dv_already_delegated_code() {
    let mut v = started(1);
    v.p.ok(&[deleg_ix(v.player, None)]);
    v.p.run(&[deleg_ix(v.player, None)]).assert_err(6052);
}

#[test]
fn dv_game_state_checks() {
    let cases: [(&str, fn(&mut Vec<u8>), u32); 4] = [
        ("short", |d| d.truncate(79), 6049),
        ("disc", |d| d[0] ^= 0xff, 6049),
        ("resolved", |d| d[8] = 1, 6050),
        ("pending", |d| d[79] = 1, 6044),
    ];
    for (name, f, code) in cases {
        let mut v = started(1);
        let mut a = v.p.get(&v.game).unwrap();
        f(&mut a.data);
        v.p.set_account(v.game, a);
        let d = v.p.run(&[deleg_ix(v.player, None)]);
        println!("dv_game_state_checks {name}: {}", d.report().lines().next().unwrap());
        d.assert_err(code);
    }
}

#[test]
fn dv_wrong_pdas() {
    let mut v = started(1);
    let other = key("other");
    let og = pda::vrf_game(&other);
    let i = || deleg_ix(v.player, None);
    let (b, r, m) = (sub(i(), 1, pda::buffer(&og)), sub(i(), 2, pda::delegation_record(&og)), sub(i(), 3, pda::delegation_metadata(&og)));
    v.p.run(&[b]).assert_err(2006);
    v.p.run(&[r]).assert_err(2006);
    v.p.run(&[m]).assert_err(2006);
    v.p.run(&[sub(i(), 4, og)]).assert_err(2006);
    v.p.run(&[sub(i(), 1, v.game)]).assert_err(2006); // game passed twice (buffer slot)
}

#[test]
fn dv_signer_mut() {
    let mut v = started(1);
    let i = || deleg_ix(v.player, None);
    v.p.run(&[unsign(i(), 0)]).assert_err(3010);
    for idx in 0..5 { v.p.run(&[ro(i(), idx)]).assert_err(2000); }
}

#[test]
fn dv_program_substitution() {
    let mut v = started(1);
    let i = || deleg_ix(v.player, None);
    v.p.run(&[sub(i(), 5, ids::VAULT)]).assert_err(3002);
    v.p.run(&[sub(i(), 6, ids::VRF_PROGRAM)]).assert_err(2012);
    v.p.run(&[sub(i(), 7, ids::VRF_PROGRAM)]).assert_err(2006); // record seeds under the passed program
    v.p.run(&[sub(i(), 8, ids::VRF_PROGRAM)]).assert_err(3008);
    let mut w = i();
    w.accounts[5].is_writable = true; // v2 writable: allowed
    v.p.run(&[w]).assert_ok();
}

#[test]
fn dv_short_accounts_trailing_args() {
    let mut v = started(1);
    v.p.run(&[short(deleg_ix(v.player, None), 8)]).assert_failed();
    v.p.run(&[with_data(deleg_ix(v.player, None), 20)]).assert_ok();
}

// ───────────────────────────── 3. reveal_request_vrf ─────────────────────────────

#[test]
fn rr_happy_delegated_flow() {
    let mut v = started(1);
    v.p.ok(&[deleg_ix(v.player, Some(v.validator))]);
    let l1 = v.p.get(&v.game).unwrap().data;
    v.p.er_game(v.game, l1);
    let d = v.p.run(&[req_ix(v.session, v.game, 5)]);
    d.assert_ok().assert_cpi_same();
    cu("reveal_request_vrf", &d);
    let g = v.p.read(&v.game, accounts::VrfGame::decode);
    assert_eq!((g.pending, g.pending_tile), (true, 5));
}

#[test]
fn rr_tile_boundaries() {
    let mut v = started(1);
    v.p.run(&[req_ix(v.session, v.game, 16)]).assert_err(6001);
    v.p.run(&[req_ix(v.session, v.game, 255)]).assert_err(6001);
    v.p.run(&[req_ix(v.session, v.game, 15)]).assert_ok().assert_cpi_same();
    v.p.run(&[req_ix(v.session, v.game, 0)]).assert_err(6044); // pending now
}

#[test]
fn rr_handler_errors() {
    let mut v = started(1);
    v.p.run(&[req_ix(v.player, v.game, 1)]).assert_err(6043); // player is not the session key
    v.p.patch(v.game, |d| d[8] = 1);
    v.p.run(&[req_ix(v.session, v.game, 1)]).assert_err(6003);
    v.p.patch(v.game, |d| { d[8] = 0; le16(d, 81, 1 << 4); });
    v.p.run(&[req_ix(v.session, v.game, 4)]).assert_err(6002);
    v.p.run(&[req_ix(v.session, v.game, 5)]).assert_ok();
}

#[test]
fn rr_account_constraints() {
    let mut v = started(1);
    let i = || req_ix(v.session, v.game, 1);
    v.p.run(&[sub(i(), 2, key("queue"))]).assert_err(6054);
    v.p.run(&[ro(i(), 2)]).assert_err(2000);
    v.p.run(&[sub(i(), 3, ids::SCOPED_VRF_IDENTITY)]).assert_err(2006);
    v.p.run(&[sub(i(), 4, ids::DLP)]).assert_err(3008);
    v.p.run(&[sub(i(), 5, key("sh"))]).assert_err(2012);
    v.p.run(&[sub(i(), 6, ids::VRF_PROGRAM)]).assert_err(3008);
    v.p.run(&[unsign(i(), 0)]).assert_err(3010);
    v.p.run(&[ro(i(), 0)]).assert_err(2000);
    v.p.run(&[ro(i(), 1)]).assert_err(2000);
}

#[test]
fn rr_game_substitution() {
    let mut v = started(1);
    let i = |g| req_ix(v.session, g, 1);
    let fake = copy_to(&mut v.p, v.game, "fake-game");
    v.p.run(&[i(fake)]).assert_err(2006);
    v.p.run(&[i(v.claim)]).assert_err(3002);
    v.p.run(&[i(key("none"))]).assert_err(3012);
    let foreign = key("foreign-game");
    let data = v.p.get(&v.game).unwrap().data;
    v.p.set_data(foreign, ids::DLP, data);
    v.p.run(&[i(foreign)]).assert_err(3007);
    v.p.patch(v.game, |d| d[73] ^= 1); // stored bump wrong
    v.p.run(&[i(v.game)]).assert_err(2006);
}

#[test]
fn rr_game_bad_bytes() {
    let mut v = started(1);
    v.p.patch(v.game, |d| d[79] = 2);
    v.p.run(&[req_ix(v.session, v.game, 1)]).assert_err(3003);
    let mut a = v.p.get(&v.game).unwrap();
    a.data[79] = 0;
    a.data.truncate(620);
    v.p.set_account(v.game, a);
    v.p.run(&[req_ix(v.session, v.game, 1)]).assert_err(3003);
}

#[test]
fn rr_delegated_game_on_l1() {
    let mut v = started(1);
    v.p.ok(&[deleg_ix(v.player, None)]);
    v.p.run(&[req_ix(v.session, v.game, 1)]).assert_err(3007);
}

#[test]
fn rr_short() {
    let mut v = started(1);
    v.p.run(&[with_data(req_ix(v.session, v.game, 1), 9)]).assert_err(102);
    v.p.run(&[short(req_ix(v.session, v.game, 1), 6)]).assert_failed();
    v.p.run(&[with_data(req_ix(v.session, v.game, 1), 30)]).assert_ok();
}

// ───────────────────────────── 4. reveal_callback_vrf ─────────────────────────────

#[test]
fn cb_happy_safe_and_mine() {
    let mut v = started(1);
    let d = reveal(&mut v.p, v.game, 5, false);
    d.assert_ok();
    cu("reveal_callback_vrf (safe)", &d);
    let g = v.p.read(&v.game, accounts::VrfGame::decode);
    assert_eq!((g.status, g.safe_reveals, g.reveal_count, g.pending, g.pending_tile, g.revealed_mask), (0, 1, 1, false, 255, 1 << 5));
    let d = reveal(&mut v.p, v.game, 6, true);
    d.assert_ok();
    cu("reveal_callback_vrf (mine)", &d);
    let g = v.p.read(&v.game, accounts::VrfGame::decode);
    assert_eq!((g.status, g.mine_mask), (2, 1 << 6));
}

#[test]
fn cb_full_board_win() {
    let mut v = started(15);
    reveal(&mut v.p, v.game, 0, false).assert_ok();
    assert_eq!(status(&v.p, &v.game), 1);
    // 1 mine: 15 safe reveals end in Won
    let mut v = started(1);
    for t in 0..15 { reveal(&mut v.p, v.game, t, false).assert_ok(); }
    let g = v.p.read(&v.game, accounts::VrfGame::decode);
    assert_eq!((g.status, g.safe_reveals, g.reveal_count), (1, 15, 15));
}

#[test]
fn cb_signer_identity() {
    let mut v = started(1);
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 2; });
    let i = || cb_ix(v.game, [7; 32]);
    v.p.run(&[sub(i(), 0, ids::IDENTITY)]).assert_err(2012);
    v.p.run(&[sub(i(), 0, v.session)]).assert_err(2012);
    v.p.run(&[unsign(i(), 0)]).assert_err(3010);
    v.p.run(&[ro(i(), 1)]).assert_err(2000);
    v.p.run(&[i()]).assert_ok();
}

#[test]
fn cb_handler_errors() {
    let mut v = started(1);
    v.p.run(&[cb_ix(v.game, [7; 32])]).assert_err(6045);
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 2; d[78] = 16; });
    v.p.run(&[cb_ix(v.game, [7; 32])]).assert_err(6046);
    v.p.patch(v.game, |d| d[78] = 255);
    v.p.run(&[cb_ix(v.game, [7; 32])]).assert_err(6046);
}

#[test]
fn cb_pending_tile_out_of_range() {
    // Anchor panics on `1u16 << 16`; the port must fail too (accepted panic-vs-error deviation).
    let mut v = started(1);
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 16; });
    v.p.run(&[cb_ix(v.game, [7; 32])]).assert_failed();
    v.p.patch(v.game, |d| d[80] = 255);
    v.p.run(&[cb_ix(v.game, [7; 32])]).assert_failed();
}

#[test]
fn cb_edge_over_bps_panics() {
    let mut v = started(1);
    v.p.patch(v.game, |d| le16(d, 75, 10_001));
    reveal(&mut v.p, v.game, 1, false).assert_failed();
    // mine path never computes the multiplier: succeeds on both
    reveal(&mut v.p, v.game, 1, true).assert_ok();
}

#[test]
fn cb_odd_mine_counts() {
    let mut v = started(1);
    v.p.patch(v.game, |d| d[74] = 0); // never a mine
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 0; });
    v.p.run(&[cb_ix(v.game, [0; 32])]).assert_ok();
    let mut v = started(1);
    v.p.patch(v.game, |d| d[74] = 16); // always a mine
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 0; });
    v.p.run(&[cb_ix(v.game, [0xff; 32])]).assert_ok();
    let mut v = started(1);
    v.p.patch(v.game, |d| { d[74] = 14; d[77] = 3; }); // mines + safe > 16 with a safe draw impossible -> mine
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 0; });
    v.p.run(&[cb_ix(v.game, [0xff; 32])]).assert_ok();
    let mut v = started(1);
    v.p.patch(v.game, |d| { d[74] = 1; d[77] = 16; }); // safe_reveals 16: rem 0 -> never mine; calc_multiplier errors
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 0; });
    v.p.run(&[cb_ix(v.game, [0xff; 32])]).assert_err(6000);
    let mut v = started(1);
    v.p.patch(v.game, |d| { d[77] = 255; });
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 0; });
    v.p.run(&[cb_ix(v.game, [0xff; 32])]).assert_failed();
}

#[test]
fn cb_game_substitution() {
    let mut v = started(1);
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 2; });
    // no seeds constraint: any program-owned VrfGame works (parity)
    let fake = copy_to(&mut v.p, v.game, "fake-game");
    v.p.run(&[cb_ix(fake, [7; 32])]).assert_ok();
    v.p.run(&[cb_ix(v.claim, [7; 32])]).assert_err(3002);
    v.p.run(&[cb_ix(key("none"), [7; 32])]).assert_err(3012);
    let foreign = key("foreign");
    let data = v.p.get(&v.game).unwrap().data;
    v.p.set_data(foreign, ids::DLP, data);
    v.p.run(&[cb_ix(foreign, [7; 32])]).assert_err(3007);
    v.p.patch(v.game, |d| d[79] = 3);
    v.p.run(&[cb_ix(v.game, [7; 32])]).assert_err(3003);
}

#[test]
fn cb_short() {
    let mut v = started(1);
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 2; });
    v.p.run(&[with_data(cb_ix(v.game, [7; 32]), 39)]).assert_err(102);
    v.p.run(&[short(cb_ix(v.game, [7; 32]), 1)]).assert_failed();
    v.p.run(&[with_data(cb_ix(v.game, [7; 32]), 50)]).assert_ok();
}

// ───────────────────────────── 5. cash_out_vrf ─────────────────────────────

#[test]
fn co_happy_session_and_player() {
    let mut v = started(1);
    reveal(&mut v.p, v.game, 3, false).assert_ok();
    let d = v.p.run(&[cash_ix(v.session, v.game)]);
    d.assert_ok();
    cu("cash_out_vrf", &d);
    assert_eq!(status(&v.p, &v.game), 1);
    let mut v = started(1);
    reveal(&mut v.p, v.game, 3, false).assert_ok();
    v.p.run(&[with_data(cash_ix(v.player, v.game), 16)]).assert_ok();
}

#[test]
fn co_handler_errors() {
    let mut v = started(1);
    v.p.run(&[cash_ix(v.session, v.game)]).assert_err(6019);
    reveal(&mut v.p, v.game, 3, false).assert_ok();
    let stranger = v.p.user("stranger");
    v.p.run(&[cash_ix(stranger, v.game)]).assert_err(6043);
    v.p.run(&[cash_ix(v.game, v.game)]).assert_err(6043); // game in both slots
    v.p.patch(v.game, |d| d[79] = 1);
    v.p.run(&[cash_ix(v.session, v.game)]).assert_err(6044);
    v.p.patch(v.game, |d| { d[79] = 0; d[8] = 2; });
    v.p.run(&[cash_ix(v.session, v.game)]).assert_err(6003);
}

#[test]
fn co_account_checks() {
    let mut v = started(1);
    reveal(&mut v.p, v.game, 3, false).assert_ok();
    v.p.run(&[unsign(cash_ix(v.session, v.game), 0)]).assert_err(3010);
    v.p.run(&[ro(cash_ix(v.session, v.game), 0)]).assert_err(2000);
    v.p.run(&[ro(cash_ix(v.session, v.game), 1)]).assert_err(2000);
    let fake = copy_to(&mut v.p, v.game, "fake");
    v.p.run(&[cash_ix(v.session, fake)]).assert_err(2006);
    v.p.run(&[cash_ix(v.session, key("none"))]).assert_err(3012);
    v.p.run(&[cash_ix(v.session, v.claim)]).assert_err(3002);
    v.p.run(&[short(cash_ix(v.session, v.game), 1)]).assert_failed();
    let data = v.p.get(&v.game).unwrap().data;
    v.p.set_data(v.game, ids::DLP, data);
    v.p.run(&[cash_ix(v.session, v.game)]).assert_err(3007);
}

// ───────────────────────────── 6. settle_and_undelegate_vrf ─────────────────────────────

#[test]
fn sau_happy() {
    let mut v = won(1);
    let d = v.p.run(&[sau_ix(v.session, v.game)]);
    d.assert_ok().assert_cpi_same();
    cu("settle_and_undelegate_vrf", &d);
    // INTENDED: F3. A PLAYING game is ended before it leaves the ER: Anchor commits it PLAYING, the port
    // VOID (no progress). Same CPI; the status byte is the only difference.
    let mut v = started(1);
    let d = v.p.run(&[sau_ix(v.player, v.game)]);
    assert!(d.anchor.ok() && d.port.ok(), "{}", d.report());
    d.assert_cpi_same();
    assert_eq!(only_status_differs(&v.p, &v.game), (VRF_PLAYING, VRF_VOID));
}

const VRF_PLAYING: u8 = 0;
const VRF_WON: u8 = 1;
const VRF_VOID: u8 = 3;

/// After an F3 divergence on `game`: both sides' bytes differ only in the status byte; returns (anchor, port) status.
fn only_status_differs(p: &Pair, game: &Address) -> (u8, u8) {
    let (a, pt) = p.get_both(game);
    let (mut a, pt) = (a.unwrap().data, pt.unwrap().data);
    let st = (a[8], pt[8]);
    a[8] = pt[8];
    assert_eq!(a, pt, "only the status byte differs");
    st
}

/// undeleg_setup for a game whose two sides differ (F3): each side's buffer gets its own ER bytes.
fn undeleg_each_side(p: &mut Pair, player: Address) -> Instruction {
    let game = pda::vrf_game(&player);
    let (a, pt) = p.get_both(&game);
    let buffer = pda::undelegate_buffer(&game);
    sys_empty(p, game);
    p.set_data(buffer, ids::DLP, pt.unwrap().data);
    let mut acc = p.anchor.get_account(&buffer).unwrap();
    acc.data = a.unwrap().data;
    p.anchor.set_account(buffer, acc).unwrap();
    let payer = p.user("dlp-payer");
    undeleg_ix(game, buffer, payer, game_seeds(&player))
}

#[test]
fn sau_errors() {
    let mut v = won(1);
    let stranger = v.p.user("stranger");
    v.p.run(&[sau_ix(stranger, v.game)]).assert_err(6043);
    let i = || sau_ix(v.session, v.game);
    v.p.run(&[unsign(i(), 0)]).assert_err(3010);
    v.p.run(&[ro(i(), 0)]).assert_err(2000);
    v.p.run(&[ro(i(), 1)]).assert_err(2000);
    v.p.run(&[ro(i(), 3)]).assert_err(2000);
    v.p.run(&[sub(i(), 3, key("ctx"))]).assert_err(2012);
    v.p.run(&[sub(i(), 2, ids::VRF_PROGRAM)]).assert_err(3008);
    v.p.run(&[short(i(), 3)]).assert_failed();
    let fake = copy_to(&mut v.p, v.game, "fake");
    v.p.run(&[sau_ix(v.session, fake)]).assert_err(2006);
    v.p.run(&[sau_ix(v.session, v.claim)]).assert_err(3002);
    v.p.run(&[with_data(i(), 12)]).assert_ok();
    let data = v.p.get(&v.game).unwrap().data;
    v.p.set_data(v.game, ids::DLP, data);
    v.p.run(&[sau_ix(v.session, v.game)]).assert_err(3007);
}

// ───────────────────────────── 7. settle_vrf ─────────────────────────────

fn settle(v: &V) -> Instruction { settle_ix(v.session, v.player, v.w.treasury) }

#[test]
fn sv_win_cashout() {
    let mut v = won(1);
    let (pl, va) = (v.p.lamports(&v.player), v.p.lamports(&ids::VAULT));
    let d = v.p.run(&[settle(&v)]);
    d.assert_ok();
    cu("settle_vrf (win, no referral)", &d);
    assert!(v.p.get(&v.game).is_none_or(|a| a.lamports == 0));
    assert!(v.p.get(&v.claim).is_none_or(|a| a.lamports == 0));
    assert!(v.p.lamports(&v.player) > pl && v.p.lamports(&ids::VAULT) < va);
    assert_eq!(v.p.read(&ids::V2_STATE, accounts::VaultV2State::decode).total_outstanding_max_payout, 0);
    let s = v.p.read(&v.stats, accounts::PlayerStats::decode);
    assert_eq!((s.games_played, s.games_won, s.current_streak, s.last_played), (1, 1, 1, START_UNIX));
}

#[test]
fn sv_loss() {
    let mut v = lost();
    let d = v.p.run(&[settle(&v)]);
    d.assert_ok();
    cu("settle_vrf (loss)", &d);
    let s = v.p.read(&v.stats, accounts::PlayerStats::decode);
    assert_eq!((s.games_played, s.games_won, s.current_streak), (1, 0, 0));
}

#[test]
fn sv_full_board_and_multi_reveal() {
    let mut v = won(15);
    v.p.run(&[settle(&v)]).assert_ok();
    let mut v = started(2);
    for t in 0..4 { reveal(&mut v.p, v.game, t, false).assert_ok(); }
    reveal(&mut v.p, v.game, 9, true).assert_ok();
    let d = v.p.run(&[settle(&v)]);
    d.assert_ok();
    cu("settle_vrf (loss after 4 safe)", &d);
    let mut v = started(1);
    for t in 0..15 { reveal(&mut v.p, v.game, t, false).assert_ok(); }
    let d = v.p.run(&[settle(&v)]);
    d.assert_ok();
    cu("settle_vrf (win, 15 reveals)", &d);
}

#[test]
fn sv_referral_tiers() {
    for (tier, vol) in [(0u8, 0u64), (1, 10 * SOL), (2, 100 * SOL), (0, 10 * SOL - BET), (2, 0)] {
        let (mut v, referrer) = started_ref(1);
        reveal(&mut v.p, v.game, 3, false).assert_ok();
        v.p.ok(&[cash_ix(v.session, v.game)]);
        let rk = pda::referral(&referrer);
        v.p.patch(rk, |d| { d[42] = tier; le64(d, 63, vol); });
        let mut i = settle(&v);
        i.accounts.push(AccountMeta::new(rk, false));
        let d = v.p.run(&[i]);
        d.assert_ok();
        cu(&format!("settle_vrf (win, referral tier {tier} vol {vol})"), &d);
        let r = v.p.read(&rk, accounts::ReferralAccount::decode);
        println!("tier {tier} vol {vol} -> tier {} accrued {}", r.tier, r.accrued_lamports);
    }
}

#[test]
fn sv_referral_loss_and_missing_remaining() {
    let (mut v, referrer) = started_ref(1);
    reveal(&mut v.p, v.game, 3, true).assert_ok();
    let mut i = settle(&v);
    i.accounts.push(AccountMeta::new(pda::referral(&referrer), false));
    let d = v.p.run(&[i]);
    d.assert_ok();
    cu("settle_vrf (loss, referral)", &d);
    let (mut v, _referrer) = started_ref(1);
    reveal(&mut v.p, v.game, 3, true).assert_ok();
    // INTENDED: F5. Referrer set but no remaining account: Anchor skips the cut, the port refuses (6022).
    let d = v.p.run(&[settle(&v)]);
    assert!(d.anchor.ok());
    assert_eq!(d.port.code(), Some(6022));
}

#[test]
fn sv_referral_bad_accounts() {
    let cases: Vec<(&str, Box<dyn Fn(&mut V, Address) -> Address>, Option<u32>)> = vec![
        ("wrong pda", Box::new(|v: &mut V, _r| pda::referral(&v.session)), Some(6022)),
        ("uninit", Box::new(|v: &mut V, r| { let k = pda::referral(&r); sys_empty(&mut v.p, k); k }), Some(3012)),
        ("wrong owner", Box::new(|v: &mut V, r| { let k = pda::referral(&r); let d = v.p.get(&k).unwrap().data; v.p.set_data(k, ids::VRF_PROGRAM, d); k }), Some(3007)),
        ("wrong disc", Box::new(|v: &mut V, r| { let k = pda::referral(&r); v.p.patch(k, |d| d[0] ^= 1); k }), Some(3002)),
        ("short data", Box::new(|v: &mut V, r| { let k = pda::referral(&r); let mut a = v.p.get(&k).unwrap(); a.data.truncate(60); v.p.set_account(k, a); k }), Some(3003)),
        ("wrong referrer field", Box::new(|v: &mut V, r| { let k = pda::referral(&r); v.p.patch(k, |d| d[8] ^= 1); k }), Some(6022)),
        ("claim in slot", Box::new(|v: &mut V, _r| v.claim), Some(6022)),
    ];
    for (name, f, code) in cases {
        let (mut v, referrer) = started_ref(1);
        reveal(&mut v.p, v.game, 3, false).assert_ok();
        v.p.ok(&[cash_ix(v.session, v.game)]);
        let k = f(&mut v, referrer);
        let mut i = settle(&v);
        i.accounts.push(AccountMeta::new(k, false));
        let d = v.p.run(&[i]);
        println!("sv_referral_bad_accounts {name}: {}", d.report().lines().next().unwrap());
        match code { Some(c) => { d.assert_err(c); } None => { d.assert_failed(); } }
    }
}

#[test]
fn sv_referral_readonly() {
    let (mut v, referrer) = started_ref(1);
    reveal(&mut v.p, v.game, 3, false).assert_ok();
    v.p.ok(&[cash_ix(v.session, v.game)]);
    let mut i = settle(&v);
    i.accounts.push(AccountMeta::new_readonly(pda::referral(&referrer), false));
    v.p.run(&[i]).assert_failed();
}

#[test]
fn sv_referral_cut_capped_by_vault() {
    let (mut v, referrer) = started_ref(1);
    reveal(&mut v.p, v.game, 3, true).assert_ok(); // loss: no payout
    set_lamports(&mut v.p, ids::VAULT, rent_min(accounts::Vault::SPACE) + 10_000);
    let mut i = settle(&v);
    i.accounts.push(AccountMeta::new(pda::referral(&referrer), false));
    v.p.run(&[i]).assert_ok();
    let r = v.p.read(&pda::referral(&referrer), accounts::ReferralAccount::decode);
    assert_eq!(r.accrued_lamports, 10_000);
}

#[test]
fn sv_treasury_split() {
    for split in [0u16, 5_000, 10_000] {
        for lose in [false, true] {
            let mut v = if lose { lost() } else { won(1) };
            println!("default treasury_split_bps = {}", v.p.read(&ids::VAULT, accounts::Vault::decode).treasury_split_bps);
            v.p.ok(&[ix::UpdateVault { owner: v.w.owner, ..Default::default() }.ix(None, None, None, Some(split), None, None, None)]);
            let t0 = v.p.lamports(&v.w.treasury);
            let d = v.p.run(&[settle(&v)]);
            d.assert_ok();
            cu(&format!("settle_vrf (treasury split {split}, lost={lose})"), &d);
            assert_eq!(v.p.lamports(&v.w.treasury) > t0, split > 0);
        }
    }
}

#[test]
fn sv_treasury_split_with_pending_units_and_low_liquidity() {
    let mut v = won(1);
    v.p.ok(&[ix::UpdateVault { owner: v.w.owner, ..Default::default() }.ix(None, None, None, Some(10_000), None, None, None)]);
    v.p.patch(ids::V2_STATE, |d| { le128(d, 17, 100); le128(d, 89, 99); });
    v.p.run(&[settle(&v)]).assert_ok();
    let mut v = won(1);
    v.p.ok(&[ix::UpdateVault { owner: v.w.owner, ..Default::default() }.ix(None, None, None, Some(10_000), None, None, None)]);
    v.p.patch(ids::V2_STATE, |d| le64(d, 9, 1_000 * SOL)); // outstanding > assets: liquidity 0
    v.p.run(&[settle(&v)]).assert_ok();
}

#[test]
fn sv_treasury_is_player_and_payer_is_player() {
    let mut v = won(1);
    let player = v.player;
    v.p.ok(&[ix::UpdateVault { owner: v.w.owner, ..Default::default() }.ix(None, None, None, Some(5_000), None, None, Some(player))]);
    v.p.run(&[settle_ix(player, player, player)]).assert_ok();
}

#[test]
fn sv_handler_errors() {
    let mut v = started(1);
    v.p.run(&[settle(&v)]).assert_err(6003); // still playing
    let mut v = won(1);
    v.p.patch(v.claim, |d| d[67] = 1);
    v.p.run(&[settle(&v)]).assert_err(6017);
    v.p.patch(v.claim, |d| d[67] = 2);
    v.p.run(&[settle(&v)]).assert_err(3003);
}

#[test]
fn sv_replay_mismatch() {
    let cases: [(&str, fn(&mut Pair, Address, Address), u32); 9] = [
        ("claim mine_count", |p, c, _g| p.patch(c, |d| d[56] = 2), 6047),
        ("claim edge", |p, c, _g| p.patch(c, |d| le16(d, 57, 99)), 6047),
        ("reveal_count 17", |p, _c, g| p.patch(g, |d| d[78] = 17), 6046),
        ("bad tile", |p, _c, g| p.patch(g, |d| d[93] = 16), 6001),
        ("safe count", |p, _c, g| p.patch(g, |d| d[77] = 2), 6047),
        ("status lost", |p, _c, g| p.patch(g, |d| d[8] = 2), 6047),
        ("multiplier", |p, _c, g| p.patch(g, |d| le64(d, 85, 1)), 6047),
        ("no reveals won", |p, _c, g| p.patch(g, |d| { d[78] = 0; d[77] = 0; }), 6047),
        ("randomness flipped to mine", |p, _c, g| p.patch(g, |d| { let r = rand_for(0, 1, true); d[94..126].copy_from_slice(&r); }), 6047),
    ];
    for (name, f, code) in cases {
        let mut v = won(1);
        f(&mut v.p, v.claim, v.game);
        let d = v.p.run(&[settle(&v)]);
        println!("sv_replay_mismatch {name}: {}", d.report().lines().next().unwrap());
        d.assert_err(code);
    }
}

#[test]
fn sv_payout_and_vault_limits() {
    let mut v = won(1);
    v.p.patch(v.claim, |d| le64(d, 48, 1));
    v.p.run(&[settle(&v)]).assert_err(6051);
    let mut v = won(1);
    set_lamports(&mut v.p, ids::VAULT, rent_min(accounts::Vault::SPACE) + 1_000);
    v.p.run(&[settle(&v)]).assert_err(6006);
    let mut v = won(1);
    // reserved bigger than outstanding: saturating release
    v.p.patch(ids::V2_STATE, |d| le64(d, 9, 0));
    v.p.run(&[settle(&v)]).assert_ok();
}

#[test]
fn sv_constraint_errors() {
    let mut v = won(1);
    let s = settle(&v);
    let i = || s.clone();
    v.p.run(&[settle_ix(v.session, v.player, key("evil-treasury"))]).assert_err(6007);
    v.p.run(&[unsign(i(), 0)]).assert_err(3010);
    for idx in 0..8 { let d = v.p.run(&[ro(i(), idx)]); println!("sv ro {idx}: {}", d.report().lines().next().unwrap()); d.assert_err(2000); }
    v.p.run(&[sub(i(), 8, ids::VRF_PROGRAM)]).assert_err(3008);
    v.p.run(&[sub(i(), 3, v.claim)]).assert_err(3002); // claim in both slots
    v.p.run(&[sub(i(), 2, v.game)]).assert_err(3002);
    v.p.run(&[sub(i(), 4, ids::V2_STATE)]).assert_err(3002);
    v.p.run(&[short(i(), 8)]).assert_failed();
    v.p.run(&[with_data(i(), 9)]).assert_ok();
}

#[test]
fn sv_field_mismatches() {
    let mut v = won(1);
    v.p.patch(v.claim, |d| d[8] ^= 1);
    v.p.run(&[settle(&v)]).assert_err(6007);
    let mut v = won(1);
    v.p.patch(v.game, |d| d[9] ^= 1);
    v.p.run(&[settle(&v)]).assert_err(6007);
    let mut v = won(1);
    v.p.patch(v.stats, |d| d[8] ^= 1);
    v.p.run(&[settle(&v)]).assert_err(6007);
    let mut v = won(1);
    v.p.patch(v.game, |d| d[73] ^= 1);
    v.p.run(&[settle(&v)]).assert_err(2006);
    let mut v = won(1);
    v.p.patch(v.claim, |d| d[68] ^= 1);
    v.p.run(&[settle(&v)]).assert_err(2006);
    let mut v = won(1);
    v.p.patch(v.stats, |d| d[40] ^= 1);
    v.p.run(&[settle(&v)]).assert_err(2006);
}

#[test]
fn sv_someone_elses_accounts() {
    let mut v = won(1);
    let other = v.p.user("other");
    v.p.start_game_vrf(other, 1, BET, other);
    // other player's claim/game/stats with our player
    let s = settle(&v);
    let i = || s.clone();
    v.p.run(&[sub(i(), 2, pda::vrf_claim(&other))]).assert_err(2006);
    v.p.run(&[sub(i(), 3, pda::vrf_game(&other))]).assert_err(2006);
    v.p.run(&[sub(i(), 7, pda::stats(&other))]).assert_err(2006);
    // missing stats
    sys_empty(&mut v.p, v.stats);
    v.p.run(&[i()]).assert_err(3012);
}

#[test]
fn sv_delegated_game() {
    let mut v = started(1);
    v.p.ok(&[deleg_ix(v.player, None)]);
    v.p.run(&[settle(&v)]).assert_err(3007);
}

#[test]
fn sv_stats_counters_and_streaks() {
    let mut v = won(1);
    v.p.patch(v.stats, |d| { le64(d, 42, u64::MAX); le64(d, 74, u64::MAX); d[90..94].copy_from_slice(&u32::MAX.to_le_bytes()); });
    v.p.run(&[settle(&v)]).assert_ok();
}

// ───────────────────────────── 8. refund_stalled_vrf ─────────────────────────────

#[test]
fn rs_player_happy_and_boundary() {
    let mut v = started(1);
    reveal(&mut v.p, v.game, 3, false).assert_ok();
    v.p.warp(START_SLOT + 25);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6048);
    v.p.warp(START_SLOT + 26);
    let pl = v.p.lamports(&v.player);
    let d = v.p.run(&[refund_ix(v.player, v.player)]);
    d.assert_ok();
    cu("refund_stalled_vrf (player)", &d);
    assert!(v.p.get(&v.game).is_none_or(|a| a.lamports == 0));
    assert!(v.p.get(&v.claim).is_none_or(|a| a.lamports == 0));
    assert_eq!(v.p.lamports(&v.player), pl + BET + rent_min(69) + rent_min(621));
    // a new game can start afterwards
    v.p.run(&[start_ix(v.player, 1, BET, v.session)]).assert_ok();
}

#[test]
fn rs_house_happy_and_limits() {
    let mut v = started(1);
    v.p.warp(START_SLOT + 26);
    let d = v.p.run(&[refund_ix(v.w.house, v.player)]);
    d.assert_ok();
    cu("refund_stalled_vrf (house)", &d);
    let mut v = started(1);
    v.p.warp(START_SLOT + 26);
    v.p.patch(v.game, |d| d[77] = 1);
    v.p.run(&[refund_ix(v.w.house, v.player)]).assert_err(6007);
    v.p.patch(v.game, |d| { d[77] = 0; d[79] = 1; });
    v.p.run(&[refund_ix(v.w.house, v.player)]).assert_err(6007);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_ok(); // player may refund a pending game
}

#[test]
fn rs_handler_errors() {
    let mut v = started(1);
    v.p.warp(START_SLOT + 26);
    let stranger = v.p.user("stranger");
    v.p.run(&[refund_ix(stranger, v.player)]).assert_err(6007);
    v.p.patch(v.game, |d| d[8] = 1);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6050);
    v.p.patch(v.game, |d| { d[8] = 0; d[9] ^= 1; });
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6049);
    v.p.patch(v.game, |d| { d[9] ^= 1; d[0] ^= 1; }); // no discriminator check: parity says this refunds
    v.p.run(&[refund_ix(v.player, v.player)]).assert_ok();
}

#[test]
fn rs_game_short_missing_delegated() {
    let mut v = started(1);
    v.p.warp(START_SLOT + 26);
    let mut a = v.p.get(&v.game).unwrap();
    a.data.truncate(79);
    v.p.set_account(v.game, a);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6049);
    sys_empty(&mut v.p, v.game);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6052);
    let mut v = started(1);
    v.p.ok(&[deleg_ix(v.player, None)]);
    v.p.warp(START_SLOT + 26);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6052);
}

#[test]
fn rs_claim_and_vault_errors() {
    let mut v = started(1);
    v.p.warp(START_SLOT + 26);
    v.p.patch(v.claim, |d| d[67] = 1);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6017);
    v.p.patch(v.claim, |d| { d[67] = 0; d[8] ^= 1; });
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6007);
    v.p.patch(v.claim, |d| d[8] ^= 1);
    set_lamports(&mut v.p, ids::VAULT, rent_min(accounts::Vault::SPACE) + BET - 1);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6006);
    set_lamports(&mut v.p, ids::VAULT, rent_min(accounts::Vault::SPACE) + BET);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_ok();
}

#[test]
fn rs_constraints() {
    let mut v = started(1);
    v.p.warp(START_SLOT + 26);
    let other = v.p.user("other");
    v.p.start_game_vrf(other, 1, BET, other);
    let i = || refund_ix(v.player, v.player);
    v.p.run(&[unsign(i(), 0)]).assert_err(3010);
    for idx in 1..6 { v.p.run(&[ro(i(), idx)]).assert_err(2000); }
    v.p.run(&[sub(i(), 2, pda::vrf_claim(&other))]).assert_err(2006);
    v.p.run(&[sub(i(), 3, pda::vrf_game(&other))]).assert_err(2006);
    v.p.run(&[sub(i(), 2, v.game)]).assert_err(3002);
    v.p.run(&[sub(i(), 4, ids::V2_STATE)]).assert_err(3002);
    v.p.run(&[short(i(), 5)]).assert_failed();
    let mut w = i();
    w.accounts[0].is_writable = true;
    v.p.run(&[with_data(w, 12)]).assert_ok();
}

// ───────────────────────────── 9. admin_release_vrf_claim ─────────────────────────────

#[test]
fn ar_happy_and_boundary() {
    let mut v = started(1);
    v.p.warp(START_SLOT + 216_000);
    v.p.run(&[release_ix(v.w.owner, v.player)]).assert_err(6048);
    v.p.warp(START_SLOT + 216_001);
    let pl = v.p.lamports(&v.player);
    let d = v.p.run(&[release_ix(v.w.owner, v.player)]);
    d.assert_ok();
    cu("admin_release_vrf_claim", &d);
    assert_eq!(v.p.lamports(&v.player), pl + BET + rent_min(69));
    assert!(v.p.get(&v.game).unwrap().lamports > 0); // game PDA untouched
    // INTENDED: F6. The orphaned game PDA blocks Anchor's start (Allocate: already in use); the port reuses it.
    let d = v.p.run(&[start_ix(v.player, 1, BET, v.session)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
}

#[test]
fn ar_spendable_limits() {
    // LP units > 0: spendable = assets - 1
    let mut v = started(1);
    v.p.warp(START_SLOT + 216_001);
    v.p.patch(ids::V2_STATE, |d| le128(d, 17, 1));
    set_lamports(&mut v.p, ids::VAULT, rent_min(accounts::Vault::SPACE) + 500);
    v.p.run(&[release_ix(v.w.owner, v.player)]).assert_ok();
    // empty vault: pays 0, claim still closed
    let mut v = started(1);
    v.p.warp(START_SLOT + 216_001);
    set_lamports(&mut v.p, ids::VAULT, rent_min(accounts::Vault::SPACE));
    v.p.run(&[release_ix(v.w.owner, v.player)]).assert_ok();
    // vault below rent (assets saturate to 0)
    let mut v = started(1);
    v.p.warp(START_SLOT + 216_001);
    set_lamports(&mut v.p, ids::VAULT, 1_000);
    v.p.run(&[release_ix(v.w.owner, v.player)]).assert_ok();
}

#[test]
fn ar_errors() {
    let mut v = started(1);
    v.p.warp(START_SLOT + 216_001);
    let other = v.p.user("other");
    v.p.start_game_vrf(other, 1, BET, other);
    let i = || release_ix(v.w.owner, v.player);
    v.p.run(&[release_ix(v.w.house, v.player)]).assert_err(6007);
    v.p.run(&[unsign(i(), 0)]).assert_err(3010);
    for idx in 1..5 { v.p.run(&[ro(i(), idx)]).assert_err(2000); }
    v.p.run(&[sub(i(), 2, pda::vrf_claim(&other))]).assert_err(2006);
    v.p.run(&[sub(i(), 2, v.game)]).assert_err(3002);
    v.p.run(&[sub(i(), 3, ids::V2_STATE)]).assert_err(3002);
    v.p.run(&[short(i(), 4)]).assert_failed();
    v.p.patch(v.claim, |d| d[67] = 1);
    v.p.run(&[i()]).assert_err(6017);
    v.p.patch(v.claim, |d| { d[67] = 0; d[8] ^= 1; });
    v.p.run(&[i()]).assert_err(6007);
}

#[test]
fn ar_start_slot_saturates() {
    let mut v = started(1);
    v.p.patch(v.claim, |d| le64(d, 59, u64::MAX));
    v.p.run(&[release_ix(v.w.owner, v.player)]).assert_err(6048);
    v.p.warp(START_SLOT + 26);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6048);
}

// ───────────────────────────── 10. admin_close_orphaned_game_v2 ─────────────────────────────

fn gs2(player: &Address, bet: u64, max_payout: u64, settled: u8) -> Vec<u8> {
    let mut d = vec![0u8; 221];
    d[..8].copy_from_slice(&[0x64, 0x0f, 0xad, 0x57, 0x58, 0xaf, 0xa9, 0x64]);
    d[8..40].copy_from_slice(player.as_ref());
    le64(&mut d, 42, bet);
    d[112] = settled;
    le64(&mut d, 148, max_payout);
    d
}

fn orphan_world(owner: Address) -> (Pair, World, Address) {
    let (mut p, w, _) = world();
    let player = p.user("player");
    p.set_data(pda::game_v2(&player), owner, gs2(&player, BET, 5 * BET, 0));
    p.patch(ids::V2_STATE, |d| le64(d, 9, 5 * BET));
    (p, w, player)
}

#[test]
fn ao_owned_dlp_and_foreign() {
    for (label, owner) in [("program-owned", PROGRAM_ID), ("dlp-owned", ids::DLP), ("system-owned", ids::SYSTEM)] {
        let (mut p, w, player) = orphan_world(owner);
        let pl = p.lamports(&player);
        let d = p.run(&[orphan_ix(w.owner, player)]);
        d.assert_ok();
        cu(&format!("admin_close_orphaned_game_v2 ({label})"), &d);
        let rent = if owner == PROGRAM_ID { rent_min(221) } else { 0 };
        assert_eq!(p.lamports(&player), pl + BET + rent);
    }
}

#[test]
fn ao_handler_errors() {
    let cases: [(&str, fn(&mut Vec<u8>), u32); 5] = [
        ("short", |d| d.truncate(155), 6049),
        ("disc", |d| d[0] ^= 1, 6049),
        ("player", |d| d[8] ^= 1, 6007),
        ("settled 1", |d| d[112] = 1, 6017),
        ("settled 2", |d| d[112] = 2, 6017),
    ];
    for (name, f, code) in cases {
        let (mut p, w, player) = orphan_world(PROGRAM_ID);
        let k = pda::game_v2(&player);
        let mut a = p.get(&k).unwrap();
        f(&mut a.data);
        p.set_account(k, a);
        let d = p.run(&[orphan_ix(w.owner, player)]);
        println!("ao_handler_errors {name}: {}", d.report().lines().next().unwrap());
        d.assert_err(code);
    }
    let (mut p, w, player) = orphan_world(PROGRAM_ID);
    let mut a = p.get(&pda::game_v2(&player)).unwrap();
    a.data.truncate(156); // exact minimum
    p.set_account(pda::game_v2(&player), a);
    p.run(&[orphan_ix(w.owner, player)]).assert_ok();
}

#[test]
fn ao_missing_game() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    p.run(&[orphan_ix(w.owner, player)]).assert_err(6049);
}

#[test]
fn ao_payable_limits() {
    let (mut p, w, player) = orphan_world(PROGRAM_ID);
    p.patch(pda::game_v2(&player), |d| { le64(d, 42, u64::MAX); le64(d, 148, u64::MAX); });
    p.run(&[orphan_ix(w.owner, player)]).assert_ok();
    let (mut p, w, player) = orphan_world(ids::DLP);
    set_lamports(&mut p, ids::VAULT, rent_min(accounts::Vault::SPACE));
    p.patch(ids::V2_STATE, |d| le128(d, 17, 5));
    p.run(&[orphan_ix(w.owner, player)]).assert_ok();
    let (mut p, w, player) = orphan_world(PROGRAM_ID);
    p.patch(ids::V2_STATE, |d| le128(d, 17, 5));
    set_lamports(&mut p, ids::VAULT, rent_min(accounts::Vault::SPACE) + 100);
    p.run(&[orphan_ix(w.owner, player)]).assert_ok();
}

#[test]
fn ao_constraints() {
    let (mut p, w, player) = orphan_world(PROGRAM_ID);
    let i = || orphan_ix(w.owner, player);
    p.run(&[orphan_ix(w.house, player)]).assert_err(6007);
    p.run(&[unsign(i(), 0)]).assert_err(3010);
    for idx in 1..5 { p.run(&[ro(i(), idx)]).assert_err(2000); }
    p.run(&[sub(i(), 2, pda::game_v2(&key("other")))]).assert_err(2006);
    p.run(&[sub(i(), 2, pda::vrf_game(&player))]).assert_err(2006);
    p.run(&[sub(i(), 3, ids::V2_STATE)]).assert_err(3002);
    p.run(&[sub(i(), 4, ids::VAULT)]).assert_err(3002);
    p.run(&[short(i(), 4)]).assert_failed();
    p.run(&[with_data(i(), 10)]).assert_ok();
}

// ───────────────────────────── 11. process_undelegation ─────────────────────────────

#[test]
fn pu_happy() {
    let mut v = won(1);
    let (u, er) = undeleg_setup(&mut v.p, v.player);
    let d = v.p.run(&[u]);
    d.assert_ok().assert_cpi_same();
    cu("process_undelegation", &d);
    let g = v.p.get(&v.game).unwrap();
    assert_eq!((g.owner, g.data, g.lamports), (PROGRAM_ID, er, rent_min(621)));
}

#[test]
fn pu_prefunded_base() {
    for pre in [1u64, rent_min(621) - 1, rent_min(621), 2 * SOL] {
        let mut v = won(1);
        let (u, _) = undeleg_setup(&mut v.p, v.player);
        v.p.fund(v.game, pre);
        let d = v.p.run(&[u]);
        d.assert_ok().assert_cpi_same();
        cu(&format!("process_undelegation (pre-funded {pre})"), &d);
    }
}

#[test]
fn pu_buffer_checks_canonical() {
    let mut v = won(1);
    let (u, er) = undeleg_setup(&mut v.p, v.player);
    // canonical buffer, wrong owner
    let buf = pda::undelegate_buffer(&v.game);
    v.p.set_data(buf, ids::VRF_PROGRAM, er.clone());
    assert_ierr(&v.p.run(&[u.clone()]), InstructionError::InvalidAccountOwner);
    v.p.set_data(buf, ids::DLP, er.clone());
    // canonical buffer, unsigned
    let mut uu = u.clone();
    uu.accounts[1].is_signer = false;
    assert_ierr(&v.p.run(&[uu]), InstructionError::MissingRequiredSignature);
    // unsigned AND wrong owner: signer check first
    v.p.set_data(buf, ids::VRF_PROGRAM, er.clone());
    let mut uu = u.clone();
    uu.accounts[1].is_signer = false;
    assert_ierr(&v.p.run(&[uu]), InstructionError::MissingRequiredSignature);
    v.p.set_data(buf, ids::DLP, er);
    v.p.run(&[u]).assert_ok();
}

/// DIFF: sdk 0.16.2's `InitializeAfterUndelegation` puts `seeds = [b"undelegate-buffer", base], bump,
/// seeds::program = DLP` on `buffer` (an account constraint -> 2006 ConstraintSeeds). The port checks the
/// canonical buffer in the handler and returns ProgramError::InvalidSeeds.
#[test]
fn diff_pu_noncanonical_buffer_code() {
    let mut v = won(1);
    let (u, er) = undeleg_setup(&mut v.p, v.player);
    let fake = key("fake-buffer");
    v.p.set_data(fake, ids::DLP, er);
    v.p.run(&[sub(u, 1, fake)]).assert_err(2006); // port: InvalidSeeds
}

/// DIFF: precedence. Anchor rejects a non-canonical buffer in account validation (2006) before the
/// handler's signer / owner checks and before `payer`'s mut check; the port runs payer-mut, signer and
/// owner first.
#[test]
fn diff_pu_noncanonical_buffer_precedence() {
    let mut v = won(1);
    let (u, er) = undeleg_setup(&mut v.p, v.player);
    let fake = key("fake-buffer");
    v.p.set_data(fake, ids::VRF_PROGRAM, er);
    let mut unsigned = sub(u.clone(), 1, fake);
    unsigned.accounts[1].is_signer = false;
    let d1 = v.p.run(&[unsigned]);                      // anchor 2006, port MissingRequiredSignature
    let d2 = v.p.run(&[sub(u.clone(), 1, fake)]);       // anchor 2006, port InvalidAccountOwner
    let d3 = v.p.run(&[ro(sub(u, 1, fake), 2)]);        // anchor 2006, port 2000 (payer not writable)
    println!("unsigned: {}\nwrong owner: {}\npayer ro: {}", d1.report(), d2.report(), d3.report());
    d1.assert_err(2006);
    d2.assert_err(2006);
    d3.assert_err(2006);
}

/// DIFF: sdk 0.16.2 adds `#[account(address = system_program::ID)]` on `system_program` (2012).
/// The port does not check that slot; its CreateAccount CPI then fails with MissingAccount
/// (system program not in the tx).
#[test]
fn diff_pu_system_program_slot_unchecked() {
    let mut v = won(1);
    let (u, _) = undeleg_setup(&mut v.p, v.player);
    v.p.run(&[sub(u, 3, key("not-system"))]).assert_err(2012); // port: MissingAccount
}

/// DIFF (success vs failure): same as above, but the real system program is also present in the
/// instruction as an extra account. Anchor fails 2012 on the slot; the port ignores the slot and its
/// CPI resolves the system program from the tx, so the undelegation succeeds.
#[test]
fn diff_pu_system_program_slot_unchecked_succeeds() {
    let mut v = won(1);
    let (u, _) = undeleg_setup(&mut v.p, v.player);
    let mut i = sub(u, 3, key("not-system"));
    i.accounts.push(AccountMeta::new_readonly(ids::SYSTEM, false));
    let d = v.p.run(&[i]);
    println!("{}", d.report());
    d.assert_err(2012); // port: ok
}

/// DIFF: same unchecked slot, another executable program passed (Anchor 2012, port MissingAccount).
#[test]
fn diff_pu_system_program_slot_is_another_program() {
    let mut v = won(1);
    let (u, _) = undeleg_setup(&mut v.p, v.player);
    let d = v.p.run(&[sub(u, 3, ids::VRF_PROGRAM)]);
    println!("diff_pu_system_program_slot_is_another_program: {}", d.report());
    d.assert_err(2012);
}

#[test]
fn pu_base_mut_checked_before_buffer() {
    let mut v = won(1);
    let (u, er) = undeleg_setup(&mut v.p, v.player);
    let fake = key("fake-buffer");
    v.p.set_data(fake, ids::DLP, er);
    v.p.run(&[ro(sub(u.clone(), 1, fake), 0)]).assert_err(2000);
    // payer == base (same account in two slots)
    let base = u.accounts[0].pubkey;
    v.p.run(&[sub(u, 2, base)]).assert_failed();
}

#[test]
fn pu_mut_and_short() {
    let mut v = won(1);
    let (u, _) = undeleg_setup(&mut v.p, v.player);
    v.p.run(&[ro(u.clone(), 0)]).assert_err(2000);
    v.p.run(&[ro(u.clone(), 2)]).assert_err(2000);
    v.p.run(&[short(u.clone(), 3)]).assert_failed();
    v.p.run(&[short(u.clone(), 2)]).assert_failed();
    v.p.run(&[with_data(u.clone(), 8)]).assert_err(102);
    v.p.run(&[with_data(u.clone(), 10)]).assert_err(102);
    v.p.run(&[with_data(u.clone(), 40)]).assert_err(102);
    let mut t = u.clone();
    t.data.extend_from_slice(&[1, 2, 3]); // trailing bytes ignored
    v.p.run(&[t]).assert_ok();
}

#[test]
fn pu_bad_seeds() {
    let mut v = won(1);
    let (u, _) = undeleg_setup(&mut v.p, v.player);
    let base = u.accounts[0].pubkey;
    let buf = u.accounts[1].pubkey;
    let payer = u.accounts[2].pubkey;
    let mk = |s: Vec<Vec<u8>>| undeleg_ix(base, buf, payer, s);
    v.p.run(&[mk(game_seeds(&v.session))]).assert_failed(); // seeds derive another PDA
    v.p.run(&[mk(vec![])]).assert_failed();
    v.p.run(&[mk(vec![vec![7u8; 33]])]).assert_failed(); // seed too long: Anchor panics
    v.p.run(&[mk(vec![vec![1u8]; 16])]).assert_failed(); // 16 seeds + bump: too many
    v.p.run(&[mk(vec![vec![1u8]; 17])]).assert_failed();
    v.p.run(&[mk(game_seeds(&v.player))]).assert_ok();
}

#[test]
fn pu_huge_seed_count_short_data() {
    let mut v = won(1);
    let (mut u, _) = undeleg_setup(&mut v.p, v.player);
    u.data[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    v.p.run(&[u]).assert_err(102);
}

#[test]
fn pu_base_exists_or_wrong_payer() {
    let mut v = won(1);
    let (u, er) = undeleg_setup(&mut v.p, v.player);
    v.p.set_program_account(v.game, er); // already re-created
    v.p.run(&[u.clone()]).assert_failed();
    let mut v = won(1);
    let (u, _) = undeleg_setup(&mut v.p, v.player);
    let poor = key("poor-payer");
    v.p.fund(poor, 1_000);
    v.p.run(&[sub(u.clone(), 2, poor)]).assert_failed();
    let mut nsig = u.clone();
    nsig.accounts[2].is_signer = false;
    v.p.run(&[nsig]).assert_failed();
}

// ───────────────────────────── multi-step lifecycles ─────────────────────────────

/// Full delegated lifecycle through the real DLP + VRF program: start, delegate, (request + callback) x n,
/// optional cash out, settle_and_undelegate, process_undelegation, settle_vrf.
fn lifecycle(mines: u8, plan: &[bool], cash: bool, with_ref: bool) -> V {
    let (mut v, referrer) = if with_ref { let (v, r) = started_ref(mines); (v, Some(r)) } else { (started(mines), None) };
    v.p.ok(&[deleg_ix(v.player, Some(v.validator))]).assert_cpi_same();
    let l1 = v.p.get(&v.game).unwrap().data;
    v.p.er_game(v.game, l1);
    for (t, mine) in plan.iter().enumerate() {
        v.p.ok(&[req_ix(v.session, v.game, t as u8)]).assert_cpi_same();
        let g = v.p.get(&v.game).unwrap().data;
        v.p.ok(&[cb_ix(v.game, rand_for(g[77], g[74], *mine))]);
    }
    if cash && status(&v.p, &v.game) == 0 { v.p.ok(&[cash_ix(v.session, v.game)]); }
    v.p.ok(&[sau_ix(v.session, v.game)]).assert_cpi_same();
    let (u, _) = undeleg_setup(&mut v.p, v.player);
    v.p.ok(&[u]).assert_cpi_same();
    let mut s = settle(&v);
    if let Some(r) = referrer { s.accounts.push(AccountMeta::new(pda::referral(&r), false)); }
    let d = v.p.run(&[s]);
    d.assert_ok();
    v
}

#[test]
fn life_win_cashout_loss_fullboard() {
    lifecycle(1, &[false, false, false], true, false);
    lifecycle(2, &[false, true], false, false);
    lifecycle(15, &[false], false, false);
}

#[test]
fn life_referral_accrual_and_claim() {
    let v = lifecycle(1, &[false, false], true, true);
    let mut p = v.p;
    let referrer = key("referrer");
    let r = p.read(&pda::referral(&referrer), accounts::ReferralAccount::decode);
    assert!(r.accrued_lamports > 0);
    let d = p.run(&[ix::ClaimReferral { referral_account: pda::referral(&referrer), referrer }.ix()]);
    d.assert_same();
    println!("claim_referral after VRF accrual: {}", d.report().lines().next().unwrap());
}

#[test]
fn life_two_games_streak_and_refund_after_undelegate() {
    let mut v = won(1);
    v.p.ok(&[settle(&v)]);
    v.p.ok(&[start_ix(v.player, 1, BET, v.session)]);
    reveal(&mut v.p, v.game, 1, false).assert_ok();
    v.p.ok(&[cash_ix(v.player, v.game)]);
    v.p.ok(&[settle(&v)]);
    let s = v.p.read(&v.stats, accounts::PlayerStats::decode);
    assert_eq!((s.games_played, s.games_won, s.current_streak, s.best_streak), (2, 2, 2, 2));
    // third game: delegate, stall, undelegate untouched, refund
    v.p.ok(&[start_ix(v.player, 1, BET, v.session)]);
    v.p.ok(&[deleg_ix(v.player, None)]);
    let l1 = v.p.get(&v.game).unwrap().data;
    v.p.er_game(v.game, l1);
    // INTENDED: F3. Anchor commits the untouched game PLAYING, the port VOID; the house refund pays on both and
    // closes claim + game, so the two sides agree again.
    let d = v.p.run(&[sau_ix(v.player, v.game)]);
    assert!(d.anchor.ok() && d.port.ok(), "{}", d.report());
    let u = undeleg_each_side(&mut v.p, v.player);
    let d = v.p.run(&[u]);
    assert!(d.anchor.ok() && d.port.ok(), "{}", d.report());
    assert_eq!(only_status_differs(&v.p, &v.game), (VRF_PLAYING, VRF_VOID));
    v.p.warp(START_SLOT + 26);
    let d = v.p.run(&[refund_ix(v.w.house, v.player)]);
    assert!(d.anchor.ok() && d.port.ok(), "{}", d.report());
    v.p.ok(&[start_ix(v.player, 1, BET, v.session)]);
}

#[test]
fn life_redelegate_after_undelegate() {
    let mut v = started(1);
    v.p.ok(&[deleg_ix(v.player, None)]);
    let l1 = v.p.get(&v.game).unwrap().data;
    v.p.er_game(v.game, l1);
    v.p.ok(&[req_ix(v.session, v.game, 4)]);
    let g = v.p.get(&v.game).unwrap().data;
    v.p.ok(&[cb_ix(v.game, rand_for(g[77], g[74], false))]);
    // INTENDED: F3. Undelegating a PLAYING game with progress cashes it out on the port (WON, = cash_out_vrf);
    // Anchor commits it PLAYING and lets it be re-delegated. On the port it can only be settled.
    let d = v.p.run(&[sau_ix(v.session, v.game)]);
    assert!(d.anchor.ok() && d.port.ok(), "{}", d.report());
    let u = undeleg_each_side(&mut v.p, v.player);
    let d = v.p.run(&[u]);
    assert!(d.anchor.ok() && d.port.ok(), "{}", d.report());
    assert_eq!(only_status_differs(&v.p, &v.game), (VRF_PLAYING, VRF_WON));
    let d = v.p.run(&[deleg_ix(v.player, None)]);
    // Anchor reaches the DLP CPI (which fails here on the record the harness leaves behind); the port stops first.
    println!("redelegate: {}", d.report().lines().next().unwrap());
    assert!(!d.anchor.cpis.is_empty(), "{}", d.report());
    assert_eq!(d.port.code(), Some(6050), "port: WON game is not delegable");
    let pl = v.p.port.get_account(&v.player).unwrap().lamports;
    let d = v.p.run(&[settle(&v)]);
    assert!(d.port.ok(), "{}", d.report());
    assert!(v.p.port.get_account(&v.player).unwrap().lamports > pl, "port pays the cash-out");
}
