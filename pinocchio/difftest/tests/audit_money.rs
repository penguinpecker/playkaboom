//! Money / accounting audit repros (lamports, reservations, LP units).
//! Every tx runs on both builds; each test asserts the two agree (so each finding is INHERITED from
//! the Anchor source when it passes) and then asserts the economic outcome that makes it a finding.
use difftest::*;
use accounts::{VaultV2State};

const SOL: u64 = LAMPORTS_PER_SOL;

fn v2(p: &Pair) -> VaultV2State { p.read(&ids::V2_STATE, VaultV2State::decode) }

fn sg_ix(player: Address, mines: u8, bet: u64, commitment: [u8; 32]) -> Instruction {
    ix::StartGame { game: pda::game(&player), player_stats: pda::stats(&player), player, ..Default::default() }
        .ix(mines, bet, commitment)
}

fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    if rem == 0 { return false; }
    u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
fn rand_for(safe: u8, mines: u8, mine: bool) -> [u8; 32] {
    (0..=255u8).map(|b| [b; 32]).find(|r| is_mine(r, safe, mines) == mine).unwrap()
}
/// Fake one VRF callback on a program-owned VrfGame (pending tile + scoped signer).
fn vrf_reveal(p: &mut Pair, game: Address, tile: u8, mine: bool) {
    let g = p.get(&game).unwrap().data;
    let r = rand_for(g[77], g[74], mine);
    p.patch(game, |d| { d[79] = 1; d[80] = tile; });
    p.ok(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(r)]);
}
fn settle_vrf_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury,
        player_stats: pda::stats(&player), ..Default::default() }.ix()
}

/// F1. Anyone can start a legacy game with a commitment only they know (garbage), never reveal or
/// refund it, and its worst-case payout stays in `total_outstanding_max_payout` FOREVER: the house
/// cannot settle (no preimage), cannot reveal after expiry, and every release path
/// (refund_expired / close_unsettled_game) needs the player's signature. There is no admin release
/// for v1 GameSession. A handful of 0.001 SOL games pushes health to the floor and freezes play.
/// This keeps recording Anchor behaviour for the existing instructions; the port's fix (the new
/// permissionless `expire_game`, F2) is tested in fix_f2.rs.
#[test]
fn audit_legacy_abandoned_games_strand_reservation_and_freeze_play() {
    let mut p = Pair::new();
    let w = p.house_world(); // 50 SOL, max_payout 10%, min_health 10%
    let garbage = [0xA5u8; 32];
    let mut spent = 0u64; // attacker cost: bets + rent (bets are refundable at the attacker's discretion)
    let mut games = 0;
    for i in 0..200 {
        let a = p.user(&format!("griefer-{i}"));
        let before = p.lamports(&a);
        // greedy: the largest reservation the caps allow at the 0.001 SOL minimum bet
        let mut landed = false;
        for mines in (1..=8u8).rev() {
            // INTENDED: VRF-only. The port refuses every legacy start (6057), so this griefing path is closed on
            // the port; Anchor's games are mirrored onto it so the wind-down checks below still run on both.
            let d = p.run_legacy(&[sg_ix(a, mines, 1_000_000, garbage)]);
            if d.anchor.ok() { landed = true; break; }
        }
        if !landed { break; }
        games += 1;
        spent += before - p.lamports(&a);
    }
    let s = v2(&p);
    let assets = p.lamports(&ids::VAULT) - rent_min(428);
    println!("griefer games={games} cost={} SOL outstanding={} SOL assets={} SOL",
        spent as f64 / 1e9, s.total_outstanding_max_payout as f64 / 1e9, assets as f64 / 1e9);
    assert!(spent < SOL / 2, "attack must be cheap");
    assert!(s.total_outstanding_max_payout as u128 * 10_000 >= assets as u128 * 8_900, "health pinned at the floor");

    // A legitimate player can no longer place an ordinary bet (1 mine, 0.01 SOL, worst ~0.16 SOL).
    let honest = p.user("honest");
    let d = p.run_legacy(&[sg_ix(honest, 1, 10_000_000, commitment(0b100, 1, &[7; 32]))]);
    d.anchor_failed(); // INTENDED: VRF-only (port 6057)
    println!("honest start_game: anchor={} port={}", fmt_err(&d.anchor.err), fmt_err(&d.port.err));

    // The house has no way to release a griefer's reservation, now or after expiry.
    // Reveal-as-mine (inside the window) only makes it Lost; settle still needs the preimage.
    let g1 = key("griefer-1");
    p.ok(&[ix::RevealTile { game: pda::game(&g1), house_authority: w.house, ..Default::default() }.ix(0, true)]);
    p.run(&[ix::SettleGame { game: pda::game(&g1), player_stats: pda::stats(&g1), house_authority: w.house,
        treasury: w.treasury, ..Default::default() }.ix(0b1, [0; 32])]).assert_err(6015); // CommitmentMismatch
    let g0 = key("griefer-0");
    let game = pda::game(&g0);
    p.run(&[ix::SettleGame { game, player_stats: pda::stats(&g0), house_authority: w.house, treasury: w.treasury,
        ..Default::default() }.ix(0b11111, [0; 32])]).assert_err(6003); // GameNotPlaying (still Playing)
    p.warp(p.slot() + 301);
    p.run(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(0, true)]).assert_err(6013); // GameExpired
    let before = v2(&p).total_outstanding_max_payout;
    p.warp(p.slot() + 10_000_000);
    assert_eq!(v2(&p).total_outstanding_max_payout, before, "reservation never decays");
    // ...only the griefer can release it, whenever they like (and get the bet back).
    p.ok(&[ix::RefundExpired { game, player: g0, ..Default::default() }.ix()]);
    assert!(v2(&p).total_outstanding_max_payout < before);
}

