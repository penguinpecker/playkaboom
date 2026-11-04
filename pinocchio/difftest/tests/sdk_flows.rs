//! The TypeScript SDK's instructions (packages/sdk, what apps/web sends) against the port .so.
//!
//! `fixtures/sdk_ixs.txt` is written by `sdk_fixture.ts` (`npx tsx pinocchio/difftest/sdk_fixture.ts`
//! from the repo root) for the same keys this harness uses (`key(label)`, `DEPLOYER`). Two checks:
//! 1. every SDK instruction is byte-identical (program id, account metas, data) to the IDL builder
//!    (Anchor-era instructions) or to FIXES.md (the two appended ones);
//! 2. the SDK bytes run through the main relaunch flows and the port accepts them.
//!
//! Where a flow uses a port-only behaviour (expire_game, force_undelegate_vrf, unsigned
//! complete_withdraw, the F4 window) the Anchor side is expected to differ, so only `d.port` is checked
//! and the test reads state with `p.port.get_account`.
use difftest::*;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, str::FromStr};

const SOL: u64 = LAMPORTS_PER_SOL;

fn unhex(s: &str) -> Vec<u8> {
    if s == "-" {
        return vec![];
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn sdk() -> HashMap<String, Instruction> {
    let text = std::fs::read_to_string(fixture("sdk_ixs.txt")).expect("run sdk_fixture.ts first");
    text.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| {
            let f: Vec<&str> = l.split(' ').collect();
            let accounts = f[3]
                .split(',')
                .map(|m| {
                    let p: Vec<&str> = m.split(':').collect();
                    let k = Address::from_str(p[0]).unwrap();
                    match p[1] {
                        "W" => AccountMeta::new(k, p[2] == "S"),
                        _ => AccountMeta::new_readonly(k, p[2] == "S"),
                    }
                })
                .collect();
            (f[0].to_string(), Instruction { program_id: Address::from_str(f[1]).unwrap(), accounts, data: unhex(f[2]) })
        })
        .collect()
}

fn get(m: &HashMap<String, Instruction>, name: &str) -> Instruction {
    m.get(name).unwrap_or_else(|| panic!("{name} missing from sdk_ixs.txt")).clone()
}

fn sha8(name: &str) -> Vec<u8> { Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec() }

fn assert_ix_eq(name: &str, sdk: &Instruction, want: &Instruction) {
    assert_eq!(sdk.program_id, want.program_id, "{name}: program id");
    assert_eq!(sdk.data, want.data, "{name}: data");
    let m = |i: &Instruction| i.accounts.iter().map(|a| (a.pubkey, a.is_writable, a.is_signer)).collect::<Vec<_>>();
    assert_eq!(m(sdk), m(want), "{name}: account metas (pubkey, writable, signer)");
}

/// Keys of the flows (same labels as sdk_fixture.ts).
struct K {
    house: Address,
    treasury: Address,
    validator: Address,
    referrer: Address,
    player: Address,
    player2: Address,
    player3: Address,
    legacy: Address,
    lp: Address,
    session: Address,
    session2: Address,
}
fn k() -> K {
    K {
        house: key("house"), treasury: key("treasury"), validator: key("validator"), referrer: key("referrer"),
        player: key("player"), player2: key("player2"), player3: key("player3"), legacy: key("legacy"), lp: key("lp"),
        session: key("session"), session2: key("session2"),
    }
}

#[test]
fn sdk_builders_byte_exact() {
    let s = sdk();
    let k = k();
    let (p1, p2, p3) = (k.player, k.player2, k.player3);
    let want: Vec<(&str, Instruction)> = vec![
        ("initialize_vault", ix::InitializeVault { house_authority: k.house, treasury: k.treasury, owner: DEPLOYER, ..Default::default() }.ix(100, 100, 1_000)),
        ("fund_vault", ix::FundVault { funder: DEPLOYER, ..Default::default() }.ix(50 * SOL)),
        ("initialize_v2", ix::InitializeV2 { owner: DEPLOYER, ..Default::default() }.ix()),
        ("enable_vrf", ix::UpdateV2Config { owner: DEPLOYER, ..Default::default() }.ix(None, None, None, None, None, Some(true), Some(k.validator), Some(1_000))),
        ("set_referrer", ix::SetReferrer { player_stats: pda::stats(&p1), referrer: k.referrer, referral_account: pda::referral(&k.referrer), player: p1, ..Default::default() }.ix()),
        ("start_game_vrf", ix::StartGameVrf { player: p1, claim: pda::vrf_claim(&p1), game: pda::vrf_game(&p1), player_stats: pda::stats(&p1), ..Default::default() }.ix(1, 10_000_000, k.session)),
        ("delegate_vrf", delegate_vrf_ix(p1)),
        ("reveal_request_vrf", ix::RevealRequestVrf { session: k.session, game: pda::vrf_game(&p1), ..Default::default() }.ix(5, 9)),
        ("cash_out_vrf", ix::CashOutVrf { signer: k.session, game: pda::vrf_game(&p1) }.ix()),
        ("settle_and_undelegate_vrf", ix::SettleAndUndelegateVrf { payer: k.session, game: pda::vrf_game(&p1), ..Default::default() }.ix()),
        ("settle_vrf_referred", {
            let mut i = ix::SettleVrf { payer: k.house, player: p1, claim: pda::vrf_claim(&p1), game: pda::vrf_game(&p1), treasury: k.treasury, player_stats: pda::stats(&p1), ..Default::default() }.ix();
            i.accounts.push(AccountMeta::new(pda::referral(&k.referrer), false));
            i
        }),
        ("start_game_vrf_2", ix::StartGameVrf { player: p2, claim: pda::vrf_claim(&p2), game: pda::vrf_game(&p2), player_stats: pda::stats(&p2), ..Default::default() }.ix(1, 10_000_000, k.session2)),
        ("refund_stalled_vrf_2", ix::RefundStalledVrf { caller: k.house, player: p2, claim: pda::vrf_claim(&p2), game: pda::vrf_game(&p2), ..Default::default() }.ix()),
        ("delegate_vrf_3", delegate_vrf_ix(p3)),
        ("refund_stalled_vrf_3", ix::RefundStalledVrf { caller: k.house, player: p3, claim: pda::vrf_claim(&p3), game: pda::vrf_game(&p3), ..Default::default() }.ix()),
        ("lp_deposit", ix::LpDeposit { position: pda::lp(&k.lp), user: k.lp, ..Default::default() }.ix(SOL)),
        ("request_withdraw", ix::RequestWithdraw { position: pda::lp(&k.lp), user: k.lp, ..Default::default() }.ix(500_000_000)),
        ("complete_withdraw_signed", ix::CompleteWithdraw { position: pda::lp(&k.lp), user: k.lp, ..Default::default() }.ix()),
        ("complete_withdraw_unsigned", {
            let mut i = ix::CompleteWithdraw { position: pda::lp(&k.lp), user: k.lp, ..Default::default() }.ix();
            i.accounts[3].is_signer = false; // F4: the user no longer signs
            i
        }),
        ("cancel_withdraw", ix::CancelWithdraw { position: pda::lp(&k.lp), user: k.lp, ..Default::default() }.ix()),
        // FIXES.md 3.1: expire_game, accounts vault W, v2 W, game W, player W (not signer), no args.
        ("expire_game", Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(ids::VAULT, false), AccountMeta::new(ids::V2_STATE, false), AccountMeta::new(pda::game(&k.legacy), false), AccountMeta::new(k.legacy, false)],
            data: vec![0xd0, 0x15, 0x57, 0x83, 0xf2, 0x2b, 0xfc, 0x90],
        }),
        // FIXES.md 4.1: force_undelegate_vrf, accounts house WS, game W, magic_program, magic_context W, vault.
        ("force_undelegate_vrf_3", Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(k.house, true), AccountMeta::new(pda::vrf_game(&p3), false), AccountMeta::new_readonly(ids::MAGIC_PROGRAM, false), AccountMeta::new(ids::MAGIC_CONTEXT, false), AccountMeta::new_readonly(ids::VAULT, false)],
            data: vec![0xda, 0x30, 0xa3, 0xda, 0x54, 0xf8, 0xe4, 0x65],
        }),
    ];
    for (name, w) in &want {
        assert_ix_eq(name, &get(&s, name), w);
    }
    assert_eq!(sha8("expire_game"), get(&s, "expire_game").data);
    assert_eq!(sha8("force_undelegate_vrf"), get(&s, "force_undelegate_vrf_3").data);
    assert_eq!(want.len(), 22);
}

