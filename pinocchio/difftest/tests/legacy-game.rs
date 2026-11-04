//! Differential tests, legacy commit-reveal group (spec/legacy-game.md):
//! start_game, reveal_tile, cash_out, settle_game, refund_expired, close_game, close_unsettled_game.
//!
//! Every test runs the same tx on the Anchor reference and on kaboom-p and asserts DIFF POLICY parity.
//! Tests whose name starts with `diff_` are KNOWN DISAGREEMENTS (kept failing on purpose, see the doc
//! comment on each). CU for happy paths is printed as `CU <ix>/<case>: anchor A port P` (--nocapture).
use difftest::*;
use accounts::{GameSession, GameStatus, PlayerStats, ReferralAccount, Vault, VaultV2State};

const SOL: u64 = LAMPORTS_PER_SOL;
const LAYOUT: u16 = 0b0000_0000_0000_0100; // one mine, tile 2
const SALT: [u8; 32] = [7u8; 32];
const BET: u64 = 10_000_000;

// ───────────────────────────── local helpers ─────────────────────────────

/// `assert_failed` + print both errors and any accepted deviation, so a "both failed" pass can be audited.
trait FailedShow { fn failed_show(&self) -> &Self; }
impl FailedShow for Diff {
    fn failed_show(&self) -> &Self {
        self.assert_failed();
        println!("FAILED-BOTH anchor={} port={} accepted={:?}", fmt_err(&self.anchor.err), fmt_err(&self.port.err), self.accepted);
        self
    }
}

fn cu(tag: &str, d: &Diff) {
    let (a, p) = d.cu();
    println!("CU {tag}: anchor {a} port {p}");
}

/// Reference calc_multiplier (lib.rs:1790-1834), for boundary computations only.
fn mult(safe: u8, mines: u8, edge: u16) -> u64 {
    if safe == 0 { return 10_000; }
    let (mut n, mut d) = (1u128, 1u128);
    for i in 0..safe as u128 { n *= 16 - i; d *= 16 - mines as u128 - i; }
    let raw = n * 10_000 / d;
    (raw * (10_000 - edge as u128) / 10_000) as u64
}

fn world() -> (Pair, World) {
    let mut p = Pair::new();
    let w = p.house_world();
    (p, w)
}

/// house world + one legacy game (1 mine on tile 2, 0.01 SOL).
fn started() -> (Pair, World, Address, Address) {
    let (mut p, w) = world();
    let player = p.user("player");
    let game = p.start_game(player, 1, BET, LAYOUT, SALT);
    (p, w, player, game)
}

fn sg(player: Address) -> ix::StartGame {
    ix::StartGame { game: pda::game(&player), player_stats: pda::stats(&player), player, ..Default::default() }
}
fn sg_ix(player: Address, mines: u8, bet: u64, layout: u16) -> Instruction {
    sg(player).ix(mines, bet, commitment(layout, mines, &SALT))
}
fn reveal_ix(w: &World, game: Address, tile: u8, mine: bool) -> Instruction {
    ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(tile, mine)
}
fn cash_ix(game: Address, player: Address) -> Instruction { ix::CashOut { game, player, ..Default::default() }.ix() }
fn refund_ix(game: Address, player: Address) -> Instruction { ix::RefundExpired { game, player, ..Default::default() }.ix() }
fn close_ix(game: Address, player: Address) -> Instruction { ix::CloseGame { game, player }.ix() }
fn cus_ix(game: Address, player: Address) -> Instruction { ix::CloseUnsettledGame { game, player, ..Default::default() }.ix() }
fn settle_ix(w: &World, game: Address, player: Address, layout: u16, salt: [u8; 32]) -> Instruction {
    ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: w.treasury, ..Default::default() }
        .ix(layout, salt)
}

fn game_of(p: &Pair, g: &Address) -> GameSession { p.read(g, GameSession::decode) }
fn vault(p: &Pair) -> Vault { p.read(&ids::VAULT, Vault::decode) }
fn v2(p: &Pair) -> VaultV2State { p.read(&ids::V2_STATE, VaultV2State::decode) }
fn stats_of(p: &Pair, player: &Address) -> PlayerStats { p.read(&pda::stats(player), PlayerStats::decode) }

fn edit_game(p: &mut Pair, g: Address, f: impl FnOnce(&mut GameSession)) {
    let mut s = game_of(p, &g);
    f(&mut s);
    let b = s.encode();
    p.patch(g, |d| *d = b);
}
fn edit_vault(p: &mut Pair, f: impl FnOnce(&mut Vault)) {
    let mut s = vault(p);
    f(&mut s);
    let b = s.encode();
    p.patch(ids::VAULT, |d| *d = b);
}
fn edit_v2(p: &mut Pair, f: impl FnOnce(&mut VaultV2State)) {
    let mut s = v2(p);
    f(&mut s);
    let b = s.encode();
    p.patch(ids::V2_STATE, |d| *d = b);
}
fn edit_stats(p: &mut Pair, player: Address, f: impl FnOnce(&mut PlayerStats)) {
    let mut s = stats_of(p, &player);
    f(&mut s);
    let b = s.encode();
    p.patch(pda::stats(&player), |d| *d = b);
}
fn set_lamports(p: &mut Pair, k: Address, l: u64) {
    let mut a = p.get(&k).unwrap();
    a.lamports = l;
    p.set_account(k, a);
}
fn clone_to(p: &mut Pair, from: Address, to: Address) {
    let a = p.get(&from).unwrap();
    p.set_account(to, a);
}
fn set_owner(p: &mut Pair, k: Address, owner: Address) {
    let mut a = p.get(&k).unwrap();
    a.owner = owner;
    p.set_account(k, a);
}
fn vault_rent() -> u64 { rent_min(Vault::SPACE) }

/// Highest valid non-canonical bump for `seeds` (address, bump).
fn noncanon(seeds: &[&[u8]]) -> (Address, u8) {
    let (_, canon) = pda::find(seeds, &PROGRAM_ID);
    for b in (0..canon).rev() {
        let bb = [b];
        let mut s: Vec<&[u8]> = seeds.to_vec();
        s.push(&bb);
        if let Ok(a) = Address::create_program_address(&s, &PROGRAM_ID) { return (a, b); }
    }
    panic!("no non-canonical bump");
}

/// A fake GameSession for `player` at its canonical PDA (Playing, 1 mine, LAYOUT/SALT commitment).
fn fake_game(p: &mut Pair, player: Address, f: impl FnOnce(&mut GameSession)) -> Address {
    let (game, bump) = pda::find(&[b"kaboom_game", player.as_ref()], &PROGRAM_ID);
    let mut g = GameSession {
        player, bump, status: GameStatus::Playing, bet: BET, mine_count: 1, commitment: commitment(LAYOUT, 1, &SALT),
        revealed_mask: 0, revealed_safe_mask: 0, safe_reveals: 0, multiplier_bps: 10_000, start_slot: p.slot(),
        created_at: START_UNIX, settled: false, mine_layout: 0, salt: [0; 32], version: 1, max_payout: 0, _reserved: [0; 24],
    };
    f(&mut g);
    p.set_program_account(game, g.encode());
    game
}

fn fresh_stats(player: Address) -> PlayerStats {
    PlayerStats {
        player, bump: pda::find(&[b"kaboom_stats", player.as_ref()], &PROGRAM_ID).1, version: 1, games_played: 0,
        games_won: 0, total_wagered: 0, total_payouts: 0, biggest_win: 0, biggest_multiplier_bps: 0, current_streak: 0,
        best_streak: 0, last_played: 0, referrer: None, _reserved: [0; 64],
    }
}

/// house world + set_referrer(player -> referrer) + a started game. Returns (p, w, player, referrer, game).
fn referred_game() -> (Pair, World, Address, Address, Address) {
    let (mut p, w) = world();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
    let game = p.start_game(player, 1, BET, LAYOUT, SALT);
    edit_vault(&mut p, |v| v.treasury_split_bps = 0); // tests that want a split set it again
    (p, w, player, referrer, game)
}

fn with_ref(mut i: Instruction, referrer: &Address) -> Instruction {
    i.accounts.push(AccountMeta::new(pda::referral(referrer), false));
    i
}

// ═════════════════════════════ start_game ═════════════════════════════
// INTENDED: VRF-only. The port's start_game always fails 6057 (LegacyModeDisabled) before touching any
// account; every test here asserts that, keeps the Anchor reference's own result (anchor_ok / anchor_err /
// anchor_failed), and `run_legacy` copies Anchor's post-state onto the port so the following steps stay in sync.

#[test]
fn sg_vrf_only_6057_any_input() {
    // INTENDED: VRF-only. Refused before any account or arg is read: full ix, no accounts, data cut to the disc.
    let (mut p, _w) = world();
    let player = p.user("player");
    let full = sg_ix(player, 1, BET, LAYOUT);
    let mut none = full.clone();
    none.accounts.clear();
    let mut short = full.clone();
    short.data.truncate(8);
    for i in [full, none, short] {
        let d = p.run_legacy(&[i]);
        d.vrf_only();
        assert!(d.port.cu < 1_000, "port CU {}", d.port.cu);
    }
    assert!(p.port.get_account(&pda::game(&player)).is_some(), "mirrored from anchor (full ix started the game there)");
}

#[test]
fn sg_happy_first_game_creates_stats() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let (v0, pl0) = (p.lamports(&ids::VAULT), p.lamports(&player));
    let d = p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]);
    d.anchor_ok();
    cu("start_game/first(new stats)", &d);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: StartGame"]);
    assert_eq!(d.anchor.events.len(), 1);
    let g = game_of(&p, &pda::game(&player));
    assert_eq!((g.status, g.bet, g.mine_count, g.multiplier_bps, g.start_slot, g.version), (GameStatus::Playing, BET, 1, 10_000, START_SLOT, 1));
    assert_eq!(g.max_payout, BET * mult(15, 1, 100) / 10_000);
    assert_eq!(p.lamports(&ids::VAULT), v0 + BET);
    assert_eq!(pl0 - p.lamports(&player), BET + rent_min(180) + rent_min(203));
    let s = stats_of(&p, &player);
    assert_eq!((s.player, s.version, s.games_played), (player, 1, 0));
    assert_eq!(v2(&p).total_outstanding_max_payout, g.max_payout);
}

#[test]
fn sg_happy_second_game_existing_stats() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    p.ok(&[close_ix(game, player)]);
    let d = p.run_legacy(&[sg_ix(player, 3, 2_000_000, 0b111)]);
    d.anchor_ok();
    cu("start_game/second(existing stats)", &d);
    assert_eq!(vault(&p).total_games, 2);
}

