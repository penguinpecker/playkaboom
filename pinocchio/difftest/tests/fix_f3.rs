//! F3 (MB-1): house-only ER instruction `force_undelegate_vrf` closes an idle delegated game EV-neutrally
//! (progress -> WON, none -> VOID = 3) and schedules commit + undelegate; `refund_stalled_vrf` also
//! accepts VOID. Anchor has neither (101 / 6050), so those txs are INTENDED divergences.
//! Pattern: the program-owned game is the ER view; after a force, `sync` copies the port's game to both
//! sides (the commit that lands on L1), so later existing-instruction txs are compared again.
//! See spec/FIXES.md section 4 and design-F3.md section 7.
use accounts::{VrfGame, VaultV2State};
use difftest::*;

const BET: u64 = 10_000_000;
const DISC: [u8; 8] = [0xda, 0x30, 0xa3, 0xda, 0x54, 0xf8, 0xe4, 0x65];
/// `SCHEDULE_CAU_GAME` (vrf.rs): ScheduleIntentBundle, commit_and_undelegate the game at index 2.
const CAU: [u8; 33] = [11, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

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
        data: DISC.to_vec(),
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
fn settle_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury, player_stats: pda::stats(&player), ..Default::default() }.ix()
}
fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    rem != 0 && u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
fn reveal(p: &mut Pair, game: Address, tile: u8, mine: bool) {
    let g = p.get(&game).unwrap().data;
    let r = (0..=255u8).map(|b| [b; 32]).find(|r| is_mine(r, g[77], g[74]) == mine).unwrap();
    p.patch(game, |d| { d[79] = 1; d[80] = tile; });
    p.ok(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(r)]);
}
/// Run a force on both: Anchor 101, returns the port outcome.
fn force(p: &mut Pair, house: Address, player: Address) -> Outcome {
    let d = p.run(&[force_ix(house, player)]);
    assert_eq!(d.anchor.code(), Some(101), "Anchor has no force_undelegate_vrf");
    d.port
}
fn port_game(p: &Pair, player: &Address) -> Account { p.port.get_account(&pda::vrf_game(player)).unwrap() }
/// The committed ER state lands on L1: copy the port's game to both sides.
fn sync(p: &mut Pair, player: &Address) {
    let g = port_game(p, player);
    p.set_account(pda::vrf_game(player), g);
}
/// Fake the DLP undelegation with `bytes` (game, record, metadata emptied; process_undelegation on both).
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
fn lam(p: &Pair, k: &Address) -> u64 { p.port.get_account(k).map(|a| a.lamports).unwrap_or(0) }
fn outstanding(p: &Pair) -> u64 { VaultV2State::decode(&p.port.get_account(&ids::V2_STATE).unwrap().data).unwrap().total_outstanding_max_payout }

fn world() -> (Pair, World, Address) {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    (p, w, validator)
}
/// Start + delegate, then the ER view (program-owned copy of the DLP-held bytes).
fn delegated(p: &mut Pair, player: Address, validator: Address, bet: u64) {
    p.ok(&[start_ix(player, bet)]);
    p.ok(&[deleg_ix(player, validator)]);
    let game = pda::vrf_game(&player);
    let bytes = p.get(&game).unwrap().data;
    p.er_game(game, bytes);
}

#[test]
fn f3_force_zero_progress_voids_then_refunds() {
    let (mut p, w, validator) = world();
    let player = p.user("player");
    delegated(&mut p, player, validator, BET);
    let game = pda::vrf_game(&player);
    let o = force(&mut p, w.house, player);
    assert!(o.ok(), "{}", o.logs.join("\n"));
    assert_eq!(port_game(&p, &player).data[8], 3, "VOID");
    let cpi = o.cpis.iter().find(|c| c.program == ids::MAGIC_PROGRAM).expect("magic CPI");
    assert_eq!((cpi.data.as_slice(), cpi.accounts.as_slice()), (&CAU[..], &[w.house, ids::MAGIC_CONTEXT, game][..]));
    let bytes = port_game(&p, &player).data;
    undelegate(&mut p, player, bytes);
    // VOID can never re-enter play (identical on both)
    p.run(&[deleg_ix(player, validator)]).assert_err(6050);
    p.run(&[ix::CashOutVrf { signer: player, game }.ix()]).assert_err(6003);
    p.run(&[settle_ix(w.house, player, w.treasury)]).assert_err(6003);
    p.warp(START_SLOT + 26);
    let (pl, game_rent, claim_rent) = (lam(&p, &player), lam(&p, &game), lam(&p, &pda::vrf_claim(&player)));
    let d = p.run(&[refund_ix(w.house, player)]);
    assert_eq!(d.anchor.code(), Some(6050), "Anchor refuses status 3");
    assert!(d.port.ok(), "{}", d.report());
    assert_eq!(lam(&p, &player) - pl, BET + game_rent + claim_rent);
    assert_eq!(outstanding(&p), 0);
    assert_eq!((lam(&p, &game), lam(&p, &pda::vrf_claim(&player))), (0, 0), "claim and game closed");
}

