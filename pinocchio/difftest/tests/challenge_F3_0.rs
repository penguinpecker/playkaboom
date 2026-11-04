//! Challenge to F3 (MB-1 fix), kept as the regression test of its fix. Bypass found: on the ER the attacker sent
//! ONE tx `[reveal_request_vrf, settle_and_undelegate_vrf]`, so the commit carried `pending = 1` and the game came
//! back to L1 PLAYING + pending, out of reach of every crank (force ER-only and 6044, house refund 6007,
//! re-delegate 6044, settle 6003) until the 24 h Squads admin release, while the attacker could refund itself.
//! FIXED (F3, `vrf.rs::end_playing`): `settle_and_undelegate_vrf` ends a PLAYING game before scheduling the
//! undelegate. A pending reveal fails 6044, so that tx reverts and the game stays delegated, where the house
//! force crank clears it. The reversed order `[settle_and_undelegate_vrf, reveal_request_vrf]` fails 6003 (the
//! game is already VOID when the request runs). Anchor still accepts both (inherited behaviour, recorded).
use accounts::VaultV2State;
use difftest::*;

const FORCE: [u8; 8] = [0xda, 0x30, 0xa3, 0xda, 0x54, 0xf8, 0xe4, 0x65];

fn force_ix(house: Address, player: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(house, true),
            AccountMeta::new(pda::vrf_game(&player), false),
            AccountMeta::new_readonly(ids::MAGIC_PROGRAM, false),
            AccountMeta::new(ids::MAGIC_CONTEXT, false),
            AccountMeta::new_readonly(ids::VAULT, false),
        ],
        data: FORCE.to_vec(),
    }
}
fn start_ix(player: Address, bet: u64) -> Instruction {
    ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), player_stats: pda::stats(&player), ..Default::default() }
        .ix(1, bet, player)
}
fn deleg_ix(player: Address, validator: Address) -> Instruction {
    let mut i = delegate_vrf_ix(player);
    i.accounts.push(AccountMeta::new_readonly(validator, false));
    i
}
fn refund_ix(caller: Address, player: Address) -> Instruction {
    ix::RefundStalledVrf { caller, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), ..Default::default() }.ix()
}
fn outstanding(p: &Pair) -> u64 { VaultV2State::decode(&p.port.get_account(&ids::V2_STATE).unwrap().data).unwrap().total_outstanding_max_payout }
/// Port-only fake DLP undelegation of `player`'s game with the port's own ER bytes (the sides differ after F3).
fn undelegate_port(p: &mut Pair, player: Address) {
    let game = pda::vrf_game(&player);
    let bytes = p.port.get_account(&game).unwrap().data;
    let buffer = pda::undelegate_buffer(&game);
    for k in [game, pda::delegation_record(&game), pda::delegation_metadata(&game)] {
        p.port.set_account(k, Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
    }
    p.port.set_account(buffer, Account { lamports: rent_min(bytes.len()), data: bytes, owner: ids::DLP, executable: false, rent_epoch: 0 }).unwrap();
    let rp = p.user("dlp-payer");
    let mut u = ix::ProcessUndelegation { base_account: game, buffer, payer: rp, ..Default::default() }
        .ix(vec![b"kaboom_vrf_game".to_vec(), player.as_ref().to_vec()]);
    u.accounts[1].is_signer = true;
    u.accounts[2].is_signer = true;
    let d = p.run(&[u]);
    assert!(d.port.ok(), "{}", d.report());
}

#[test]
fn challenge_f3_pending_undelegate_freezes_past_the_crank() {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    let assets = |p: &Pair| p.port.get_account(&ids::VAULT).unwrap().lamports - rent_min(accounts::Vault::SPACE);
    let max_bet = |p: &Pair| {
        let a = assets(p) as u128;
        let health = (a.saturating_sub(outstanding(p) as u128) * 10_000 / a).min(10_000);
        (a * 1_000 / 10_000 * health / 10_000 * 10_000 / 158_400 * 99 / 100) as u64
    };
    let mut attackers = vec![];
    for i in 0..30 {
        let a = p.user(&format!("attacker{i}"));
        let bet = max_bet(&p);
        if bet < 1_000_000 { break; }
        let d = p.run(&[start_ix(a, bet)]);
        if !d.anchor.ok() { d.assert_same(); break; }
        d.assert_ok();
        p.ok(&[deleg_ix(a, validator)]);
        let game = pda::vrf_game(&a);
        let bytes = p.get(&game).unwrap().data;
        p.er_game(game, bytes);
        p.set_account(ids::ORACLE_QUEUE, oracle_queue_er());
        // ONE ER tx: request a reveal, then commit + undelegate before the oracle can answer.
        let d = p.run(&[
            ix::RevealRequestVrf { session: a, game, ..Default::default() }.ix(5, 9),
            ix::SettleAndUndelegateVrf { payer: a, game, ..Default::default() }.ix(),
        ]);
        assert!(d.anchor.ok(), "inherited: Anchor commits PLAYING + pending\n{}", d.report());
        // INTENDED: F3. The port refuses the undelegate of a pending game; the whole tx reverts.
        assert_eq!(d.port.code(), Some(6044), "{}", d.report());
        let g = p.port.get_account(&game).unwrap();
        assert_eq!((g.owner, g.data[8], g.data[79]), (PROGRAM_ID, 0, 0), "port: still on the ER, PLAYING, no pending");
        attackers.push((a, bet));
    }
    assert!(attackers.len() >= 10, "{} attackers", attackers.len());
    let frozen = outstanding(&p);
    println!("challenge F3: {} games, outstanding {frozen} of assets {}", attackers.len(), assets(&p));

    // Relay idle threshold (5 min) passed: the house force crank clears every game on the port.
    p.warp(START_SLOT + 1_000);
    for (a, bet) in &attackers {
        let d = p.run(&[force_ix(w.house, *a)]);
        assert!(d.port.ok(), "{}", d.report());
        assert_eq!(p.port.get_account(&pda::vrf_game(a)).unwrap().data[8], 3, "VOID");
        undelegate_port(&mut p, *a);
        let before = p.port.get_account(a).unwrap().lamports;
        let d = p.run(&[refund_ix(w.house, *a)]);
        assert!(d.port.ok(), "{}", d.report());
        assert!(p.port.get_account(a).unwrap().lamports >= before + bet, "bet refunded");
    }
    assert_eq!(outstanding(&p), 0, "every reservation released on the port");
    let honest = p.user("honest");
    let d = p.run(&[start_ix(honest, 200_000_000)]);
    assert!(d.port.ok(), "honest play resumes on the port\n{}", d.report());
}

#[test]
fn challenge_f3_reversed_order_cannot_commit_pending() {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    let a = p.user("attacker");
    let game = pda::vrf_game(&a);
    p.ok(&[start_ix(a, 10_000_000)]);
    p.ok(&[deleg_ix(a, validator)]);
    let bytes = p.get(&game).unwrap().data;
    p.er_game(game, bytes);
    p.set_account(ids::ORACLE_QUEUE, oracle_queue_er());
    let d = p.run(&[
        ix::SettleAndUndelegateVrf { payer: a, game, ..Default::default() }.ix(),
        ix::RevealRequestVrf { session: a, game, ..Default::default() }.ix(5, 9),
    ]);
    assert!(d.anchor.ok(), "{}", d.report());
    // INTENDED: F3. The undelegate makes the game VOID first, so the request fails 6003 and the tx reverts.
    assert_eq!(d.port.code(), Some(6003), "{}", d.report());
    let g = p.port.get_account(&game).unwrap().data;
    assert_eq!((g[8], g[79]), (0, 0));
}