#[test]
fn sg_trailing_arg_bytes_ok() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut i = sg_ix(player, 1, BET, LAYOUT);
    i.data.extend_from_slice(&[9; 7]);
    p.run_legacy(&[i]).anchor_ok();
}

#[test]
fn sg_mines_15_ok_and_bet_min_ok() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 15, 1_000_000, 0x7fff)]).anchor_ok();
}

#[test]
fn sg_paused_6012() {
    let (mut p, _w) = world();
    edit_vault(&mut p, |v| v.paused = true);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(6012);
}

#[test]
fn sg_mines_zero_6000() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 0, BET, 0)]).anchor_err(6000);
}

#[test]
fn sg_mines_16_6000() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 16, BET, 0xffff)]).anchor_err(6000);
}

#[test]
fn sg_mines_255_6000() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 255, BET, 0xffff)]).anchor_err(6000);
}

#[test]
fn sg_bet_too_low_6004() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, 999_999, LAYOUT)]).anchor_err(6004);
    p.run_legacy(&[sg_ix(player, 1, 0, LAYOUT)]).anchor_err(6004);
}

#[test]
fn sg_zero_commitment_6011() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run_legacy(&[sg(player).ix(1, BET, [0; 32])]).anchor_err(6011);
}

#[test]
fn sg_error_order_paused_before_mines() {
    let (mut p, _w) = world();
    edit_vault(&mut p, |v| v.paused = true);
    let player = p.user("player");
    p.run_legacy(&[sg(player).ix(0, 0, [0; 32])]).anchor_err(6012);
    edit_vault(&mut p, |v| v.paused = false);
    p.run_legacy(&[sg(player).ix(0, 0, [0; 32])]).anchor_err(6000);
    p.run_legacy(&[sg(player).ix(1, 0, [0; 32])]).anchor_err(6004);
}

#[test]
fn sg_bet_exceeds_max_boundary_6005() {
    let (mut p, _w) = world();
    edit_vault(&mut p, |v| v.max_payout_bps = 10_000);
    let avail = p.lamports(&ids::VAULT) - vault_rent();
    let max_bet = (avail as u128 * 100 / 10_000) as u64;
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, max_bet + 1, LAYOUT)]).anchor_err(6005);
    p.run_legacy(&[sg_ix(player, 1, max_bet, LAYOUT)]).anchor_ok();
}

#[test]
fn sg_bet_u64_max_6005() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, u64::MAX, LAYOUT)]).anchor_err(6005);
}

#[test]
fn sg_vault_insufficient_boundary_6006() {
    let (mut p, _w) = world();
    let avail = p.lamports(&ids::VAULT) - vault_rent();
    let max_payout = (avail as u128 * 1_000 / 10_000) as u64;
    let m = mult(15, 1, 100) as u128;
    // largest bet with worst-case payout <= max_payout
    let mut bet = (max_payout as u128 * 10_000 / m) as u64;
    while ((bet as u128 + 1) * m / 10_000) as u64 <= max_payout { bet += 1; }
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, bet + 1, LAYOUT)]).anchor_err(6006);
    let d = p.run_legacy(&[sg_ix(player, 1, bet, LAYOUT)]);
    d.anchor_ok();
    assert!(game_of(&p, &pda::game(&player)).max_payout <= max_payout);
}

#[test]
fn sg_many_mines_huge_worst_case_6006() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 8, BET, 0x00ff)]).anchor_err(6006);
}

#[test]
fn sg_health_zero_6005() {
    let (mut p, _w) = world();
    let avail = p.lamports(&ids::VAULT) - vault_rent();
    edit_v2(&mut p, |v| v.total_outstanding_max_payout = avail);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(6005);
}

#[test]
fn sg_min_health_breach_6034() {
    let (mut p, _w) = world();
    edit_v2(&mut p, |v| v.min_health_bps = 10_000);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(6034);
}

#[test]
fn sg_min_health_just_ok() {
    let (mut p, _w) = world();
    edit_v2(&mut p, |v| v.min_health_bps = 9_000);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok();
}

#[test]
fn sg_pending_units_overflow_6008() {
    let (mut p, _w) = world();
    edit_v2(&mut p, |v| { v.total_units = 1; v.total_pending_units = u128::MAX / 2; });
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(6008);
}

#[test]
fn sg_outstanding_overflow_after_health() {
    // pre-health > 0 only when outstanding < available, so the step-16 checked_add cannot overflow; check
    // the saturating edge where outstanding is just under available.
    let (mut p, _w) = world();
    let avail = p.lamports(&ids::VAULT) - vault_rent();
    edit_v2(&mut p, |v| v.total_outstanding_max_payout = avail - 1);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(6005);
}

#[test]
fn sg_player_cannot_afford_bet() {
    let (mut p, _w) = world();
    let player = key("poor");
    p.fund(player, rent_min(180) + rent_min(203) + BET - 1);
    p.run_legacy_as(player, &[sg_ix(player, 1, BET, LAYOUT)]).anchor_failed();
}

#[test]
fn sg_player_cannot_afford_rent() {
    let (mut p, _w) = world();
    let player = key("poor2");
    p.fund(player, rent_min(180) - 1);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_failed();
}

#[test]
fn sg_second_game_while_open_fails() {
    let (mut p, _w, player, _game) = started();
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_failed();
}

#[test]
fn sg_prefunded_game_dust() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.fund(pda::game(&player), 1);
    let d = p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]);
    d.anchor_ok();
    cu("start_game/prefunded game", &d);
    assert_eq!(p.lamports(&pda::game(&player)), rent_min(180));
}

#[test]
fn sg_prefunded_game_over_rent() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.fund(pda::game(&player), rent_min(180) + 12_345);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok();
    assert_eq!(p.lamports(&pda::game(&player)), rent_min(180) + 12_345);
}

#[test]
fn sg_prefunded_stats_dust() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.fund(pda::stats(&player), 1);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok();
}

#[test]
fn sg_prefunded_both_dust() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.fund(pda::game(&player), 7);
    p.fund(pda::stats(&player), rent_min(203));
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok();
}

#[test]
fn sg_stats_existing_wrong_owner_3007() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.set_data(pda::stats(&player), key("other-program"), fresh_stats(player).encode());
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3007);
}

#[test]
fn sg_stats_existing_wrong_disc_3002() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = fresh_stats(player).encode();
    b[0] ^= 1;
    p.set_program_account(pda::stats(&player), b);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3002);
}

#[test]
fn sg_stats_existing_short_disc_3001() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.set_program_account(pda::stats(&player), vec![1, 2, 3]);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3001);
}

#[test]
fn sg_stats_existing_bad_option_tag_3003() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = fresh_stats(player).encode();
    b[106] = 2;
    p.set_program_account(pda::stats(&player), b);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3003);
}

#[test]
fn sg_stats_existing_truncated_3003() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = fresh_stats(player).encode();
    b.truncate(150);
    p.set_program_account(pda::stats(&player), b);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3003);
}

#[test]
fn sg_stats_existing_tag1_short_3003() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut s = fresh_stats(player);
    s.referrer = Some(key("r"));
    let mut b = s.encode();
    b.truncate(180);
    p.set_program_account(pda::stats(&player), b);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3003);
}

#[test]
fn sg_stats_existing_wrong_space_2019() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = fresh_stats(player).encode();
    b.resize(210, 0);
    p.set_program_account(pda::stats(&player), b);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(2019);
}

#[test]
fn sg_stats_existing_short_space_2019() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = fresh_stats(player).encode();
    b.truncate(190);
    p.set_program_account(pda::stats(&player), b);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(2019);
}

#[test]
fn sg_stats_existing_below_rent_2005() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.set_program_account(pda::stats(&player), fresh_stats(player).encode());
    set_lamports(&mut p, pda::stats(&player), rent_min(203) - 1);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(2005);
}

#[test]
fn sg_stats_existing_player_default_gets_set() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut s = fresh_stats(Address::new_from_array([0; 32]));
    s.bump = 0;
    s.version = 0;
    s.games_played = 5;
    p.set_program_account(pda::stats(&player), s.encode());
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok();
    let s = stats_of(&p, &player);
    assert_eq!((s.player, s.version, s.games_played), (player, 1, 5));
}

#[test]
fn sg_stats_existing_other_player_kept() {
    // stats.player != default (somebody else's key stored) -> untouched (reinit guard)
    let (mut p, _w) = world();
    let player = p.user("player");
    p.set_program_account(pda::stats(&player), fresh_stats(key("someone")).encode());
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok();
    assert_eq!(stats_of(&p, &player).player, key("someone"));
}

#[test]
fn sg_game_wrong_pda_2006() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.game = key("random-game");
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(2006);
}

#[test]
fn sg_game_of_other_player_2006() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.game = pda::game(&key("other"));
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(2006);
}

#[test]
fn sg_game_noncanonical_2006() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.game = noncanon(&[b"kaboom_game", player.as_ref()]).0;
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(2006);
}

#[test]
fn sg_stats_wrong_pda_2006() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.player_stats = pda::stats(&key("other"));
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(2006);
}

#[test]
fn sg_stats_noncanonical_2006() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.player_stats = noncanon(&[b"kaboom_stats", player.as_ref()]).0;
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(2006);
}

#[test]
fn sg_same_account_game_and_stats_2006() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.game = pda::stats(&player);
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(2006);
}

#[test]
fn sg_vault_in_v2_slot_3002() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.v2_state = ids::VAULT;
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(3002);
}

#[test]
fn sg_v2_in_vault_slot_3002() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.vault = ids::V2_STATE;
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(3002);
}

#[test]
fn sg_vault_wrong_owner_3007() {
    let (mut p, _w) = world();
    set_owner(&mut p, ids::VAULT, key("other-program"));
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3007);
}

#[test]
fn sg_vault_missing_3012() {
    let mut p = Pair::new();
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3012);
}

#[test]
fn sg_v2_missing_3012() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3012);
}

#[test]
fn sg_vault_copy_at_wrong_address_2006() {
    let (mut p, _w) = world();
    let fake = key("fake-vault");
    clone_to(&mut p, ids::VAULT, fake);
    let player = p.user("player");
    let mut b = sg(player);
    b.vault = fake;
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(2006);
}

#[test]
fn sg_vault_bump_corrupt_2006() {
    let (mut p, _w) = world();
    edit_vault(&mut p, |v| v.bump = 253);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(2006);
}

#[test]
fn sg_v2_bump_corrupt_2006() {
    let (mut p, _w) = world();
    edit_v2(&mut p, |v| v.bump = 254);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(2006);
}