/// F2. VRF variant: start + delegate, then never undelegate. While DLP-owned the L1 copy cannot be
/// settled (3007) or refunded (6052) by anyone but the player's own commit; settle_and_undelegate is
/// player/session-only. The reservation is stranded until the owner runs admin_release_vrf_claim
/// after ~24h, which refunds the bet in full EVEN IF the committed (DLP-owned) copy says LOST.
#[test]
fn audit_vrf_delegated_loss_is_withheld_then_refunded_by_backstop() {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    let player = p.user("vrf-loser");
    let session = p.user("vrf-session");
    let bet = 10_000_000;
    let game = p.start_game_vrf(player, 1, bet, session);
    let reserved = v2(&p).total_outstanding_max_payout;
    assert!(reserved > 0);
    // ER view: player reveals one tile and hits the mine (status LOST) ...
    vrf_reveal(&mut p, game, 3, true);
    let lost_bytes = p.get(&game).unwrap().data;
    assert_eq!(lost_bytes[8], 2);
    // ... and that state sits on L1 under DLP ownership (delegated, periodically committed, never undelegated).
    p.set_data(game, ids::DLP, lost_bytes);
    p.warp(p.slot() + 26);
    p.run(&[settle_vrf_ix(p.payer, player, w.treasury)]).assert_err(3007);
    p.run(&[ix::RefundStalledVrf { caller: w.house, player, claim: pda::vrf_claim(&player), game, ..Default::default() }.ix()])
        .assert_err(6052);
    assert_eq!(v2(&p).total_outstanding_max_payout, reserved, "reservation stranded");
    // After ABANDON_SLOTS the only backstop pays the lost bet back.
    p.warp(p.slot() + 216_001);
    let before = p.lamports(&player);
    p.ok(&[ix::AdminReleaseVrfClaim { owner: w.owner, player, claim: pda::vrf_claim(&player), ..Default::default() }.ix()]);
    let got = p.lamports(&player) - before;
    println!("lost bet {bet} refunded {got} (incl. claim rent)");
    assert!(got >= bet, "a LOST bet is refunded");
}

