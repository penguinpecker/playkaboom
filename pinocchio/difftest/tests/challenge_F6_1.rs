//! Adversarial challenge of F6 (orphan VrfGame reuse in start_game_vrf). Each test tries a way the reuse
//! could leak value, break accounting, or harm an honest player; each asserts it does not.
use difftest::*;

const BET: u64 = 10_000_000;

fn world() -> (Pair, World) {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    (p, w)
}
fn start_ix(player: Address, mines: u8, bet: u64) -> Instruction {
    ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), player_stats: pda::stats(&player), ..Default::default() }
        .ix(mines, bet, player)
}
fn refund_ix(caller: Address, player: Address) -> Instruction {
    ix::RefundStalledVrf { caller, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), ..Default::default() }.ix()
}
fn release_ix(owner: Address, player: Address) -> Instruction {
    ix::AdminReleaseVrfClaim { owner, player, claim: pda::vrf_claim(&player), ..Default::default() }.ix()
}
fn port(p: &Pair, k: &Address) -> Account { p.port.get_account(k).unwrap() }
fn outstanding(p: &Pair) -> u64 {
    accounts::VaultV2State::decode(&port(p, &ids::V2_STATE).data).unwrap().total_outstanding_max_payout
}
const T0: u64 = START_SLOT + 216_001;

/// A reuse that fails later in the handler (BetTooLow) must leave the orphan byte-identical (no wipe persists).
#[test]
fn f6c_failed_start_leaves_orphan_intact() {
    let (mut p, w) = world();
    let player = p.user("player");
    p.start_game_vrf(player, 1, BET, player);
    p.warp(T0);
    p.ok(&[release_ix(w.owner, player)]);
    let game = pda::vrf_game(&player);
    let before = port(&p, &game);
    let d = p.run(&[start_ix(player, 1, 1)]);
    assert!(!d.anchor.ok() && !d.port.ok(), "{}", d.report());
    assert_eq!(port(&p, &game), before);
    assert!(p.port.get_account(&pda::vrf_claim(&player)).map_or(true, |a| a.lamports == 0));
}

/// Full cycle on the port: dust a stranger sends to the orphan goes only to its player; the house crank
/// cannot refund the reused game on the OLD start_slot; outstanding returns to 0 and the vault nets 0.
#[test]
fn f6c_reuse_accounting_and_crank_timer() {
    let (mut p, w) = world();
    let player = p.user("player");
    p.start_game_vrf(player, 1, BET, player);
    p.warp(T0);
    p.ok(&[release_ix(w.owner, player)]);
    assert_eq!(outstanding(&p), 0);
    let game = pda::vrf_game(&player);
    let mut g = p.get(&game).unwrap(); // stranger's dust (anyone can credit a program-owned account)
    g.lamports += 777;
    p.set_account(game, g);
    let (vault0, game0, pl0) = (port(&p, &ids::VAULT).lamports, port(&p, &game).lamports, port(&p, &player).lamports);

    let d = p.run(&[start_ix(player, 2, BET)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
    let reserved = accounts::VrfClaim::decode(&port(&p, &pda::vrf_claim(&player)).data).unwrap().reserved;
    assert_eq!(outstanding(&p), reserved);
    assert_eq!(port(&p, &ids::VAULT).lamports, vault0 + BET);

    // House crank 1 slot after the reused start: the new claim's timer applies, not the released one's.
    p.warp(T0 + 1);
    let d = p.run(&[refund_ix(w.house, player)]);
    assert!(!d.port.ok(), "house refunded a fresh game early");
    println!("early house refund on reused game: {:?}", d.port.code());

    p.warp(T0 + 27);
    assert!(p.run(&[refund_ix(w.house, player)]).port.ok());
    assert_eq!(outstanding(&p), 0);
    assert_eq!(port(&p, &ids::VAULT).lamports, vault0, "vault nets zero");
    assert_eq!(port(&p, &player).lamports, pl0 + game0, "player gets the old rent + dust, nobody else");
    // Wallet can play again after the cycle (fresh init path).
    p.warp(T0 + 30);
    assert!(p.run(&[start_ix(player, 1, BET)]).port.ok());
}