/// Vault copy at a valid NON-canonical PDA with its stored bump set to that bump. Anchor's
/// `seeds + bump = vault.bump` (create_program_address) accepts it; the port's D2 const check rejects 2006.
/// Unreachable on chain (only `initialize_vault` can create a program-owned vault, at the canonical PDA).
#[test]
fn diff_sg_vault_noncanonical_stored_bump() {
    let (mut p, _w) = world();
    let (fake, b) = noncanon(&[b"kaboom_vault"]);
    clone_to(&mut p, ids::VAULT, fake);
    let mut v = p.read(&fake, Vault::decode);
    v.bump = b;
    let bytes = v.encode();
    p.patch(fake, |d| *d = bytes);
    let player = p.user("player");
    let mut bld = sg(player);
    bld.vault = fake;
    let d = p.run_legacy(&[bld.ix(1, BET, commitment(LAYOUT, 1, &SALT))]);
    println!("{}", d.report());
    d.vrf_only();
}

#[test]
fn sg_vault_paused_bad_bool_3003() {
    let (mut p, _w) = world();
    p.patch(ids::VAULT, |d| d[137] = 2);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3003);
}

#[test]
fn sg_vault_truncated_3003() {
    let (mut p, _w) = world();
    p.patch(ids::VAULT, |d| d.truncate(427));
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3003);
}

#[test]
fn sg_v2_bad_bool_3003() {
    let (mut p, _w) = world();
    p.patch(ids::V2_STATE, |d| d[127] = 7);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3003);
}

#[test]
fn sg_vault_readonly_2000() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut i = sg_ix(player, 1, BET, LAYOUT);
    i.accounts[0].is_writable = false;
    p.run_legacy(&[i]).anchor_err(2000);
}

#[test]
fn sg_v2_readonly_2000() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut i = sg_ix(player, 1, BET, LAYOUT);
    i.accounts[1].is_writable = false;
    p.run_legacy(&[i]).anchor_err(2000);
}

#[test]
fn sg_game_readonly_fails() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut i = sg_ix(player, 1, BET, LAYOUT);
    i.accounts[2].is_writable = false;
    p.run_legacy(&[i]).anchor_failed();
}

#[test]
fn sg_new_stats_readonly_fails() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut i = sg_ix(player, 1, BET, LAYOUT);
    i.accounts[3].is_writable = false;
    p.run_legacy(&[i]).anchor_failed();
}

#[test]
fn sg_existing_stats_readonly_2000() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.set_program_account(pda::stats(&player), fresh_stats(player).encode());
    let mut i = sg_ix(player, 1, BET, LAYOUT);
    i.accounts[3].is_writable = false;
    p.run_legacy(&[i]).anchor_err(2000);
}

#[test]
fn sg_player_readonly_fails() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut i = sg_ix(player, 1, BET, LAYOUT);
    i.accounts[4].is_writable = false;
    p.run_legacy(&[i]).anchor_failed();
}

#[test]
fn sg_player_not_signer_3010() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut i = sg_ix(player, 1, BET, LAYOUT);
    i.accounts[4].is_signer = false;
    p.run_legacy(&[i]).anchor_err(3010);
}

#[test]
fn sg_system_program_wrong_3008() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.system_program = ids::DLP;
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(3008);
}

#[test]
fn sg_system_program_nonexec_3008() {
    let (mut p, _w) = world();
    let player = p.user("player");
    let mut b = sg(player);
    b.system_program = key("not-a-program");
    p.run_legacy(&[b.ix(1, BET, commitment(LAYOUT, 1, &SALT))]).anchor_err(3008);
}

#[test]
fn sg_short_accounts_3005() {
    for n in 0..6 {
        let (mut p, _w) = world();
        let player = p.user("player");
        let mut i = sg_ix(player, 1, BET, LAYOUT);
        i.accounts.truncate(n);
        p.run_legacy(&[i]).anchor_failed();
    }
}

#[test]
fn sg_short_data_102() {
    let (mut p, _w) = world();
    let player = p.user("player");
    for n in [8usize, 9, 17, 48] {
        let mut i = sg_ix(player, 1, BET, LAYOUT);
        i.data.truncate(n);
        p.run_legacy(&[i]).anchor_err(102);
    }
}

// ═════════════════════════════ reveal_tile ═════════════════════════════

#[test]
fn rt_safe_happy() {
    let (mut p, w, _player, game) = started();
    let d = p.run(&[reveal_ix(&w, game, 5, false)]);
    d.assert_ok();
    cu("reveal_tile/safe", &d);
    assert_eq!(d.anchor.events.len(), 1);
    let g = game_of(&p, &game);
    assert_eq!((g.safe_reveals, g.revealed_mask, g.revealed_safe_mask, g.multiplier_bps), (1, 1 << 5, 1 << 5, mult(1, 1, 100)));
}

#[test]
fn rt_mine_happy() {
    let (mut p, w, _player, game) = started();
    let d = p.run(&[reveal_ix(&w, game, 2, true)]);
    d.assert_ok();
    cu("reveal_tile/mine", &d);
    assert_eq!(d.anchor.events.len(), 2);
    assert_eq!(game_of(&p, &game).status, GameStatus::Lost);
}

#[test]
fn rt_tile_15_and_0_ok() {
    let (mut p, w, _player, game) = started();
    p.run(&[reveal_ix(&w, game, 15, false)]).assert_ok();
    p.run(&[reveal_ix(&w, game, 0, false)]).assert_ok();
}

#[test]
fn rt_tile_16_6001() {
    let (mut p, w, _player, game) = started();
    p.run(&[reveal_ix(&w, game, 16, false)]).assert_err(6001);
    p.run(&[reveal_ix(&w, game, 255, true)]).assert_err(6001);
}