/// Vault bootstrap from SDK bytes (deployer-signed initialize_vault, F1), then VRF armed.
fn sdk_world(p: &mut Pair, s: &HashMap<String, Instruction>) {
    p.deployer();
    for u in ["house", "treasury"] {
        p.user(u);
    }
    for name in ["initialize_vault", "fund_vault", "initialize_v2", "enable_vrf"] {
        p.run(&[get(s, name)]).assert_ok();
    }
}

/// The web start tx [set_referrer, start_game_vrf, fund session, delegate_vrf] in ONE tx, a reveal on
/// the ER, commit + undelegate, then the house's settle_vrf with the referral PDA (F5).
#[test]
fn sdk_start_delegate_settle_with_referral() {
    let s = sdk();
    let k = k();
    let mut p = Pair::new();
    sdk_world(&mut p, &s);
    p.user("player");
    let game = pda::vrf_game(&k.player);
    let d = p.run(&[get(&s, "set_referrer"), get(&s, "start_game_vrf"), get(&s, "fund_session"), get(&s, "delegate_vrf")]);
    d.assert_ok().assert_cpi_same();
    assert!(d.port.cu < CLIENT_CU_LIMIT, "start tx CU {}", d.port.cu);
    assert_eq!(p.get(&game).unwrap().owner, ids::DLP, "delegated in the same tx");
    assert_eq!(p.lamports(&k.session), 2_000_000, "session key funded in the start tx");
    assert_eq!(p.read(&pda::stats(&k.player), accounts::PlayerStats::decode).referrer, Some(k.referrer));

    // ER view: the rollup clones the delegated game program-owned.
    let l1 = p.get(&game).unwrap();
    p.er_game(game, l1.data.clone());
    p.run(&[get(&s, "reveal_request_vrf")]).assert_ok().assert_cpi_same();
    p.run(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix([42u8; 32])]).assert_ok();
    if p.read(&game, accounts::VrfGame::decode).status == 0 {
        p.run(&[get(&s, "cash_out_vrf")]).assert_ok();
    }
    p.run(&[get(&s, "settle_and_undelegate_vrf")]).assert_ok().assert_cpi_same();
    // L1: the DLP hands the ER bytes back through process_undelegation (faked as in smoke.rs).
    let er = p.get(&game).unwrap().data;
    let buffer = pda::undelegate_buffer(&game);
    p.set_account(game, Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    p.set_data(buffer, ids::DLP, er);
    let payer = p.user("dlp-payer");
    let mut u = ix::ProcessUndelegation { base_account: game, buffer, payer, ..Default::default() }
        .ix(vec![b"kaboom_vrf_game".to_vec(), k.player.as_ref().to_vec()]);
    u.accounts[1].is_signer = true;
    u.accounts[2].is_signer = true;
    p.run(&[u]).assert_ok();

    // F5: the same settle without the referral PDA is refused by the port (simulated, no state change),
    // which is why the server must never treat an RPC error as "no referrer".
    let mut no_ref = get(&s, "settle_vrf_referred");
    no_ref.accounts.pop();
    let tx = solana_transaction::Transaction::new_unsigned(solana_message::Message::new(&[no_ref], Some(&p.payer)));
    match p.port.simulate_transaction(tx) {
        Err(f) => assert_eq!(f.err, TransactionError::InstructionError(0, InstructionError::Custom(6022))),
        Ok(_) => panic!("port settled a referred game without the referral PDA"),
    }

    let before = p.read(&pda::referral(&k.referrer), accounts::ReferralAccount::decode).accrued_lamports;
    let d = p.run(&[get(&s, "settle_vrf_referred")]);
    d.assert_ok();
    let after = p.read(&pda::referral(&k.referrer), accounts::ReferralAccount::decode).accrued_lamports;
    assert!(after > before, "referrer accrued its cut ({before} -> {after})");
    assert!(p.get(&pda::vrf_claim(&k.player)).is_none_or(|a| a.lamports == 0), "claim closed");
}

