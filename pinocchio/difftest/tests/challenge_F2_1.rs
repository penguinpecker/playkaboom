//! Adversarial challenge of F2 (`expire_game`). Each test is an attack attempt on the port; a passing test
//! means the attack FAILED (no new hole). Anchor has no `expire_game` (101), so the port is read directly.
use accounts::{GameSession, VaultV2State};
use difftest::*;

const BET: u64 = 10_000_000;
const DISC: [u8; 8] = [0xd0, 0x15, 0x57, 0x83, 0xf2, 0x2b, 0xfc, 0x90];

fn expire_ix(player: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(ids::VAULT, false),
            AccountMeta::new(ids::V2_STATE, false),
            AccountMeta::new(pda::game(&player), false),
            AccountMeta::new(player, false),
        ],
        data: DISC.to_vec(),
    }
}
fn settle_ix(w: &World, player: Address, layout: u16, salt: [u8; 32]) -> Instruction {
    ix::SettleGame { game: pda::game(&player), player_stats: pda::stats(&player), house_authority: w.house, treasury: w.treasury,
        ..Default::default() }.ix(layout, salt)
}
fn reveal(p: &mut Pair, w: &World, player: Address, tile: u8) {
    p.ok(&[ix::RevealTile { game: pda::game(&player), house_authority: w.house, ..Default::default() }.ix(tile, false)]);
}
fn lam(p: &Pair, k: &Address) -> u64 { p.port.get_account(k).map(|a| a.lamports).unwrap_or(0) }
fn game(p: &Pair, player: &Address) -> GameSession { GameSession::decode(&p.port.get_account(&pda::game(player)).unwrap().data).unwrap() }
fn outstanding(p: &Pair) -> u64 { VaultV2State::decode(&p.port.get_account(&ids::V2_STATE).unwrap().data).unwrap().total_outstanding_max_payout }

/// A stranger front-runs the house crank's `[expire_game, settle_game]` with a bare `expire_game`.
/// Expected: the crank tx reverts atomically (6003), a standalone settle_game still releases exactly once,
/// and nobody can release the reservation a second time.
#[test]
fn c2_frontrun_cron_bundle_releases_once() {
    let mut p = Pair::new();
    let w = p.house_world();
    let other = p.user("other");
    p.start_game(other, 1, BET, 0b100, [9; 32]);
    let other_res = outstanding(&p);
    let player = p.user("player");
    p.start_game(player, 1, BET, 0b100, [7; 32]);
    reveal(&mut p, &w, player, 0);
    p.warp(p.slot() + 301);
    let stranger = p.user("stranger");
    let pl = lam(&p, &player);
    let payout = BET * game(&p, &player).multiplier_bps / 10_000;
    assert!(p.run_as(stranger, &[expire_ix(player)]).port.ok());
    assert_eq!(lam(&p, &player) - pl, payout);
    // house bundle now fails as a whole
    let d = p.run_as(w.house, &[expire_ix(player), settle_ix(&w, player, 0b100, [7; 32])]);
    assert_eq!(d.port.code(), Some(6003), "{}", d.port.logs.join("\n"));
    assert!(!game(&p, &player).settled);
    // standalone settle (release-stuck path) works and releases once
    let d = p.run_as(w.house, &[settle_ix(&w, player, 0b100, [7; 32])]);
    assert!(d.port.ok(), "{}", d.port.logs.join("\n"));
    assert_eq!(outstanding(&p), other_res, "only the other game's reservation is left");
    assert_eq!(lam(&p, &player) - pl, payout, "settle pays nothing extra");
    // second settle / expire cannot touch the other game's reservation
    assert!(!p.run_as(w.house, &[settle_ix(&w, player, 0b100, [7; 32])]).port.ok(), "already settled");
    assert_eq!(p.run_as(stranger, &[expire_ix(player)]).port.code(), Some(6003));
    assert_eq!(outstanding(&p), other_res);
}

/// Refund branch then every other release path: nothing releases twice.
#[test]
fn c2_refund_branch_no_rerelease() {
    let mut p = Pair::new();
    let w = p.house_world();
    let other = p.user("other");
    p.start_game(other, 1, BET, 0b100, [9; 32]);
    let other_res = outstanding(&p);
    let player = p.user("player");
    p.start_game(player, 1, BET, 0b100, [7; 32]);
    p.warp(p.slot() + 301 + 600);
    let stranger = p.user("stranger");
    assert!(p.run_as(stranger, &[expire_ix(player)]).port.ok());
    assert_eq!(outstanding(&p), other_res);
    assert!(!p.run_as(w.house, &[settle_ix(&w, player, 0b100, [7; 32])]).port.ok());
    let cu = ix::CloseUnsettledGame { game: pda::game(&player), player, ..Default::default() }.ix();
    assert!(!p.run(&[cu]).port.ok());
    assert!(!p.run(&[ix::RefundExpired { game: pda::game(&player), player, ..Default::default() }.ix()]).port.ok());
    assert_eq!(outstanding(&p), other_res);
}

/// The griefer tries to make the credit to `game.player` fail so the crank can never clear the game:
/// drained to 0 lamports (bet >= MIN_BET 1M > 890,880 rent-exempt min, so it lands RentExempt), or reassigned to
/// another program with data. An executable wallet cannot be staged in LiteSVM (set_account rejects it); on mainnet
/// SIMD-0162 (remove_accounts_executable_flag_checks, active since slot 350,352,004) removed ExecutableLamportChange.
#[test]
fn c2_unreceivable_player_wallet_attempts() {
    for variant in 0..2 {
        let mut p = Pair::new();
        p.house_world();
        let g = p.user("griefer");
        p.start_game(g, 1, 1_000_000, 0b100, [7; 32]); // MIN_BET
        p.warp(p.slot() + 301);
        let acc = match variant {
            0 => Account { lamports: 0, ..Default::default() },
            _ => Account { lamports: rent_min(64), data: vec![1; 64], owner: key("attacker-program"), ..Default::default() },
        };
        let before = acc.lamports;
        p.set_account(g, acc);
        let cranker = p.user("cranker");
        let o = p.run_as(cranker, &[expire_ix(g)]).port;
        assert!(o.ok(), "variant {variant}: {}", o.logs.join("\n"));
        assert_eq!(lam(&p, &g) - before, 1_000_000, "variant {variant}");
        assert_eq!(outstanding(&p), 0, "variant {variant}");
    }
}

/// Crank-design caveat (off-chain, not a program hole): one already-cleared entry reverts a whole batch.
#[test]
fn c2_batch_poisoned_by_one_self_refund() {
    let mut p = Pair::new();
    p.house_world();
    let players: Vec<Address> = (0..10).map(|i| p.user(&format!("p{i}"))).collect();
    for (i, a) in players.iter().enumerate() { p.start_game(*a, 1, 1_000_000, 0b100, [i as u8; 32]); }
    p.warp(p.slot() + 301);
    // griefer p0 refunds itself right before the crank lands
    p.ok(&[ix::RefundExpired { game: pda::game(&players[0]), player: players[0], ..Default::default() }.ix()]);
    let held = outstanding(&p);
    let cranker = p.user("cranker");
    let ixs: Vec<_> = players.iter().map(|a| expire_ix(*a)).collect();
    assert_eq!(p.run_as(cranker, &ixs).port.code(), Some(6003));
    assert_eq!(outstanding(&p), held, "nine honest-to-clear games stay reserved until the crank retries");
    assert!(p.run_as(cranker, &ixs[1..]).port.ok());
    assert_eq!(outstanding(&p), 0);
}