#[test]
fn rt_not_playing_6003() {
    let (mut p, w, _player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.run(&[reveal_ix(&w, game, 3, false)]).assert_err(6003);
}

#[test]
fn rt_error_order_tile_before_status() {
    let (mut p, w, _player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.run(&[reveal_ix(&w, game, 16, false)]).assert_err(6001);
}

#[test]
fn rt_expiry_boundary_6013() {
    let (mut p, w, _player, game) = started();
    p.warp(START_SLOT + 300);
    p.run(&[reveal_ix(&w, game, 3, false)]).assert_ok();
    p.warp(START_SLOT + 301);
    p.run(&[reveal_ix(&w, game, 4, false)]).assert_err(6013);
}

#[test]
fn rt_already_revealed_6002() {
    let (mut p, w, _player, game) = started();
    p.ok(&[reveal_ix(&w, game, 5, false)]);
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(6002);
    p.run(&[reveal_ix(&w, game, 5, true)]).assert_err(6002);
}

#[test]
fn rt_wrong_house_6007() {
    let (mut p, _w, player, game) = started();
    let i = ix::RevealTile { game, house_authority: player, ..Default::default() }.ix(5, false);
    p.run(&[i]).assert_err(6007);
}

#[test]
fn rt_house_not_signer_3010() {
    let (mut p, w, _player, game) = started();
    let mut i = reveal_ix(&w, game, 5, false);
    i.accounts[2].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn rt_game_readonly_2000() {
    let (mut p, w, _player, game) = started();
    let mut i = reveal_ix(&w, game, 5, false);
    i.accounts[1].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn rt_error_order_mut_before_house() {
    let (mut p, _w, player, game) = started();
    let mut i = ix::RevealTile { game, house_authority: player, ..Default::default() }.ix(16, false);
    i.accounts[1].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn rt_vault_writable_ok() {
    let (mut p, w, _player, game) = started();
    let mut i = reveal_ix(&w, game, 5, false);
    i.accounts[0].is_writable = true;
    p.run(&[i]).assert_ok();
}

#[test]
fn rt_bad_bool_102() {
    let (mut p, w, _player, game) = started();
    let mut i = reveal_ix(&w, game, 5, false);
    i.data[9] = 2;
    p.run(&[i]).assert_err(102);
}

#[test]
fn rt_short_data_102() {
    let (mut p, w, _player, game) = started();
    for n in [8usize, 9] {
        let mut i = reveal_ix(&w, game, 5, false);
        i.data.truncate(n);
        p.run(&[i]).assert_err(102);
    }
}

#[test]
fn rt_trailing_data_ok() {
    let (mut p, w, _player, game) = started();
    let mut i = reveal_ix(&w, game, 5, false);
    i.data.push(0xff);
    p.run(&[i]).assert_ok();
}

#[test]
fn rt_short_accounts_3005() {
    for n in 0..3 {
        let (mut p, w, _player, game) = started();
        let mut i = reveal_ix(&w, game, 5, false);
        i.accounts.truncate(n);
        p.run(&[i]).failed_show();
    }
}

#[test]
fn rt_game_copy_wrong_address_2006() {
    let (mut p, w, _player, game) = started();
    let fake = key("fake-game");
    clone_to(&mut p, game, fake);
    p.run(&[reveal_ix(&w, fake, 5, false)]).assert_err(2006);
}

#[test]
fn rt_game_bump_corrupt_2006() {
    let (mut p, w, _player, game) = started();
    edit_game(&mut p, game, |g| g.bump = g.bump.wrapping_sub(1));
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(2006);
}

#[test]
fn rt_game_player_field_swapped_2006() {
    let (mut p, w, _player, game) = started();
    edit_game(&mut p, game, |g| g.player = key("other"));
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(2006);
}

#[test]
fn rt_game_noncanonical_stored_bump_accepted() {
    // seeds + bump = game.bump uses create_program_address: a non-canonical game is accepted by both.
    let (mut p, w, player, game) = started();
    let (nc, b) = noncanon(&[b"kaboom_game", player.as_ref()]);
    clone_to(&mut p, game, nc);
    edit_game(&mut p, nc, |g| g.bump = b);
    p.run(&[reveal_ix(&w, nc, 5, false)]).assert_ok();
}

#[test]
fn rt_game_wrong_owner_3007() {
    let (mut p, w, _player, game) = started();
    set_owner(&mut p, game, key("other-program"));
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(3007);
}

#[test]
fn rt_game_missing_3012() {
    let (mut p, w) = world();
    p.run(&[reveal_ix(&w, pda::game(&key("nobody")), 5, false)]).assert_err(3012);
}

#[test]
fn rt_vault_in_game_slot_3002() {
    let (mut p, w, _player, _game) = started();
    p.run(&[reveal_ix(&w, ids::VAULT, 5, false)]).assert_err(3002);
}

#[test]
fn rt_stats_in_game_slot_3002() {
    let (mut p, w, player, _game) = started();
    p.run(&[reveal_ix(&w, pda::stats(&player), 5, false)]).assert_err(3002);
}

#[test]
fn rt_game_in_vault_slot_3002() {
    let (mut p, w, _player, game) = started();
    let i = ix::RevealTile { vault: game, game, house_authority: w.house }.ix(5, false);
    p.run(&[i]).assert_err(3002);
}

#[test]
fn rt_game_bad_status_3003() {
    let (mut p, w, _player, game) = started();
    p.patch(game, |d| d[41] = 4);
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(3003);
}

#[test]
fn rt_game_bad_settled_bool_3003() {
    let (mut p, w, _player, game) = started();
    p.patch(game, |d| d[112] = 2);
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(3003);
}

#[test]
fn rt_game_truncated_3003() {
    let (mut p, w, _player, game) = started();
    p.patch(game, |d| d.truncate(179));
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(3003);
}

#[test]
fn rt_game_longer_data_ok() {
    let (mut p, w, _player, game) = started();
    p.patch(game, |d| d.resize(200, 0xaa));
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_ok();
}

#[test]
fn diff_rt_vault_noncanonical_stored_bump() {
    // same D2 situation as sg_vault_noncanonical_stored_bump, on reveal_tile (vault read-only)
    let (mut p, w, _player, game) = started();
    let (fake, b) = noncanon(&[b"kaboom_vault"]);
    clone_to(&mut p, ids::VAULT, fake);
    let mut v = p.read(&fake, Vault::decode);
    v.bump = b;
    let bytes = v.encode();
    p.patch(fake, |d| *d = bytes);
    let d = p.run(&[ix::RevealTile { vault: fake, game, house_authority: w.house }.ix(5, false)]);
    println!("{}", d.report());
    d.assert_same();
}

#[test]
fn rt_multiplier_invalid_6000() {
    let (mut p, w, _player, game) = started();
    edit_game(&mut p, game, |g| { g.mine_count = 15; g.safe_reveals = 1; });
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(6000);
}

#[test]
fn rt_mine_count_16_fake_6000() {
    let (mut p, w, _player, game) = started();
    edit_game(&mut p, game, |g| g.mine_count = 16);
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(6000);
}

#[test]
fn rt_mine_count_zero_fake_ok() {
    let (mut p, w, _player, game) = started();
    edit_game(&mut p, game, |g| g.mine_count = 0);
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_ok();
}

#[test]
fn rt_safe_reveals_255_saturates() {
    let (mut p, w, _player, game) = started();
    edit_game(&mut p, game, |g| { g.mine_count = 0; g.safe_reveals = 255; });
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_err(6000);
}

#[test]
fn rt_high_edge_vault_ok() {
    let (mut p, w, _player, game) = started();
    edit_vault(&mut p, |v| v.house_edge_bps = 10_000);
    p.run(&[reveal_ix(&w, game, 5, false)]).assert_ok();
}

#[test]
fn rt_edge_over_bps_panics_or_errs() {
    // edge > 10000 -> Anchor's plain `BPS - edge` panics (accepted deviation if the port errors)
    let (mut p, w, _player, game) = started();
    edit_vault(&mut p, |v| v.house_edge_bps = 10_001);
    p.run(&[reveal_ix(&w, game, 5, false)]).failed_show();
}

#[test]
fn rt_full_board_auto_win_no_pay() {
    let (mut p, w) = world();
    let player = p.user("player");
    let layout = 0x7fff; // 15 mines, tile 15 safe
    let game = p.start_game(player, 15, 1_000_000, layout, SALT);
    let (v0, pl0) = (p.lamports(&ids::VAULT), p.lamports(&player));
    let d = p.run(&[reveal_ix(&w, game, 15, false)]);
    d.assert_ok();
    cu("reveal_tile/full-board", &d);
    assert_eq!(game_of(&p, &game).status, GameStatus::Won);
    p.run(&[cash_ix(game, player)]).assert_err(6003);
    p.run(&[settle_ix(&w, game, player, layout, SALT)]).assert_ok();
    assert_eq!(p.lamports(&player), pl0);
    assert!(p.lamports(&ids::VAULT) <= v0);
    let s = stats_of(&p, &player);
    assert_eq!((s.games_won, s.total_payouts), (1, 1_000_000 * mult(1, 15, 100) / 10_000));
    p.run(&[close_ix(game, player)]).assert_ok();
}

#[test]
fn rt_fourteen_safe_then_last() {
    let (mut p, w, _player, game) = started();
    let tiles: Vec<u8> = (0..16).filter(|t| *t != 2).collect();
    for (i, t) in tiles.iter().enumerate() {
        let d = p.run(&[reveal_ix(&w, game, *t, false)]);
        d.assert_ok();
        if i == 14 { cu("reveal_tile/15th safe (max multiplier)", &d); }
    }
    let g = game_of(&p, &game);
    assert_eq!((g.status, g.safe_reveals, g.multiplier_bps), (GameStatus::Won, 15, mult(15, 1, 100)));
}

// ═════════════════════════════ cash_out ═════════════════════════════

fn revealed() -> (Pair, World, Address, Address) {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 5, false)]);
    (p, w, player, game)
}

#[test]
fn co_happy() {
    let (mut p, _w, player, game) = revealed();
    let (v0, pl0) = (p.lamports(&ids::VAULT), p.lamports(&player));
    let o0 = v2(&p).total_outstanding_max_payout;
    let d = p.run(&[cash_ix(game, player)]);
    d.assert_ok();
    cu("cash_out", &d);
    let payout = BET * mult(1, 1, 100) / 10_000;
    assert_eq!(p.lamports(&player), pl0 + payout);
    assert_eq!(p.lamports(&ids::VAULT), v0 - payout);
    assert_eq!(vault(&p).total_payouts, payout);
    assert_eq!(v2(&p).total_outstanding_max_payout, o0);
    assert_eq!(game_of(&p, &game).status, GameStatus::Won);
}

#[test]
fn co_trailing_data_ok() {
    let (mut p, _w, player, game) = revealed();
    let mut i = cash_ix(game, player);
    i.data.extend_from_slice(&[1, 2, 3]);
    p.run(&[i]).assert_ok();
}

#[test]
fn co_no_tiles_6019() {
    let (mut p, _w, player, game) = started();
    p.run(&[cash_ix(game, player)]).assert_err(6019);
}

#[test]
fn co_lost_6003() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.run(&[cash_ix(game, player)]).assert_err(6003);
}

#[test]
fn co_twice_6003() {
    let (mut p, _w, player, game) = revealed();
    p.ok(&[cash_ix(game, player)]);
    p.run(&[cash_ix(game, player)]).assert_err(6003);
}

#[test]
fn co_expired_status_6003() {
    let (mut p, _w, player, game) = revealed();
    p.warp(START_SLOT + 301);
    p.ok(&[refund_ix(game, player)]);
    p.run(&[cash_ix(game, player)]).assert_err(6003);
}

#[test]
fn co_after_expiry_still_ok() {
    let (mut p, _w, player, game) = revealed();
    p.warp(START_SLOT + 10_000);
    let d = p.run(&[cash_ix(game, player)]);
    d.assert_ok();
}

#[test]
fn co_vault_insufficient_6006() {
    let (mut p, _w, player, game) = revealed();
    let payout = BET * mult(1, 1, 100) / 10_000;
    set_lamports(&mut p, ids::VAULT, vault_rent() + payout - 1);
    p.run(&[cash_ix(game, player)]).assert_err(6006);
}

#[test]
fn co_payout_equals_available_ok() {
    let (mut p, _w, player, game) = revealed();
    let payout = BET * mult(1, 1, 100) / 10_000;
    set_lamports(&mut p, ids::VAULT, vault_rent() + payout);
    p.run(&[cash_ix(game, player)]).assert_ok();
    assert_eq!(p.lamports(&ids::VAULT), vault_rent());
}

#[test]
fn co_vault_below_rent_6006() {
    let (mut p, _w, player, game) = revealed();
    set_lamports(&mut p, ids::VAULT, vault_rent() - 1);
    p.run(&[cash_ix(game, player)]).assert_err(6006);
}

#[test]
fn co_payout_overflow_6008() {
    let (mut p, _w, player, game) = revealed();
    edit_game(&mut p, game, |g| { g.bet = u64::MAX; g.multiplier_bps = 20_000; });
    p.run(&[cash_ix(game, player)]).assert_err(6008);
}

#[test]
fn co_payout_max_no_overflow_6006() {
    let (mut p, _w, player, game) = revealed();
    edit_game(&mut p, game, |g| { g.bet = u64::MAX; g.multiplier_bps = 10_000; });
    p.run(&[cash_ix(game, player)]).assert_err(6006);
}

#[test]
fn co_zero_multiplier_ok() {
    let (mut p, _w, player, game) = revealed();
    edit_game(&mut p, game, |g| g.multiplier_bps = 0);
    p.run(&[cash_ix(game, player)]).assert_ok();
}

#[test]
fn co_wrong_player_6007() {
    let (mut p, _w, _player, game) = revealed();
    let thief = p.user("thief");
    p.run(&[cash_ix(game, thief)]).assert_err(6007);
}

#[test]
fn co_other_players_game_with_own_key_6007() {
    let (mut p, w, _player, game) = revealed();
    let other = p.user("other");
    let og = p.start_game(other, 1, BET, LAYOUT, SALT);
    p.ok(&[reveal_ix(&w, og, 5, false)]);
    p.run(&[cash_ix(game, other)]).assert_err(6007);
}

#[test]
fn co_player_not_signer_3010() {
    let (mut p, _w, player, game) = revealed();
    let mut i = cash_ix(game, player);
    i.accounts[3].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn co_player_readonly_2000() {
    let (mut p, _w, player, game) = revealed();
    let mut i = cash_ix(game, player);
    i.accounts[3].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn co_game_readonly_2000() {
    let (mut p, _w, player, game) = revealed();
    let mut i = cash_ix(game, player);
    i.accounts[2].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn co_vault_readonly_2000() {
    let (mut p, _w, player, game) = revealed();
    let mut i = cash_ix(game, player);
    i.accounts[0].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn co_v2_readonly_2000() {
    let (mut p, _w, player, game) = revealed();
    let mut i = cash_ix(game, player);
    i.accounts[1].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn co_vault_in_v2_slot_3002() {
    let (mut p, _w, player, game) = revealed();
    let i = ix::CashOut { v2_state: ids::VAULT, game, player, ..Default::default() }.ix();
    p.run(&[i]).assert_err(3002);
}

#[test]
fn co_game_in_vault_slot_3002() {
    let (mut p, _w, player, game) = revealed();
    let i = ix::CashOut { vault: game, game, player, ..Default::default() }.ix();
    p.run(&[i]).assert_err(3002);
}

#[test]
fn co_game_copy_wrong_address_2006() {
    let (mut p, _w, player, game) = revealed();
    let fake = key("fake-game");
    clone_to(&mut p, game, fake);
    p.run(&[cash_ix(fake, player)]).assert_err(2006);
}

#[test]
fn co_game_wrong_owner_3007() {
    let (mut p, _w, player, game) = revealed();
    set_owner(&mut p, game, ids::DLP);
    p.run(&[cash_ix(game, player)]).assert_err(3007);
}

#[test]
fn co_short_accounts_3005() {
    for n in 0..4 {
        let (mut p, _w, player, game) = revealed();
        let mut i = cash_ix(game, player);
        i.accounts.truncate(n);
        p.run(&[i]).failed_show();
    }
}

#[test]
fn co_vault_is_player_same_account() {
    // player slot == vault (fake game whose player is the vault PDA; sigverify off): net-zero lamports.
    let (mut p, _w) = world();
    let game = fake_game(&mut p, ids::VAULT, |g| { g.safe_reveals = 1; g.multiplier_bps = 20_000; g.revealed_mask = 1 << 5; g.revealed_safe_mask = 1 << 5; });
    let mut i = cash_ix(game, ids::VAULT);
    i.accounts[3].is_signer = true;
    p.run(&[i]).assert_ok();
    assert_eq!(vault(&p).total_payouts, BET * 2);
}

// ═════════════════════════════ settle_game ═════════════════════════════

#[test]
fn st_cashout_win_happy() {
    let (mut p, w, player, game) = revealed();
    edit_vault(&mut p, |v| v.treasury_split_bps = 0);
    p.ok(&[cash_ix(game, player)]);
    let (v0, t0) = (p.lamports(&ids::VAULT), p.lamports(&w.treasury));
    let d = p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    d.assert_ok();
    cu("settle_game/win (cash-out), no referral, split 0", &d);
    assert_eq!(d.anchor.events.len(), 3);
    assert_eq!(p.lamports(&ids::VAULT), v0);
    assert_eq!(p.lamports(&w.treasury), t0);
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
    let s = stats_of(&p, &player);
    let payout = BET * mult(1, 1, 100) / 10_000;
    assert_eq!((s.games_played, s.games_won, s.total_payouts, s.current_streak, s.best_streak), (1, 1, payout, 1, 1));
    assert_eq!(s.biggest_win, payout - BET);
    assert_eq!(s.last_played, START_UNIX);
    let g = game_of(&p, &game);
    assert_eq!((g.settled, g.mine_layout, g.salt), (true, LAYOUT, SALT));
}

#[test]
fn st_loss_happy() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let d = p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    d.assert_ok();
    cu("settle_game/loss, no referral, default split", &d);
    let s = stats_of(&p, &player);
    assert_eq!((s.games_played, s.games_won, s.current_streak), (1, 0, 0));
}

#[test]
fn st_treasury_split_happy() {
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| v.treasury_split_bps = 5_000);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let t0 = p.lamports(&w.treasury);
    let d = p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    d.assert_ok();
    cu("settle_game/loss, split 5000", &d);
    assert_eq!(d.anchor.events.len(), 4);
    assert_eq!(p.lamports(&w.treasury), t0 + BET * 100 / 10_000 * 5_000 / 10_000);
}

#[test]
fn st_treasury_split_full_10000() {
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| v.treasury_split_bps = 10_000);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_ok();
}

#[test]
fn st_treasury_split_tiny_cut_zero() {
    // bet 1_000_000, edge 1 bps, split 1 bps -> cut rounds to 0 -> no TreasuryAccrued
    let (mut p, w) = world();
    edit_vault(&mut p, |v| { v.house_edge_bps = 1; v.treasury_split_bps = 1; });
    let player = p.user("player");
    let game = p.start_game(player, 1, 1_000_000, LAYOUT, SALT);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let d = p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    d.assert_ok();
    assert_eq!(d.anchor.events.len(), 3);
}

#[test]
fn st_treasury_liquidity_capped_by_pending() {
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| v.treasury_split_bps = 5_000);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    // pending value ~= all assets -> liquidity 0 -> no treasury move
    edit_v2(&mut p, |v| { v.total_units = 1_000; v.total_pending_units = 1_000; });
    let t0 = p.lamports(&w.treasury);
    let d = p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    d.assert_ok();
    assert_eq!(p.lamports(&w.treasury), t0);
}

#[test]
fn st_treasury_liquidity_partial() {
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| v.treasury_split_bps = 5_000);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let assets = p.lamports(&ids::VAULT) - vault_rent();
    edit_v2(&mut p, |v| v.total_outstanding_max_payout = v.total_outstanding_max_payout + assets - 20_000);
    // after release, outstanding = assets - 20_000 -> liquidity 20_000 < cut 50_000
    let t0 = p.lamports(&w.treasury);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_ok();
    assert_eq!(p.lamports(&w.treasury), t0 + 20_000);
}

#[test]
fn st_treasury_pending_overflow_6008() {
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| v.treasury_split_bps = 5_000);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    edit_v2(&mut p, |v| { v.total_units = 1; v.total_pending_units = u128::MAX / 2; });
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6008);
}