/// Forced WON pays exactly what the player's own cash_out_vrf + settle pays.
#[test]
fn f3_force_with_progress_pays_cash_out() {
    let play = |forced: bool| -> (u64, accounts::PlayerStats) {
        let (mut p, w, _) = world();
        let player = p.user("player");
        p.ok(&[start_ix(player, BET)]);
        let game = pda::vrf_game(&player);
        reveal(&mut p, game, 3, false);
        reveal(&mut p, game, 4, false);
        let mult = p.read(&game, VrfGame::decode).multiplier_bps;
        if forced {
            assert!(force(&mut p, w.house, player).ok());
            let g = VrfGame::decode(&port_game(&p, &player).data).unwrap();
            assert_eq!((g.status, g.multiplier_bps), (1, mult), "WON at the current multiplier");
            sync(&mut p, &player);
        } else {
            p.ok(&[ix::CashOutVrf { signer: player, game }.ix()]);
        }
        let pl = p.lamports(&player);
        p.ok(&[settle_ix(w.house, player, w.treasury)]);
        (p.lamports(&player) - pl, p.read(&pda::stats(&player), accounts::PlayerStats::decode))
    };
    let (forced, control) = (play(true), play(false));
    assert_eq!(forced.0, control.0);
    assert_eq!(forced.1, control.1);
}

#[test]
fn f3_force_terminal_unchanged() {
    for lose in [true, false] {
        let (mut p, w, _) = world();
        let player = p.user("player");
        p.ok(&[start_ix(player, BET)]);
        let game = pda::vrf_game(&player);
        if lose { reveal(&mut p, game, 3, true); } else { for t in 0..15 { reveal(&mut p, game, t, false); } }
        let before = p.get(&game).unwrap().data;
        assert_eq!(before[8], if lose { 2 } else { 1 });
        assert!(force(&mut p, w.house, player).ok());
        assert_eq!(port_game(&p, &player).data, before, "terminal game bytes unchanged");
        let pl = p.lamports(&player);
        p.ok(&[settle_ix(w.house, player, w.treasury)]);
        let gain = p.lamports(&player) - pl;
        if lose { assert!(gain < BET, "loss booked: only rents back"); } else { assert!(gain > BET * 15, "full clear paid"); }
    }
}

#[test]
fn f3_force_pending_rejected() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    p.ok(&[start_ix(player, BET)]);
    let game = pda::vrf_game(&player);
    p.patch(game, |d| { d[79] = 1; d[80] = 3; });
    assert_eq!(force(&mut p, w.house, player).code(), Some(6044));
    let r = (0..=255u8).map(|b| [b; 32]).find(|r| !is_mine(r, 0, 1)).unwrap();
    p.ok(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(r)]);
    assert!(force(&mut p, w.house, player).ok());
    assert_eq!(port_game(&p, &player).data[8], 1);
}

#[test]
fn f3_force_auth_and_accounts() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    let session = p.user("session");
    p.ok(&[ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), player_stats: pda::stats(&player), ..Default::default() }
        .ix(1, BET, session)]);
    let game = pda::vrf_game(&player);
    let stranger = p.user("stranger");
    let fake_vault = key("fake-vault");
    p.set_account(fake_vault, p.get(&ids::VAULT).unwrap());
    let fake_game = key("fake-game");
    p.set_account(fake_game, p.get(&game).unwrap());
    let dlp_player = p.user("dlp-player");
    p.ok(&[start_ix(dlp_player, BET)]);
    let dg = pda::vrf_game(&dlp_player);
    let dbytes = p.get(&dg).unwrap().data;
    p.set_data(dg, ids::DLP, dbytes);
    let h = w.house;
    let cases: Vec<(&str, Instruction, u32)> = vec![
        ("stranger", force_ix(stranger, player), 6007),
        ("player", force_ix(player, player), 6007),
        ("session", force_ix(session, player), 6007),
        ("house unsigned", { let mut i = force_ix(h, player); i.accounts[0].is_signer = false; i }, 3010),
        ("house readonly", { let mut i = force_ix(h, player); i.accounts[0].is_writable = false; i }, 2000),
        ("game readonly", { let mut i = force_ix(h, player); i.accounts[1].is_writable = false; i }, 2000),
        ("magic_context readonly", { let mut i = force_ix(h, player); i.accounts[3].is_writable = false; i }, 2000),
        ("wrong magic_context", { let mut i = force_ix(h, player); i.accounts[3].pubkey = key("ctx"); i }, 2012),
        ("magic_program = VRF", { let mut i = force_ix(h, player); i.accounts[2].pubkey = ids::VRF_PROGRAM; i }, 3008),
        ("fake vault", { let mut i = force_ix(h, player); i.accounts[4].pubkey = fake_vault; i }, 2006),
        ("fake game", { let mut i = force_ix(h, player); i.accounts[1].pubkey = fake_game; i }, 2006),
        ("claim as game", { let mut i = force_ix(h, player); i.accounts[1].pubkey = pda::vrf_claim(&player); i }, 3002),
        ("DLP-owned game (L1 view)", force_ix(h, dlp_player), 3007),
        ("4 accounts", { let mut i = force_ix(h, player); i.accounts.truncate(4); i }, 3005),
    ];
    for (name, i, code) in cases {
        let d = p.run(&[i]);
        assert_eq!(d.anchor.code(), Some(101));
        assert_eq!(d.port.code(), Some(code), "{name}: {}", fmt_err(&d.port.err));
    }
    assert_eq!(port_game(&p, &player).data[8], 0, "nothing forced");
    // house_authority rotation (vault offset 40): the old key fails, the new one passes
    let new_house = p.user("new-house");
    p.patch(ids::VAULT, |d| d[40..72].copy_from_slice(new_house.as_ref()));
    assert_eq!(force(&mut p, h, player).code(), Some(6007));
    assert!(force(&mut p, new_house, player).ok());
}