/// Cron 9.3.c': a start that never reached the rollup, refunded by the house after the stall window.
#[test]
fn sdk_refund_never_delegated() {
    let s = sdk();
    let k = k();
    let mut p = Pair::new();
    sdk_world(&mut p, &s);
    p.user("player2");
    p.run(&[get(&s, "start_game_vrf_2")]).assert_ok();
    let bal = p.lamports(&k.player2);
    p.warp(p.slot() + 150);
    p.run_as(k.house, &[get(&s, "refund_stalled_vrf_2")]).assert_ok();
    assert_eq!(p.lamports(&k.player2), bal + 10_000_000 + rent_min(accounts::VrfGame::SPACE) + rent_min(accounts::VrfClaim::SPACE),
        "bet + game and claim rent back to the player");
}

/// Cron 9.3.b + c: the house force-undelegates an idle zero-progress game on the ER (VOID, port only),
/// then refunds the VOID game on L1.
#[test]
fn sdk_force_undelegate_then_void_refund() {
    let s = sdk();
    let k = k();
    let mut p = Pair::new();
    sdk_world(&mut p, &s);
    p.user("player3");
    p.run(&[get(&s, "start_game_vrf_3"), get(&s, "delegate_vrf_3")]).assert_ok();
    let game = pda::vrf_game(&k.player3);
    let l1 = p.get(&game).unwrap();
    p.er_game(game, l1.data.clone());

    let d = p.run_as(k.house, &[get(&s, "force_undelegate_vrf_3")]);
    assert_eq!(d.anchor.code(), Some(101), "new instruction: Anchor has no handler");
    assert!(d.port.ok(), "port rejected the SDK force: {}", d.port.logs.join("\n"));
    assert_eq!(d.port.ix_lines, ["Program log: Instruction: ForceUndelegateVrf"]);
    let g = accounts::VrfGame::decode(&p.port.get_account(&game).unwrap().data).unwrap();
    assert_eq!(g.status, 3, "zero progress -> VOID");

    // The shared VM already shows the game program-owned (as after the ER commit).
    p.warp(p.slot() + 30);
    let bal = p.port.get_account(&k.player3).unwrap().lamports;
    let d = p.run_as(k.house, &[get(&s, "refund_stalled_vrf_3")]);
    assert!(d.port.ok(), "VOID refund failed on the port: {}", d.port.logs.join("\n"));
    assert!(p.port.get_account(&k.player3).unwrap().lamports >= bal + 10_000_000, "bet refunded");
}