#[test]
fn st_health_pending_overflow_no_split_6008() {
    // split 0 -> the treasury branch is skipped, but VaultUnitValueUpdated's calc_health_bps still overflows
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    edit_v2(&mut p, |v| { v.total_units = 1; v.total_pending_units = u128::MAX / 2; });
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6008);
}

#[test]
fn st_treasury_fresh_account_rent_fail() {
    let (mut p, w, player, game) = started();
    let fresh = key("fresh-treasury");
    edit_vault(&mut p, |v| { v.treasury_split_bps = 5_000; v.treasury = fresh; });
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let i = ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: fresh, ..Default::default() }.ix(LAYOUT, SALT);
    p.run(&[i]).failed_show();
}

#[test]
fn st_treasury_is_vault_same_account() {
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| { v.treasury_split_bps = 5_000; v.treasury = ids::VAULT; });
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let v0 = p.lamports(&ids::VAULT);
    let i = ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: ids::VAULT, ..Default::default() }.ix(LAYOUT, SALT);
    let d = p.run(&[i]);
    d.assert_ok();
    assert_eq!(p.lamports(&ids::VAULT), v0);
}

#[test]
fn st_house_is_treasury_same_account() {
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| { v.treasury_split_bps = 5_000; v.house_authority = w.treasury; });
    let i = ix::RevealTile { game, house_authority: w.treasury, ..Default::default() }.ix(2, true);
    p.ok(&[i]);
    let i = ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.treasury, treasury: w.treasury, ..Default::default() }.ix(LAYOUT, SALT);
    p.run(&[i]).assert_ok();
}

#[test]
fn st_playing_6003() {
    let (mut p, w, player, game) = revealed();
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6003);
}

#[test]
fn st_expired_6003() {
    let (mut p, w, player, game) = started();
    p.warp(START_SLOT + 301);
    p.ok(&[refund_ix(game, player)]);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6003);
}

#[test]
fn st_already_settled_6017() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6017);
}

#[test]
fn st_bad_salt_6015() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.run(&[settle_ix(&w, game, player, LAYOUT, [8; 32])]).assert_err(6015);
}

#[test]
fn st_bad_layout_6015() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.run(&[settle_ix(&w, game, player, 0b1000, SALT)]).assert_err(6015);
}

#[test]
fn st_popcount_mismatch_6015() {
    // commitment is built over a 2-bit layout with mine_count 1: hash matches, popcount does not
    let (mut p, w) = world();
    let player = p.user("player");
    let layout = 0b1100u16;
    let game = pda::game(&player);
    p.run_legacy(&[sg(player).ix(1, BET, commitment(layout, 1, &SALT))]).anchor_ok(); // INTENDED: VRF-only
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.run(&[settle_ix(&w, game, player, layout, SALT)]).assert_err(6015);
}

#[test]
fn st_safe_reveal_on_mine_6016() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, false)]); // house lied: tile 2 is a mine
    p.ok(&[cash_ix(game, player)]);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6016);
}

#[test]
fn st_revealed_mine_not_in_layout_6016() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 9, true)]); // house lied: tile 9 is safe
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6016);
}

#[test]
fn st_lost_without_mine_6016() {
    let (mut p, w, player, game) = started();
    edit_game(&mut p, game, |g| g.status = GameStatus::Lost);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6016);
}

#[test]
fn st_won_overflow_6008() {
    let (mut p, w, player, game) = revealed();
    p.ok(&[cash_ix(game, player)]);
    edit_game(&mut p, game, |g| { g.bet = u64::MAX; g.multiplier_bps = 20_000; });
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(6008);
}

#[test]
fn st_outstanding_saturates() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    edit_v2(&mut p, |v| v.total_outstanding_max_payout = 1);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_ok();
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
}

#[test]
fn st_stats_saturating_counters() {
    let (mut p, w, player, game) = revealed();
    p.ok(&[cash_ix(game, player)]);
    edit_stats(&mut p, player, |s| {
        s.games_played = u64::MAX; s.games_won = u64::MAX; s.total_wagered = u64::MAX - 1; s.total_payouts = u64::MAX;
        s.current_streak = u32::MAX; s.best_streak = 3; s.biggest_win = 1; s.biggest_multiplier_bps = u64::MAX;
    });
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_ok();
    let s = stats_of(&p, &player);
    assert_eq!((s.games_played, s.best_streak, s.current_streak), (u64::MAX, u32::MAX, u32::MAX));
}

#[test]
fn st_stats_player_default_branch() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    edit_stats(&mut p, player, |s| { s.player = Address::new_from_array([0; 32]); s.bump = 0; s.version = 0; });
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_ok();
    let s = stats_of(&p, &player);
    assert_eq!((s.player, s.version), (player, 1));
}

#[test]
fn st_stats_longer_data_ok() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::stats(&player), |d| d.resize(240, 0x55));
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_ok();
}

#[test]
fn st_stats_short_none_ok() {
    // 171 bytes is the shortest Borsh-valid PlayerStats with referrer None
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::stats(&player), |d| d.truncate(171));
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_ok();
}

#[test]
fn st_stats_too_short_3003() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::stats(&player), |d| d.truncate(170));
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(3003);
}

#[test]
fn st_stats_bad_tag_3003() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::stats(&player), |d| d[106] = 3);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(3003);
}

#[test]
fn st_wrong_house_6007() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let i = ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: player, treasury: w.treasury, ..Default::default() }.ix(LAYOUT, SALT);
    p.run(&[i]).assert_err(6007);
}

#[test]
fn st_wrong_treasury_6007() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let i = ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: player, ..Default::default() }.ix(LAYOUT, SALT);
    p.run(&[i]).assert_err(6007);
}

