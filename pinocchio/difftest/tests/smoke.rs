//! One happy-path smoke test per spec group: proves the harness runs both builds with zero diffs.
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;

fn cu(tag: &str, d: &Diff) {
    let (a, p) = d.cu();
    println!("CU {tag}: anchor {a} port {p}");
}

/// Deploy gate: sbpf (agave 3.x and 4.x) rejects any ELF whose EI_OSABI byte is not 0 ("wrong ABI").
#[test]
fn port_elf_is_deployable() {
    for so in [anchor_so(), port_so()] {
        let b = std::fs::read(&so).unwrap();
        assert_eq!(b[7], 0, "{so}: EI_OSABI = {} (must be 0 / ELFOSABI_NONE, else the loader refuses it)", b[7]);
    }
}

#[test]
fn vault_admin_initialize_and_fund() {
    let mut p = Pair::new();
    let owner = p.deployer();
    let (house, treasury) = (key("house"), key("treasury"));
    let d = p.run(&[ix::InitializeVault { house_authority: house, treasury, owner, ..Default::default() }.ix(100, 100, 1_000)]);
    d.assert_ok();
    cu("initialize_vault", &d);
    let d = p.run(&[ix::FundVault { funder: owner, ..Default::default() }.ix(5 * SOL)]);
    d.assert_ok();
    cu("fund_vault", &d);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: FundVault"]);
    assert_eq!(d.anchor.events.len(), 1);
    let v = p.read(&ids::VAULT, accounts::Vault::decode);
    assert_eq!((v.owner, v.house_authority, v.treasury, v.bump, v.house_edge_bps), (owner, house, treasury, 254, 100));
    assert_eq!(p.lamports(&ids::VAULT), rent_min(accounts::Vault::SPACE) + 5 * SOL);
    // a second init must fail the same way on both
    p.run(&[ix::InitializeVault { house_authority: house, treasury, owner, ..Default::default() }.ix(100, 100, 1_000)]).assert_failed();
}

#[test]
fn v2_lp_initialize_and_deposit() {
    let mut p = Pair::new();
    p.house_world();
    let user = p.user("lp");
    let d = p.run(&[ix::LpDeposit { position: pda::lp(&user), user, ..Default::default() }.ix(SOL)]);
    d.assert_ok();
    cu("lp_deposit", &d);
    let pos = p.read(&pda::lp(&user), accounts::LpPosition::decode);
    assert_eq!(pos.user, user);
    assert!(pos.units > 0);
    let v2 = p.read(&ids::V2_STATE, accounts::VaultV2State::decode);
    assert_eq!(v2.bump, 255);
}

#[test]
fn house_deposit() {
    let mut p = Pair::new();
    let w = p.house_world();
    let d = p.run(&[ix::HouseDeposit { owner: w.owner, ..Default::default() }.ix(2 * SOL)]);
    d.assert_ok();
    cu("house_deposit", &d);
    // non-owner fails identically
    let other = p.user("other");
    p.run(&[ix::HouseDeposit { owner: other, ..Default::default() }.ix(2 * SOL)]).assert_failed();
}

#[test]
fn legacy_game_start_reveal_cashout_settle() {
    let mut p = Pair::new();
    let w = p.house_world();
    let player = p.user("player");
    let (layout, salt) = (0b0000_0000_0000_0100u16, [7u8; 32]); // one mine, tile 2
    let game = p.start_game(player, 1, 10_000_000, layout, salt);
    let d = p.run(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(5, false)]);
    d.assert_ok();
    cu("reveal_tile", &d);
    let d = p.run(&[ix::CashOut { game, player, ..Default::default() }.ix()]);
    d.assert_ok();
    cu("cash_out", &d);
    let d = p.run(&[ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: w.treasury, ..Default::default() }
        .ix(layout, salt)]);
    d.assert_ok();
    cu("settle_game", &d);
    let g = p.read(&game, accounts::GameSession::decode);
    assert_eq!((g.status, g.settled, g.mine_layout), (accounts::GameStatus::Won, true, layout));
    let d = p.run(&[ix::CloseGame { game, player }.ix()]);
    d.assert_ok();
    assert!(p.get(&game).is_none_or(|a| a.lamports == 0));
}