/// Cron 9.3.d: a stray legacy game (Anchor starts it; the port mirrors, VRF-only) expired by anyone.
#[test]
fn sdk_expire_legacy_game() {
    let s = sdk();
    let k = k();
    let mut p = Pair::new();
    sdk_world(&mut p, &s);
    p.user("legacy");
    let game = p.start_game(k.legacy, 1, 10_000_000, 0b100, [7; 32]);
    p.warp(p.slot() + 301);
    let bal = p.lamports(&k.legacy);
    let d = p.run(&[get(&s, "expire_game")]);
    assert_eq!(d.anchor.code(), Some(101));
    assert!(d.port.ok(), "{}", d.port.logs.join("\n"));
    let g = accounts::GameSession::decode(&p.port.get_account(&game).unwrap().data).unwrap();
    assert!(matches!(g.status, accounts::GameStatus::Expired), "refund branch: Expired");
    assert_eq!(p.port.get_account(&k.legacy).unwrap().lamports, bal + 10_000_000, "full bet refunded");
}

fn lp_requested(p: &mut Pair, s: &HashMap<String, Instruction>) -> u64 {
    sdk_world(p, s);
    p.user("lp");
    p.run(&[get(s, "lp_deposit")]).assert_ok();
    p.run(&[get(s, "request_withdraw")]).assert_ok();
    p.read(&pda::lp(&key("lp")), accounts::LpPosition::decode).pending_unlock_slot
}

/// Cron 9.3.f: the house completes a matured withdrawal without the LP's signature (F4, port only).
#[test]
fn sdk_lp_complete_unsigned_by_keeper() {
    let s = sdk();
    let k = k();
    let mut p = Pair::new();
    let unlock = lp_requested(&mut p, &s);
    p.warp(unlock);
    let bal = p.lamports(&k.lp);
    let d = p.run_as(k.house, &[get(&s, "complete_withdraw_unsigned")]);
    assert_eq!(d.anchor.code(), Some(3010), "Anchor needs the user's signature");
    assert!(d.port.ok(), "{}", d.port.logs.join("\n"));
    let pos = accounts::LpPosition::decode(&p.port.get_account(&pda::lp(&k.lp)).unwrap().data).unwrap();
    assert_eq!(pos.pending_units, 0);
    assert!(p.port.get_account(&k.lp).unwrap().lamports > bal, "paid to position.user");
}

/// UI expired state: after unlock + 9,000 the completion fails 6056; RESTART = [cancel, request(same
/// units)] in one tx is accepted and starts a new cooldown.
#[test]
fn sdk_lp_restart_after_window() {
    let s = sdk();
    let k = k();
    let mut p = Pair::new();
    let unlock = lp_requested(&mut p, &s);
    p.warp(unlock + 9_001);
    let d = p.run(&[get(&s, "complete_withdraw_signed")]);
    assert!(d.anchor.ok());
    assert_eq!(d.port.code(), Some(6056), "WithdrawWindowExpired");
    let d = p.run(&[get(&s, "cancel_withdraw"), get(&s, "request_withdraw")]);
    assert!(d.port.ok(), "{}", d.port.logs.join("\n"));
    let pos = accounts::LpPosition::decode(&p.port.get_account(&pda::lp(&k.lp)).unwrap().data).unwrap();
    assert_eq!(pos.pending_units, 500_000_000);
    assert!(pos.pending_unlock_slot > unlock + 9_001, "new cooldown");
}