#[test]
fn st_treasury_readonly_2000() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let mut i = settle_ix(&w, game, player, LAYOUT, SALT);
    i.accounts[5].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn st_treasury_readonly_and_wrong_2000() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let mut i = ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: player, ..Default::default() }.ix(LAYOUT, SALT);
    i.accounts[5].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn st_house_not_signer_3010() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let mut i = settle_ix(&w, game, player, LAYOUT, SALT);
    i.accounts[4].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn st_readonly_slots_2000() {
    for slot in [0usize, 1, 2, 3] {
        let (mut p, w, player, game) = started();
        p.ok(&[reveal_ix(&w, game, 2, true)]);
        let mut i = settle_ix(&w, game, player, LAYOUT, SALT);
        i.accounts[slot].is_writable = false;
        p.run(&[i]).assert_err(2000);
    }
}

#[test]
fn st_stats_of_other_player_2006() {
    let (mut p, w, _player, game) = started();
    let other = p.user("other");
    let _og = p.start_game(other, 1, BET, LAYOUT, SALT);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let i = ix::SettleGame { game, player_stats: pda::stats(&other), house_authority: w.house, treasury: w.treasury, ..Default::default() }.ix(LAYOUT, SALT);
    p.run(&[i]).assert_err(2006);
}

#[test]
fn st_stats_noncanonical_2006() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let (nc, _) = noncanon(&[b"kaboom_stats", player.as_ref()]);
    clone_to(&mut p, pda::stats(&player), nc);
    let i = ix::SettleGame { game, player_stats: nc, house_authority: w.house, treasury: w.treasury, ..Default::default() }.ix(LAYOUT, SALT);
    p.run(&[i]).assert_err(2006);
}

#[test]
fn st_stats_missing_3012() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.set_account(pda::stats(&player), Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(3012);
}

#[test]
fn st_stats_wrong_disc_3002() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::stats(&player), |d| d[7] ^= 0xff);
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]).assert_err(3002);
}

#[test]
fn st_game_in_stats_slot_3002() {
    let (mut p, w, _player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let i = ix::SettleGame { game, player_stats: game, house_authority: w.house, treasury: w.treasury, ..Default::default() }.ix(LAYOUT, SALT);
    p.run(&[i]).assert_err(3002);
}

#[test]
fn st_game_copy_wrong_address_2006() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let fake = key("fake-game");
    clone_to(&mut p, game, fake);
    p.run(&[settle_ix(&w, fake, player, LAYOUT, SALT)]).assert_err(2006);
}

#[test]
fn st_short_data_102() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    for n in [8usize, 9, 10, 41] {
        let mut i = settle_ix(&w, game, player, LAYOUT, SALT);
        i.data.truncate(n);
        p.run(&[i]).assert_err(102);
    }
}

#[test]
fn st_short_accounts_3005() {
    for n in 0..6 {
        let (mut p, w, player, game) = started();
        p.ok(&[reveal_ix(&w, game, 2, true)]);
        let mut i = settle_ix(&w, game, player, LAYOUT, SALT);
        i.accounts.truncate(n);
        p.run(&[i]).failed_show();
    }
}

// ---- settle_game: referral branch ----

#[test]
fn st_referral_happy_win() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 5, false)]);
    p.ok(&[cash_ix(game, player)]);
    let r0 = p.lamports(&pda::referral(&referrer));
    let d = p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]);
    d.assert_ok();
    cu("settle_game/win + referral", &d);
    assert_eq!(d.anchor.events.len(), 4);
    let cut = BET * 50 / 10_000;
    assert_eq!(p.lamports(&pda::referral(&referrer)), r0 + cut);
    let r = p.read(&pda::referral(&referrer), ReferralAccount::decode);
    assert_eq!((r.accrued_lamports, r.total_earned, r.referred_volume, r.tier), (cut, cut, BET, 0));
}

#[test]
fn st_referral_and_split_loss() {
    let (mut p, w, player, referrer, game) = referred_game();
    edit_vault(&mut p, |v| v.treasury_split_bps = 5_000);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let d = p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]);
    d.assert_ok();
    cu("settle_game/loss + referral + split", &d);
    assert_eq!(d.anchor.events.len(), 5);
}

#[test]
fn st_referral_no_remaining_skipped() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let d = p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    d.assert_ok();
    assert_eq!(d.anchor.events.len(), 3);
    assert_eq!(p.read(&pda::referral(&referrer), ReferralAccount::decode).referred_volume, 0);
}

#[test]
fn st_referrer_none_remaining_ignored() {
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| v.treasury_split_bps = 0);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let d = p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &key("random"))]);
    d.assert_ok();
    assert_eq!(d.anchor.events.len(), 3);
}

#[test]
fn st_referral_extra_remaining_ignored() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let mut i = with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer);
    i.accounts.push(AccountMeta::new(key("junk"), false));
    i.accounts.push(AccountMeta::new_readonly(ids::VAULT, false));
    p.run(&[i]).assert_ok();
}

#[test]
fn st_referral_wrong_key_6022() {
    let (mut p, w, player, _referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let i = with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &key("not-the-referrer"));
    p.run(&[i]).assert_err(6022);
}

#[test]
fn st_referral_vault_in_remaining_6022() {
    let (mut p, w, player, _referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let mut i = settle_ix(&w, game, player, LAYOUT, SALT);
    i.accounts.push(AccountMeta::new(ids::VAULT, false));
    p.run(&[i]).assert_err(6022);
}

#[test]
fn st_referral_uninitialized_3012() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.set_account(pda::referral(&referrer), Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]).assert_err(3012);
}

#[test]
fn st_referral_wrong_owner_3007() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    set_owner(&mut p, pda::referral(&referrer), key("other-program"));
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]).assert_err(3007);
}

#[test]
fn st_referral_wrong_disc_3002() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::referral(&referrer), |d| d[0] ^= 1);
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]).assert_err(3002);
}

#[test]
fn st_referral_truncated_3003() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::referral(&referrer), |d| d.truncate(100));
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]).assert_err(3003);
}

#[test]
fn st_referral_short_disc_3001() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::referral(&referrer), |d| d.truncate(4));
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]).assert_err(3001);
}

#[test]
fn st_referral_referrer_field_mismatch_6022() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::referral(&referrer), |d| d[8] ^= 1);
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]).assert_err(6022);
}

#[test]
fn st_referral_readonly_fails() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let mut i = settle_ix(&w, game, player, LAYOUT, SALT);
    i.accounts.push(AccountMeta::new_readonly(pda::referral(&referrer), false));
    p.run(&[i]).failed_show();
}

#[test]
fn st_referral_readonly_zero_cut_fails() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    set_lamports(&mut p, ids::VAULT, vault_rent());
    let mut i = settle_ix(&w, game, player, LAYOUT, SALT);
    i.accounts.push(AccountMeta::new_readonly(pda::referral(&referrer), false));
    p.run(&[i]).failed_show();
}

#[test]
fn st_referral_tiers() {
    for (tier, bps) in [(1u8, 60u64), (2, 70), (5, 70), (255, 70)] {
        let (mut p, w, player, referrer, game) = referred_game();
        p.ok(&[reveal_ix(&w, game, 2, true)]);
        p.patch(pda::referral(&referrer), |d| d[42] = tier);
        let r0 = p.lamports(&pda::referral(&referrer));
        let d = p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]);
        d.assert_ok();
        assert_eq!(p.lamports(&pda::referral(&referrer)), r0 + BET * bps / 10_000, "tier {tier}");
        // volume < 10 SOL -> tier recomputed to 0 -> ReferralTierChanged emitted
        assert_eq!(p.read(&pda::referral(&referrer), ReferralAccount::decode).tier, 0);
        assert_eq!(d.anchor.events.len(), 5);
    }
}

#[test]
fn st_referral_tier_upgrade_silver_gold() {
    for (vol, want) in [(10_000_000_000u64 - BET, 1u8), (100_000_000_000 - BET, 2), (u64::MAX, 2)] {
        let (mut p, w, player, referrer, game) = referred_game();
        p.ok(&[reveal_ix(&w, game, 2, true)]);
        p.patch(pda::referral(&referrer), |d| d[63..71].copy_from_slice(&vol.to_le_bytes()));
        let d = p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]);
        d.assert_ok();
        assert_eq!(p.read(&pda::referral(&referrer), ReferralAccount::decode).tier, want);
    }
}

#[test]
fn st_referral_vault_empty_zero_cut_event() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    set_lamports(&mut p, ids::VAULT, vault_rent());
    let r0 = p.lamports(&pda::referral(&referrer));
    let d = p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]);
    d.assert_ok();
    assert_eq!(p.lamports(&pda::referral(&referrer)), r0);
    assert_eq!(d.anchor.events.len(), 4);
}

#[test]
fn st_referral_vault_partial_cut() {
    let (mut p, w, player, referrer, game) = referred_game();
    edit_vault(&mut p, |v| v.treasury_split_bps = 5_000);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    set_lamports(&mut p, ids::VAULT, vault_rent() + 1_234);
    let r0 = p.lamports(&pda::referral(&referrer));
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]).assert_ok();
    assert_eq!(p.lamports(&pda::referral(&referrer)), r0 + 1_234);
    assert_eq!(p.lamports(&ids::VAULT), vault_rent());
}

#[test]
fn st_referral_saturating_counters() {
    let (mut p, w, player, referrer, game) = referred_game();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.patch(pda::referral(&referrer), |d| {
        d[43..51].copy_from_slice(&u64::MAX.to_le_bytes());
        d[51..59].copy_from_slice(&(u64::MAX - 1).to_le_bytes());
    });
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &referrer)]).assert_ok();
}

#[test]
fn st_referral_is_treasury_same_account() {
    let (mut p, w, player, referrer, game) = referred_game();
    let ra = pda::referral(&referrer);
    edit_vault(&mut p, |v| { v.treasury_split_bps = 5_000; v.treasury = ra; });
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let mut i = ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: ra, ..Default::default() }.ix(LAYOUT, SALT);
    i.accounts.push(AccountMeta::new(ra, false));
    p.run(&[i]).assert_ok();
}

#[test]
fn st_referral_fake_ref_in_stats_without_account() {
    // stats.referrer = Some(x) (no ReferralAccount exists), remaining = PDA(x) -> 3012
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let x = key("ghost");
    edit_stats(&mut p, player, |s| s.referrer = Some(x));
    p.run(&[with_ref(settle_ix(&w, game, player, LAYOUT, SALT), &x)]).assert_err(3012);
}

// ═════════════════════════════ refund_expired ═════════════════════════════

#[test]
fn rf_happy() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    let (v0, pl0) = (p.lamports(&ids::VAULT), p.lamports(&player));
    let d = p.run(&[refund_ix(game, player)]);
    d.assert_ok();
    cu("refund_expired", &d);
    assert_eq!(p.lamports(&player), pl0 + BET);
    assert_eq!(p.lamports(&ids::VAULT), v0 - BET);
    let g = game_of(&p, &game);
    assert_eq!((g.status, g.settled), (GameStatus::Expired, false));
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
    assert_eq!(vault(&p).total_payouts, 0);
}