#[test]
fn referral_set_referrer() {
    let mut p = Pair::new();
    let _w = p.house_world();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let d = p.run(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
    d.assert_ok();
    cu("set_referrer", &d);
    let s = p.read(&pda::stats(&player), accounts::PlayerStats::decode);
    assert_eq!(s.referrer, Some(referrer));
    let r = p.read(&pda::referral(&referrer), accounts::ReferralAccount::decode);
    assert_eq!(r.referred_count, 1);
}

#[test]
fn vrf_full_lifecycle() {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    let player = p.user("player");
    let session = p.user("session");
    let game = p.start_game_vrf(player, 1, 10_000_000, session);
    // L1: delegate through the real mainnet DLP
    let mut dix = delegate_vrf_ix(player);
    dix.accounts.push(AccountMeta::new_readonly(validator, false));
    let d = p.run(&[dix]);
    d.assert_ok().assert_cpi_same();
    cu("delegate_vrf", &d);
    let l1 = p.get(&game).unwrap();
    assert_eq!(l1.owner, ids::DLP);
    // ER: the rollup clones the game as program-owned
    p.er_game(game, l1.data.clone());
    let d = p.run(&[ix::RevealRequestVrf { session, game, ..Default::default() }.ix(5, 9)]);
    d.assert_ok().assert_cpi_same(); // real VRF program: request queued in the oracle queue
    cu("reveal_request_vrf", &d);
    // VRF callback, signed by the scoped identity PDA (sigverify off)
    let d = p.run(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix([42u8; 32])]);
    d.assert_ok();
    cu("reveal_callback_vrf", &d);
    let g = p.read(&game, accounts::VrfGame::decode);
    assert_eq!((g.reveal_count, g.pending, g.reveals[0].tile), (1, false, 5));
    if g.status == 0 {
        p.run(&[ix::CashOutVrf { signer: session, game }.ix()]).assert_ok();
    }
    // ER: commit + undelegate (Magic program = noop stand-in; CPI bytes compared)
    let d = p.run(&[ix::SettleAndUndelegateVrf { payer: session, game, ..Default::default() }.ix()]);
    d.assert_ok().assert_cpi_same();
    cu("settle_and_undelegate_vrf", &d);
    let er = p.get(&game).unwrap().data;
    // L1: the DLP drains the delegated game and CPIs process_undelegation with the ER bytes in its
    // canonical undelegate buffer. Fake that state and call it directly (buffer + payer sign: sigverify off).
    let buffer = pda::undelegate_buffer(&game);
    p.set_account(game, Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    p.set_data(buffer, ids::DLP, er.clone());
    let rent_payer = p.user("dlp-payer");
    let mut u = ix::ProcessUndelegation { base_account: game, buffer, payer: rent_payer, ..Default::default() }
        .ix(vec![b"kaboom_vrf_game".to_vec(), player.as_ref().to_vec()]);
    u.accounts[1].is_signer = true;
    u.accounts[2].is_signer = true;
    let d = p.run(&[u]);
    d.assert_ok().assert_cpi_same();
    cu("process_undelegation", &d);
    assert_eq!(p.get(&game).unwrap().data, er);
    // L1 settle
    let d = p.run(&[ix::SettleVrf { payer: session, player, claim: pda::vrf_claim(&player), game, treasury: w.treasury,
        player_stats: pda::stats(&player), ..Default::default() }.ix()]);
    d.assert_ok();
    cu("settle_vrf", &d);
    assert!(p.get(&game).is_none_or(|a| a.lamports == 0));
}

/// The harness must see a divergence: give the port's vault 1 extra lamport, then fund on both.
#[test]
fn harness_detects_diffs() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let mut v = p.port.get_account(&ids::VAULT).unwrap();
    v.lamports += 1;
    p.port.set_account(ids::VAULT, v).unwrap();
    let d = p.run(&[ix::FundVault { funder: w.owner, ..Default::default() }.ix(SOL)]);
    assert!(d.diffs.iter().any(|x| x.contains("lamports")), "{}", d.report());
    assert!(d.diffs.iter().any(|x| x.starts_with("event #0")), "{}", d.report());
}