#[test]
fn f3_force_void_idempotent() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    p.ok(&[start_ix(player, BET)]);
    assert!(force(&mut p, w.house, player).ok());
    sync(&mut p, &player);
    assert!(force(&mut p, w.house, player).ok());
    assert_eq!(port_game(&p, &player).data[8], 3);
}

#[test]
fn f3_player_refunds_own_void() {
    let (mut p, w, validator) = world();
    let player = p.user("player");
    delegated(&mut p, player, validator, BET);
    assert!(force(&mut p, w.house, player).ok());
    let bytes = port_game(&p, &player).data;
    undelegate(&mut p, player, bytes);
    p.warp(START_SLOT + 26);
    let pl = lam(&p, &player);
    let d = p.run(&[refund_ix(player, player)]);
    assert_eq!(d.anchor.code(), Some(6050));
    assert!(d.port.ok(), "{}", d.report());
    assert!(lam(&p, &player) - pl > BET);
}

/// Status 3 patched on both sides: Anchor refuses the refund (6050), the port pays it.
#[test]
fn f3_refund_void_status_diverges() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    p.ok(&[start_ix(player, BET)]);
    p.patch(pda::vrf_game(&player), |d| d[8] = 3);
    p.warp(START_SLOT + 26);
    let d = p.run(&[refund_ix(w.house, player)]);
    assert_eq!(d.anchor.code(), Some(6050));
    assert!(d.port.ok(), "{}", d.report());
}

#[test]
fn f3_force_cu() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    p.ok(&[start_ix(player, BET)]);
    let sau = p.run(&[ix::SettleAndUndelegateVrf { payer: player, game: pda::vrf_game(&player), ..Default::default() }.ix()]);
    // INTENDED: F3 round 2. The port VOIDs the PLAYING game before undelegating; Anchor commits it as-is.
    assert!(sau.anchor.ok() && sau.port.ok(), "{}", sau.report());
    sau.assert_cpi_same();
    let o = force(&mut p, w.house, player);
    assert!(o.ok());
    println!("CU force_undelegate_vrf: port {} | settle_and_undelegate_vrf: port {}", o.cu, sau.port.cu);
    assert!(o.cu < CLIENT_CU_LIMIT && o.cu <= sau.port.cu + 3_000);
}

/// MB-1 repro (audit_magicblock.rs::mb1_idle_delegated_games_pin_bankroll), cleared by the house crank.
#[test]
fn f3_mb1_cleared() {
    let (mut p, w, validator) = world();
    let assets = |p: &Pair| lam(p, &ids::VAULT) - rent_min(accounts::Vault::SPACE);
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
        attackers.push(a);
    }
    assert!(attackers.len() >= 10);
    let honest = p.user("honest");
    p.run(&[start_ix(honest, 200_000_000)]).assert_failed();
    p.warp(START_SLOT + 1_000);
    for (n, a) in attackers.iter().enumerate() {
        let game = pda::vrf_game(a);
        let bytes = p.get(&game).unwrap().data;
        p.er_game(game, bytes);
        assert!(force(&mut p, w.house, *a).ok());
        let bytes = port_game(&p, a).data;
        undelegate(&mut p, *a, bytes);
        if n == 0 { p.run(&[deleg_ix(*a, validator)]).assert_err(6050); }
        let d = p.run(&[refund_ix(w.house, *a)]);
        assert!(d.port.ok(), "{}", d.report());
    }
    assert_eq!(outstanding(&p), 0);
    assert!(p.run(&[start_ix(honest, 200_000_000)]).port.ok(), "VRF play unfrozen");
    let lg = p.user("legacy");
    let d = p.run(&[ix::StartGame { game: pda::game(&lg), player_stats: pda::stats(&lg), player: lg, ..Default::default() }
        .ix(1, 200_000_000, commitment(0b100, 1, &[7; 32]))]);
    d.vrf_only(); // INTENDED: VRF-only. Legacy play stays off on the port (was: "legacy play unfrozen").
}