#[test]
fn rf_boundary_300_6014() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 300);
    p.run(&[refund_ix(game, player)]).assert_err(6014);
    p.warp(START_SLOT + 301);
    p.run(&[refund_ix(game, player)]).assert_ok();
}

#[test]
fn rf_not_playing_6003() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.warp(START_SLOT + 301);
    p.run(&[refund_ix(game, player)]).assert_err(6003);
}

#[test]
fn rf_twice_6003() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    p.ok(&[refund_ix(game, player)]);
    p.run(&[refund_ix(game, player)]).assert_err(6003);
}

#[test]
fn rf_partial_refund() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    set_lamports(&mut p, ids::VAULT, vault_rent() + BET / 3);
    let pl0 = p.lamports(&player);
    p.run(&[refund_ix(game, player)]).assert_ok();
    assert_eq!(p.lamports(&player), pl0 + BET / 3);
}

#[test]
fn rf_zero_refund() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    set_lamports(&mut p, ids::VAULT, vault_rent());
    let d = p.run(&[refund_ix(game, player)]);
    d.assert_ok();
    assert_eq!(game_of(&p, &game).status, GameStatus::Expired);
}

#[test]
fn rf_vault_below_rent_zero_refund() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    set_lamports(&mut p, ids::VAULT, vault_rent() - 100);
    p.run(&[refund_ix(game, player)]).assert_ok();
}

#[test]
fn rf_start_slot_max_saturates_6014() {
    let (mut p, _w, player, game) = started();
    edit_game(&mut p, game, |g| g.start_slot = u64::MAX);
    p.warp(START_SLOT + 1_000);
    p.run(&[refund_ix(game, player)]).assert_err(6014);
}

#[test]
fn rf_outstanding_saturates() {
    let (mut p, _w, player, game) = started();
    edit_v2(&mut p, |v| v.total_outstanding_max_payout = 3);
    p.warp(START_SLOT + 301);
    p.run(&[refund_ix(game, player)]).assert_ok();
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
}

#[test]
fn rf_wrong_player_6007() {
    let (mut p, _w, _player, game) = started();
    p.warp(START_SLOT + 301);
    let thief = p.user("thief");
    p.run(&[refund_ix(game, thief)]).assert_err(6007);
}

#[test]
fn rf_player_not_signer_3010() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    let mut i = refund_ix(game, player);
    i.accounts[3].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn rf_readonly_slots_2000() {
    for slot in 0..4 {
        let (mut p, _w, player, game) = started();
        p.warp(START_SLOT + 301);
        let mut i = refund_ix(game, player);
        i.accounts[slot].is_writable = false;
        p.run(&[i]).assert_err(2000);
    }
}

#[test]
fn rf_vault_in_v2_slot_3002() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    p.run(&[ix::RefundExpired { v2_state: ids::VAULT, game, player, ..Default::default() }.ix()]).assert_err(3002);
}

#[test]
fn rf_game_copy_wrong_address_2006() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    let fake = key("fake-game");
    clone_to(&mut p, game, fake);
    p.run(&[refund_ix(fake, player)]).assert_err(2006);
}

#[test]
fn rf_v2_copy_wrong_address_2006() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    let fake = key("fake-v2");
    clone_to(&mut p, ids::V2_STATE, fake);
    p.run(&[ix::RefundExpired { v2_state: fake, game, player, ..Default::default() }.ix()]).assert_err(2006);
}

#[test]
fn rf_short_accounts_3005() {
    for n in 0..4 {
        let (mut p, _w, player, game) = started();
        p.warp(START_SLOT + 301);
        let mut i = refund_ix(game, player);
        i.accounts.truncate(n);
        p.run(&[i]).failed_show();
    }
}

#[test]
fn rf_vault_is_player_same_account() {
    let (mut p, _w) = world();
    let game = fake_game(&mut p, ids::VAULT, |g| g.max_payout = 77);
    p.warp(START_SLOT + 301);
    let mut i = refund_ix(game, ids::VAULT);
    i.accounts[3].is_signer = true;
    p.run(&[i]).assert_ok();
}

// ═════════════════════════════ close_game ═════════════════════════════

#[test]
fn cg_after_settle_happy() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    let pl0 = p.lamports(&player);
    let d = p.run(&[close_ix(game, player)]);
    d.assert_ok();
    cu("close_game", &d);
    assert_eq!(p.lamports(&player), pl0 + rent_min(180));
    assert!(p.get(&game).is_none_or(|a| a.lamports == 0 && a.data.is_empty() && a.owner == ids::SYSTEM));
    assert!(d.anchor.events.is_empty());
}

#[test]
fn cg_after_refund() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    p.ok(&[refund_ix(game, player)]);
    p.run(&[close_ix(game, player)]).assert_ok();
}

#[test]
fn cg_expired_settled_flag_ok() {
    let (mut p, _w, player, game) = started();
    edit_game(&mut p, game, |g| { g.status = GameStatus::Expired; g.settled = true; });
    p.run(&[close_ix(game, player)]).assert_ok();
}

#[test]
fn cg_playing_6018() {
    let (mut p, _w, player, game) = started();
    p.run(&[close_ix(game, player)]).assert_err(6018);
}

#[test]
fn cg_won_unsettled_6018() {
    let (mut p, _w, player, game) = revealed();
    p.ok(&[cash_ix(game, player)]);
    p.run(&[close_ix(game, player)]).assert_err(6018);
}

#[test]
fn cg_lost_unsettled_6018() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.run(&[close_ix(game, player)]).assert_err(6018);
}

#[test]
fn cg_playing_settled_flag_6018() {
    let (mut p, _w, player, game) = started();
    edit_game(&mut p, game, |g| g.settled = true);
    p.run(&[close_ix(game, player)]).assert_err(6018);
}

#[test]
fn cg_extra_lamports_all_returned() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    set_lamports(&mut p, game, rent_min(180) + 999);
    let pl0 = p.lamports(&player);
    p.run(&[close_ix(game, player)]).assert_ok();
    assert_eq!(p.lamports(&player), pl0 + rent_min(180) + 999);
}

#[test]
fn cg_wrong_player_6007() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    let thief = p.user("thief");
    p.run(&[close_ix(game, thief)]).assert_err(6007);
}

#[test]
fn cg_player_not_signer_3010() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    let mut i = close_ix(game, player);
    i.accounts[1].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn cg_player_readonly_2000() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    let mut i = close_ix(game, player);
    i.accounts[1].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn cg_game_readonly_2000() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    let mut i = close_ix(game, player);
    i.accounts[0].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn cg_game_wrong_owner_3007() {
    let (mut p, _w, player, game) = started();
    edit_game(&mut p, game, |g| g.status = GameStatus::Expired);
    set_owner(&mut p, game, key("other-program"));
    p.run(&[close_ix(game, player)]).assert_err(3007);
}

#[test]
fn cg_missing_game_3012() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.run(&[close_ix(pda::game(&player), player)]).assert_err(3012);
}

#[test]
fn cg_stats_in_game_slot_3002() {
    let (mut p, _w, player, _game) = started();
    p.run(&[close_ix(pda::stats(&player), player)]).assert_err(3002);
}

#[test]
fn cg_game_copy_wrong_address_2006() {
    let (mut p, _w, player, game) = started();
    edit_game(&mut p, game, |g| g.status = GameStatus::Expired);
    let fake = key("fake-game");
    clone_to(&mut p, game, fake);
    p.run(&[close_ix(fake, player)]).assert_err(2006);
}

#[test]
fn cg_short_accounts_3005() {
    for n in 0..2 {
        let (mut p, _w, player, game) = started();
        edit_game(&mut p, game, |g| g.status = GameStatus::Expired);
        let mut i = close_ix(game, player);
        i.accounts.truncate(n);
        p.run(&[i]).failed_show();
    }
}

#[test]
fn cg_trailing_data_ok() {
    let (mut p, _w, player, game) = started();
    edit_game(&mut p, game, |g| g.status = GameStatus::Expired);
    let mut i = close_ix(game, player);
    i.data.push(1);
    p.run(&[i]).assert_ok();
}

#[test]
fn cg_game_longer_data_closed() {
    let (mut p, _w, player, game) = started();
    edit_game(&mut p, game, |g| g.status = GameStatus::Expired);
    p.patch(game, |d| d.resize(300, 1));
    p.run(&[close_ix(game, player)]).assert_ok();
}

// ═════════════════════════════ close_unsettled_game ═════════════════════════════

fn lost_unsettled() -> (Pair, World, Address, Address) {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    (p, w, player, game)
}

#[test]
fn cu_happy() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    let pl0 = p.lamports(&player);
    let d = p.run(&[cus_ix(game, player)]);
    d.assert_ok();
    cu("close_unsettled_game", &d);
    assert_eq!(p.lamports(&player), pl0 + rent_min(180));
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
}

#[test]
fn cu_won_unsettled_ok() {
    let (mut p, _w, player, game) = revealed();
    p.ok(&[cash_ix(game, player)]);
    p.warp(START_SLOT + 39);
    p.run(&[cus_ix(game, player)]).assert_ok();
}

#[test]
fn cu_boundary_38_6014() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 38);
    p.run(&[cus_ix(game, player)]).assert_err(6014);
    p.warp(START_SLOT + 39);
    p.run(&[cus_ix(game, player)]).assert_ok();
}

#[test]
fn cu_playing_6018() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 39);
    p.run(&[cus_ix(game, player)]).assert_err(6018);
}

#[test]
fn cu_expired_6018() {
    let (mut p, _w, player, game) = started();
    p.warp(START_SLOT + 301);
    p.ok(&[refund_ix(game, player)]);
    p.run(&[cus_ix(game, player)]).assert_err(6018);
}

#[test]
fn cu_settled_6017() {
    let (mut p, w, player, game) = lost_unsettled();
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    p.warp(START_SLOT + 39);
    p.run(&[cus_ix(game, player)]).assert_err(6017);
}

#[test]
fn cu_error_order_settled_before_time() {
    let (mut p, w, player, game) = lost_unsettled();
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    p.run(&[cus_ix(game, player)]).assert_err(6017);
}

#[test]
fn cu_outstanding_saturates() {
    let (mut p, _w, player, game) = lost_unsettled();
    edit_v2(&mut p, |v| v.total_outstanding_max_payout = 5);
    p.warp(START_SLOT + 39);
    p.run(&[cus_ix(game, player)]).assert_ok();
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
}

