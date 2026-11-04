//! Challenge F6 (MB-6): try to break the orphan-reuse fix in `start_game_vrf`. Every case here is an attack
//! variant that must NOT succeed (or a lockout variant that must heal). Anchor fails every reuse start.
use difftest::*;

const BET: u64 = 10_000_000;

fn world() -> (Pair, World, Address) {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    (p, w, validator)
}
fn start_ix(player: Address, mines: u8, session: Address) -> Instruction {
    ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), player_stats: pda::stats(&player), ..Default::default() }
        .ix(mines, BET, session)
}
fn deleg_ix(player: Address, validator: Address) -> Instruction {
    let mut i = delegate_vrf_ix(player);
    i.accounts.push(AccountMeta::new_readonly(validator, false));
    i
}
fn refund_ix(caller: Address, player: Address) -> Instruction {
    ix::RefundStalledVrf { caller, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), ..Default::default() }.ix()
}
fn settle_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury, player_stats: pda::stats(&player), ..Default::default() }.ix()
}
fn release_ix(owner: Address, player: Address) -> Instruction {
    ix::AdminReleaseVrfClaim { owner, player, claim: pda::vrf_claim(&player), ..Default::default() }.ix()
}
fn cash_ix(signer: Address, player: Address) -> Instruction {
    ix::CashOutVrf { signer, game: pda::vrf_game(&player), ..Default::default() }.ix()
}
fn undelegate(p: &mut Pair, player: Address, bytes: Vec<u8>) {
    let game = pda::vrf_game(&player);
    let buffer = pda::undelegate_buffer(&game);
    for k in [game, pda::delegation_record(&game), pda::delegation_metadata(&game)] {
        p.set_account(k, Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    }
    p.set_data(buffer, ids::DLP, bytes);
    let rp = p.user("dlp-payer");
    let mut u = ix::ProcessUndelegation { base_account: game, buffer, payer: rp, ..Default::default() }
        .ix(vec![b"kaboom_vrf_game".to_vec(), player.as_ref().to_vec()]);
    u.accounts[1].is_signer = true;
    u.accounts[2].is_signer = true;
    p.ok(&[u]);
}
fn port(p: &Pair, k: &Address) -> Account { p.port.get_account(k).unwrap() }

/// Same-tx bundle: [admin_release, start] heals in one tx; [admin_release, start, settle] cannot settle the
/// fresh game (no stale result to redeem), so the whole tx fails on the port.
#[test]
fn c6_release_and_restart_same_tx() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    p.start_game_vrf(player, 1, BET, player);
    p.warp(START_SLOT + 216_001);
    let d = p.run(&[release_ix(w.owner, player), start_ix(player, 1, player), settle_ix(player, player, w.treasury)]);
    assert!(!d.anchor.ok() && !d.port.ok(), "{}", d.report());
    let d = p.run(&[release_ix(w.owner, player), start_ix(player, 1, player)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
}

/// A WON result that came back after the release cannot be redeemed against the new claim: reuse wipes it,
/// settle / cash_out / refund-by-house on the new game all fail; the session key of the OLD game is dead.
#[test]
fn c6_stale_won_result_not_redeemable_after_reuse() {
    let (mut p, w, validator) = world();
    let player = p.user("player");
    let old_sk = key("old-session");
    p.start_game_vrf(player, 1, BET, old_sk);
    p.ok(&[deleg_ix(player, validator)]);
    let game = pda::vrf_game(&player);
    let mut won = p.get(&game).unwrap().data;
    won[8] = 1; // WON
    won[78] = 1; // reveal_count
    won[79] = 1; // safe_reveals
    won[81..83].copy_from_slice(&(1u16 << 3).to_le_bytes());
    p.warp(START_SLOT + 216_001);
    p.ok(&[release_ix(w.owner, player)]);
    undelegate(&mut p, player, won);
    let vault0 = p.lamports(&ids::VAULT);
    let new_sk = key("new-session");
    let d = p.run(&[start_ix(player, 1, new_sk), settle_ix(player, player, w.treasury)]);
    assert!(!d.port.ok(), "settled a stale WON: {}", d.report());
    assert!(p.run(&[start_ix(player, 1, new_sk)]).port.ok());
    assert!(!p.run(&[settle_ix(player, player, w.treasury)]).port.ok());
    assert!(!p.run_as(old_sk, &[cash_ix(old_sk, player)]).port.ok(), "old session key still controls the game");
    assert!(!p.run(&[cash_ix(player, player)]).port.ok(), "cash_out with zero reveals");
    p.warp(START_SLOT + 216_001 + 26);
    let d = p.run(&[refund_ix(player, player)]);
    assert!(d.port.ok(), "{}", d.report());
    assert_eq!(port(&p, &ids::VAULT).lamports, vault0, "vault paid nothing beyond the refunded bet");
}

/// Repeated orphan/reuse cycles: the game rent neither drains nor doubles, and donated dust goes only to the
/// player. Stranger cannot pre-create or block the reuse by donating to the orphan.
#[test]
fn c6_repeat_cycles_and_dust() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    let stranger = p.user("stranger");
    p.start_game_vrf(player, 1, BET, player);
    let game = pda::vrf_game(&player);
    let rent0 = p.lamports(&game);
    let mut slot = START_SLOT;
    for _ in 0..3 {
        slot += 216_001;
        p.warp(slot);
        assert!(p.run(&[release_ix(w.owner, player)]).port.ok());
        // stranger dusts the orphan before the player restarts
        let t = Instruction {
            program_id: ids::SYSTEM,
            accounts: vec![AccountMeta::new(stranger, true), AccountMeta::new(game, false)],
            data: { let mut v = 2u32.to_le_bytes().to_vec(); v.extend_from_slice(&1_000u64.to_le_bytes()); v },
        };
        assert!(p.run_as(stranger, &[t]).port.ok());
        let d = p.run(&[start_ix(player, 1, player)]);
        assert!(d.port.ok(), "{}", d.report());
        assert_eq!(port(&p, &game).owner, PROGRAM_ID);
    }
    assert_eq!(port(&p, &game).lamports, rent0 + 3_000);
    p.warp(slot + 26);
    let before = port(&p, &player).lamports;
    assert!(p.run(&[refund_ix(player, player)]).port.ok());
    assert_eq!(port(&p, &player).lamports - before, BET + rent_min(accounts::VrfClaim::SPACE) + rent0 + 3_000);
    assert!(p.run(&[start_ix(player, 1, player)]).port.ok(), "fresh start after full close");
}