/// F3. A matured pending LP withdrawal is a perpetual free option: NAV ignores the liability of a
/// resolved-but-unsettled VRF win, settle_vrf is permissionless, so the LP bundles
/// [complete_withdraw, settle_vrf] and exits at the pre-loss NAV, pushing their share of the payout
/// onto the remaining LPs. Same LP, same state, two orders: compare proceeds.
/// After F4 this is a bounded residual on the port: it only works inside the 9,000-slot claim window
/// (this test warps unlock + 1), and the keeper normally completes first (fix_f4 T6/T7).
#[test]
fn audit_matured_pending_withdraw_front_runs_known_vrf_win() {
    let run = |withdraw_first: bool| -> u64 {
        let mut p = Pair::new();
        let w = p.house_world();
        let validator = key("validator");
        p.enable_vrf(&w, validator);
        let lp = p.user("lp");
        p.ok(&[ix::LpDeposit { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(2 * SOL)]);
        let units = p.read(&pda::lp(&lp), accounts::LpPosition::decode).units;
        p.ok(&[ix::RequestWithdraw { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(units)]);
        p.warp(p.slot() + 648_001); // matured; never expires
        // A player clears the board (1 mine, 15 safe) -> committed VRF_WON, awaiting settle on L1.
        let player = p.user("winner");
        let s = p.user("s");
        let game = p.start_game_vrf(player, 1, 300_000_000, s);
        for t in 0..15 { vrf_reveal(&mut p, game, t, false); }
        assert_eq!(p.get(&game).unwrap().data[8], 1);
        let before = p.lamports(&lp);
        let cw = ix::CompleteWithdraw { position: pda::lp(&lp), user: lp, ..Default::default() }.ix();
        let st = settle_vrf_ix(lp, player, w.treasury);
        let ixs = if withdraw_first { vec![cw, st] } else { vec![st, cw] };
        p.run_as(lp, &ixs).assert_ok();
        p.lamports(&lp) - before
    };
    let dodge = run(true);
    let fair = run(false);
    println!("lp proceeds: withdraw-first {dodge}  settle-first {fair}  extracted {}", dodge - fair);
    assert!(dodge > fair + 50_000_000, "LP dodges its share of a known loss");
}

/// F4 (audit) / F1 (fix), FIXED on the port. INTENDED: F1. In Anchor initialize_vault is permissionless
/// and the vault PDA is a singleton: the first caller becomes owner + house + treasury and the real owner
/// can never init. On the port only `DEPLOYER` can init, so the attacker fails (6055) and the owner lands.
#[test]
fn audit_initialize_vault_front_run_on_fresh_id() {
    let mut p = Pair::new();
    let attacker = p.user("attacker");
    let owner = p.deployer();
    let d = p.run(&[ix::InitializeVault { house_authority: attacker, treasury: attacker, owner: attacker, ..Default::default() }
        .ix(1_000, 1_000, 5_000)]);
    assert!(d.anchor.ok());
    assert_eq!(d.port.code(), Some(6055));
    let d = p.run(&[ix::InitializeVault { house_authority: owner, treasury: owner, owner, ..Default::default() }
        .ix(100, 100, 1_000)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
    let (a, pt) = p.get_both(&ids::VAULT);
    assert_eq!(accounts::Vault::decode(&a.unwrap().data).unwrap().owner, attacker);
    assert_eq!(accounts::Vault::decode(&pt.unwrap().data).unwrap().owner, owner);
}

/// F5. Legacy full clear: reveal_tile sets Won on the last safe tile without paying, cash_out then
/// refuses (GameNotPlaying) and settle_game pays nothing, so the player forfeits the max payout.
#[test]
fn audit_legacy_full_clear_pays_nothing() {
    let mut p = Pair::new();
    let w = p.house_world();
    let player = p.user("clearer");
    let layout: u16 = 1 << 15;
    let salt = [9u8; 32];
    let bet = 10_000_000;
    let game = p.start_game(player, 1, bet, layout, salt);
    for t in 0..15 { p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(t, false)]); }
    p.run(&[ix::CashOut { game, player, ..Default::default() }.ix()]).assert_err(6003);
    let (before, vault_before) = (p.lamports(&player), p.lamports(&ids::VAULT));
    p.ok(&[ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: w.treasury,
        ..Default::default() }.ix(layout, salt)]);
    assert_eq!(p.lamports(&player), before, "15.84x win never paid");
    assert!(vault_before - p.lamports(&ids::VAULT) < bet, "vault kept the bet and the win");
}