#[test]
fn cu_wrong_player_6007() {
    let (mut p, _w, _player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    let thief = p.user("thief");
    p.run(&[cus_ix(game, thief)]).assert_err(6007);
}

#[test]
fn cu_player_not_signer_3010() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    let mut i = cus_ix(game, player);
    i.accounts[2].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn cu_readonly_slots_2000() {
    for slot in 0..3 {
        let (mut p, _w, player, game) = lost_unsettled();
        p.warp(START_SLOT + 39);
        let mut i = cus_ix(game, player);
        i.accounts[slot].is_writable = false;
        p.run(&[i]).assert_err(2000);
    }
}

#[test]
fn cu_game_in_v2_slot_3002() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    p.run(&[ix::CloseUnsettledGame { v2_state: game, game, player }.ix()]).assert_err(3002);
}

#[test]
fn cu_v2_copy_wrong_address_2006() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    let fake = key("fake-v2");
    clone_to(&mut p, ids::V2_STATE, fake);
    p.run(&[ix::CloseUnsettledGame { v2_state: fake, game, player }.ix()]).assert_err(2006);
}

#[test]
fn cu_v2_bump_corrupt_2006() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    edit_v2(&mut p, |v| v.bump = 1);
    p.run(&[cus_ix(game, player)]).assert_err(2006);
}

/// V2 copy at a valid non-canonical PDA with matching stored bump (D2 situation, see sg_vault_noncanonical_stored_bump).
#[test]
fn diff_cu_v2_noncanonical_stored_bump() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    let (fake, b) = noncanon(&[b"kaboom_v2_state"]);
    clone_to(&mut p, ids::V2_STATE, fake);
    p.patch(fake, |d| d[8] = b);
    let d = p.run(&[ix::CloseUnsettledGame { v2_state: fake, game, player }.ix()]);
    println!("{}", d.report());
    d.assert_same();
}

#[test]
fn cu_short_accounts_3005() {
    for n in 0..3 {
        let (mut p, _w, player, game) = lost_unsettled();
        p.warp(START_SLOT + 39);
        let mut i = cus_ix(game, player);
        i.accounts.truncate(n);
        p.run(&[i]).failed_show();
    }
}

#[test]
fn cu_game_wrong_owner_3007() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    set_owner(&mut p, game, ids::DLP);
    p.run(&[cus_ix(game, player)]).assert_err(3007);
}

// ═════════════════════════════ multi-step lifecycles ═════════════════════════════

#[test]
fn flow_win_cashout_settle_close_restart() {
    let (mut p, w, player, game) = started();
    for t in [0u8, 1, 3, 4] { p.ok(&[reveal_ix(&w, game, t, false)]); }
    p.ok(&[cash_ix(game, player)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    p.ok(&[close_ix(game, player)]);
    // restart: same PDA re-inited
    let game2 = p.start_game(player, 2, 2_000_000, 0b11, SALT);
    assert_eq!(game2, game);
    assert_eq!(vault(&p).total_games, 2);
}

#[test]
fn flow_loss_settle_close() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 0, false)]);
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    p.ok(&[close_ix(game, player)]);
}

#[test]
fn flow_refund_close_restart() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 0, false)]);
    p.warp(START_SLOT + 400);
    p.run(&[reveal_ix(&w, game, 1, false)]).assert_err(6013);
    p.ok(&[refund_ix(game, player)]);
    p.ok(&[close_ix(game, player)]);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok(); // INTENDED: VRF-only
    assert_eq!(game_of(&p, &game).start_slot, START_SLOT + 400);
}

#[test]
fn flow_cashout_after_expiry_settle_close() {
    let (mut p, w, player, game) = revealed();
    p.warp(START_SLOT + 500);
    p.ok(&[cash_ix(game, player)]);
    p.ok(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    p.ok(&[close_ix(game, player)]);
}

#[test]
fn flow_unsettled_close_restart() {
    let (mut p, _w, player, game) = lost_unsettled();
    p.warp(START_SLOT + 39);
    p.ok(&[cus_ix(game, player)]);
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok(); // INTENDED: VRF-only
    assert_eq!(v2(&p).total_outstanding_max_payout, game_of(&p, &game).max_payout);
}

#[test]
fn flow_streak_win_win_loss() {
    let (mut p, w) = world();
    let player = p.user("player");
    for (i, mine) in [false, false, true].into_iter().enumerate() {
        let salt = [i as u8 + 1; 32];
        let game = p.start_game(player, 1, BET, LAYOUT, salt);
        if mine {
            p.ok(&[reveal_ix(&w, game, 2, true)]);
        } else {
            for t in 0..=i as u8 { p.ok(&[reveal_ix(&w, game, t + 3, false)]); }
            p.ok(&[cash_ix(game, player)]);
        }
        p.ok(&[settle_ix(&w, game, player, LAYOUT, salt)]);
        p.ok(&[close_ix(game, player)]);
    }
    let s = stats_of(&p, &player);
    assert_eq!((s.games_played, s.games_won, s.current_streak, s.best_streak), (3, 2, 0, 2));
    assert_eq!(s.biggest_multiplier_bps, mult(2, 1, 100));
}

#[test]
fn flow_referral_accrual_over_games() {
    let (mut p, w, player, referrer, mut game) = referred_game();
    for i in 0..3u8 {
        let salt = [i + 10; 32];
        if i > 0 { game = p.start_game(player, 1, BET, LAYOUT, salt); }
        let salt = if i == 0 { SALT } else { salt };
        p.ok(&[reveal_ix(&w, game, 2, true)]);
        p.ok(&[with_ref(settle_ix(&w, game, player, LAYOUT, salt), &referrer)]);
        p.ok(&[close_ix(game, player)]);
    }
    let r = p.read(&pda::referral(&referrer), ReferralAccount::decode);
    assert_eq!((r.referred_volume, r.accrued_lamports), (3 * BET, 3 * BET * 50 / 10_000));
}

#[test]
fn flow_two_players_concurrent() {
    let (mut p, w) = world();
    let (a, b) = (p.user("alice"), p.user("bob"));
    let ga = p.start_game(a, 1, BET, LAYOUT, SALT);
    let gb = p.start_game(b, 2, 2_000_000, 0b1001, SALT);
    p.ok(&[reveal_ix(&w, ga, 5, false), reveal_ix(&w, gb, 0, true)]);
    p.ok(&[cash_ix(ga, a)]);
    p.ok(&[settle_ix(&w, gb, b, 0b1001, SALT), settle_ix(&w, ga, a, LAYOUT, SALT)]);
    p.ok(&[close_ix(ga, a), close_ix(gb, b)]);
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
}

#[test]
fn flow_lp_and_house_split_with_pending_withdraw() {
    // real LP deposit + request_withdraw (pending units) then a settle with treasury split
    let (mut p, w, player, game) = started();
    edit_vault(&mut p, |v| v.treasury_split_bps = 5_000);
    let lp = p.user("lp");
    p.ok(&[ix::LpDeposit { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(5 * SOL)]);
    let units = p.read(&pda::lp(&lp), accounts::LpPosition::decode).units;
    p.run(&[ix::RequestWithdraw { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(units / 2)]).assert_same();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    let d = p.run(&[settle_ix(&w, game, player, LAYOUT, SALT)]);
    d.assert_ok();
    p.ok(&[close_ix(game, player)]);
}

#[test]
fn flow_multi_ix_tx_reveal_cashout_settle_close() {
    let (mut p, w, player, game) = started();
    let d = p.run(&[
        reveal_ix(&w, game, 5, false),
        cash_ix(game, player),
        settle_ix(&w, game, player, LAYOUT, SALT),
        close_ix(game, player),
    ]);
    d.assert_ok();
    assert_eq!(d.anchor.ix_lines.len(), 4);
}

#[test]
fn flow_multi_ix_tx_second_fails_rolls_back() {
    let (mut p, w, player, game) = started();
    let d = p.run(&[reveal_ix(&w, game, 5, false), close_ix(game, player)]);
    d.assert_err(6018);
    assert_eq!(game_of(&p, &game).safe_reveals, 0);
}

// ═════════════════════════════ extra edge cases ═════════════════════════════

#[test]
fn sg_game_system_owned_with_data_fails() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.set_account(pda::game(&player), Account { lamports: 1, data: vec![0; 10], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_failed(); // INTENDED: VRF-only
}

#[test]
fn sg_vault_at_rent_6005() {
    let (mut p, _w) = world();
    set_lamports(&mut p, ids::VAULT, vault_rent());
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(6005); // INTENDED: VRF-only
}

#[test]
fn sg_vault_below_rent_6005() {
    let (mut p, _w) = world();
    set_lamports(&mut p, ids::VAULT, vault_rent() - 1);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(6005); // INTENDED: VRF-only
}

#[test]
fn sg_edge_over_bps_fails() {
    let (mut p, _w) = world();
    edit_vault(&mut p, |v| v.house_edge_bps = 10_001);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_failed(); // INTENDED: VRF-only
}

#[test]
fn sg_edge_10000_worst_zero_ok() {
    let (mut p, _w) = world();
    edit_vault(&mut p, |v| v.house_edge_bps = 10_000);
    let player = p.user("player");
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok(); // INTENDED: VRF-only
    assert_eq!(game_of(&p, &pda::game(&player)).max_payout, 0);
}

#[test]
fn sg_stats_delegated_owner_3007() {
    let (mut p, _w) = world();
    let player = p.user("player");
    p.set_data(pda::stats(&player), ids::DLP, fresh_stats(player).encode());
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_err(3007); // INTENDED: VRF-only
}

#[test]
fn flow_settle_close_restart_same_tx() {
    let (mut p, w, player, game) = started();
    p.ok(&[reveal_ix(&w, game, 2, true)]);
    // INTENDED: VRF-only. A restart in the same tx would fail the whole tx on the port (6057), so settle + close
    // run together on both sides, then the restart runs on its own.
    p.run(&[settle_ix(&w, game, player, LAYOUT, SALT), close_ix(game, player)]).assert_ok().assert_cpi_same();
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok();
    assert_eq!(game_of(&p, &game).status, GameStatus::Playing);
}

#[test]
fn flow_start_reveal_same_tx() {
    let (mut p, w) = world();
    let player = p.user("player");
    let game = pda::game(&player);
    // INTENDED: VRF-only. The port cannot start the game, so the start runs alone (Anchor state mirrored),
    // then reveal + settle + close run in one tx on both sides.
    p.run_legacy(&[sg_ix(player, 1, BET, LAYOUT)]).anchor_ok();
    p.run(&[reveal_ix(&w, game, 2, true), settle_ix(&w, game, player, LAYOUT, SALT), close_ix(game, player)])
        .assert_ok().assert_cpi_same();
}
