//! F2 (MONEY-1): permissionless `expire_game` pays an expired legacy game's player the better of their
//! own two exits and releases the reservation. Anchor has no such instruction (101), so every
//! `expire_game` tx is an INTENDED divergence; the port side is read directly. See spec/FIXES.md section 3.
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
fn sg_ix(player: Address, mines: u8, bet: u64, c: [u8; 32]) -> Instruction {
    ix::StartGame { game: pda::game(&player), player_stats: pda::stats(&player), player, ..Default::default() }.ix(mines, bet, c)
}
fn reveal(p: &mut Pair, w: &World, player: Address, tile: u8, mine: bool) {
    p.ok(&[ix::RevealTile { game: pda::game(&player), house_authority: w.house, ..Default::default() }.ix(tile, mine)]);
}
fn settle_ix(w: &World, player: Address, layout: u16, salt: [u8; 32]) -> Instruction {
    ix::SettleGame { game: pda::game(&player), player_stats: pda::stats(&player), house_authority: w.house, treasury: w.treasury,
        ..Default::default() }.ix(layout, salt)
}
/// Run on both; Anchor must answer 101 (no such instruction). Returns the port outcome.
fn expire(p: &mut Pair, cranker: Address, ixs: &[Instruction]) -> Outcome {
    let d = p.run_as(cranker, ixs);
    if ixs.iter().all(|i| i.data[..8] == DISC) {
        assert_eq!(d.anchor.code(), Some(101), "Anchor has no expire_game");
    }
    d.port
}
fn lam(p: &Pair, k: &Address) -> u64 { p.port.get_account(k).map(|a| a.lamports).unwrap_or(0) }
fn game(p: &Pair, player: &Address) -> GameSession { GameSession::decode(&p.port.get_account(&pda::game(player)).unwrap().data).unwrap() }
fn v2(p: &Pair) -> VaultV2State { VaultV2State::decode(&p.port.get_account(&ids::V2_STATE).unwrap().data).unwrap() }
fn set_lamports(p: &mut Pair, k: Address, lamports: u64) {
    let mut a = p.get(&k).unwrap();
    a.lamports = lamports;
    p.set_account(k, a);
}
fn status(g: &GameSession) -> u8 { g.status as u8 }

/// house_world + one 1-mine game (mine at tile 2) by "player"; returns (pair, world, player, cranker).
fn one_game() -> (Pair, World, Address, Address) {
    let mut p = Pair::new();
    let w = p.house_world();
    let player = p.user("player");
    p.start_game(player, 1, BET, 0b100, [7; 32]);
    let cranker = p.user("cranker");
    (p, w, player, cranker)
}

#[test]
fn f2_garbage_games_cleared_by_stranger() {
    let mut p = Pair::new();
    p.house_world();
    let garbage = [0xA5u8; 32];
    let mut griefers = vec![];
    for i in 0..200 {
        let a = p.user(&format!("griefer-{i}"));
        let landed = (1..=8u8).rev().any(|mines| {
            // INTENDED: VRF-only. Port 6057; Anchor's games are mirrored onto the port so expire_game has work.
            let d = p.run_legacy(&[sg_ix(a, mines, 1_000_000, garbage)]);
            d.anchor.ok()
        });
        if !landed { break; }
        griefers.push(a);
    }
    assert!(griefers.len() >= 10 && v2(&p).total_outstanding_max_payout > 0);
    let honest = p.user("honest");
    p.run_legacy(&[sg_ix(honest, 1, BET, commitment(0b100, 1, &[7; 32]))]).anchor_failed(); // frozen on Anchor; port 6057 (VRF-only)
    p.warp(p.slot() + 301);
    let cranker = p.user("cranker");
    for batch in griefers.chunks(10) {
        let before: Vec<u64> = batch.iter().map(|a| lam(&p, a)).collect();
        let ixs: Vec<_> = batch.iter().map(|a| expire_ix(*a)).collect();
        let o = expire(&mut p, cranker, &ixs);
        assert!(o.ok(), "{}", o.logs.join("\n"));
        for (a, b) in batch.iter().zip(before) { assert_eq!(lam(&p, a) - b, 1_000_000, "griefer gets exactly the bet"); }
    }
    assert_eq!(v2(&p).total_outstanding_max_payout, 0, "every reservation released");
    // INTENDED: VRF-only. Anchor stays frozen; the port is unfrozen (outstanding 0) but refuses legacy starts.
    // Not run_legacy: the sides diverged at expire_game, so nothing is mirrored.
    p.run(&[sg_ix(honest, 1, BET, commitment(0b100, 1, &[7; 32]))]).anchor_failed();
}

#[test]
fn f2_expiry_boundary() {
    let (mut p, _w, player, cranker) = one_game();
    let start = game(&p, &player).start_slot;
    p.warp(start + 300);
    assert_eq!(expire(&mut p, cranker, &[expire_ix(player)]).code(), Some(6014));
    assert_eq!(status(&game(&p, &player)), 0);
    p.warp(start + 301);
    assert!(expire(&mut p, cranker, &[expire_ix(player)]).ok());
}

#[test]
fn f2_zero_reveals_refund_branch() {
    let (mut p, _w, player, cranker) = one_game();
    p.warp(p.slot() + 301);
    let pl = lam(&p, &player);
    let o = expire(&mut p, cranker, &[expire_ix(player)]);
    assert!(o.ok());
    assert_eq!(lam(&p, &player) - pl, BET);
    assert_eq!(status(&game(&p, &player)), 3, "Expired");
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
    assert_eq!(o.events.len(), 1);
    assert_eq!(event_name(&o.events[0]), "GameRefunded");
    assert_eq!(o.events[0][80..88], BET.to_le_bytes(), "refund == bet");
    let (pl, rent) = (lam(&p, &player), lam(&p, &pda::game(&player)));
    let d = p.run(&[ix::CloseGame { game: pda::game(&player), player }.ix()]);
    assert!(d.port.ok());
    assert_eq!(lam(&p, &player) - pl, rent, "player's close_game returns the rent");
}

#[test]
fn f2_cash_branch_pays_cash_value_then_house_settles() {
    let (mut p, w, player, cranker) = one_game();
    // INTENDED: VRF-only. player2's legacy game is started (Anchor state mirrored onto the port) and revealed
    // here, before the port-only expire_game below makes the sides diverge; it is expired + settled at the end.
    let p2 = p.user("player2");
    let referrer = p.user("referrer");
    p.run(&[ix::SetReferrer { player_stats: pda::stats(&p2), referrer, referral_account: pda::referral(&referrer), player: p2, ..Default::default() }.ix()]);
    let held = v2(&p).total_outstanding_max_payout;
    p.start_game(p2, 1, BET, 0b100, [8; 32]);
    for t in [0, 1] {
        assert!(p.run(&[ix::RevealTile { game: pda::game(&p2), house_authority: w.house, ..Default::default() }.ix(t, false)]).port.ok());
    }
    let reserved = v2(&p).total_outstanding_max_payout;
    reveal(&mut p, &w, player, 0, false);
    reveal(&mut p, &w, player, 1, false);
    p.warp(p.slot() + 301);
    let mult = game(&p, &player).multiplier_bps;
    let payout = BET * mult / 10_000;
    let (pl, paid0) = (lam(&p, &player), accounts::Vault::decode(&p.get(&ids::VAULT).unwrap().data).unwrap().total_payouts);
    let o = expire(&mut p, cranker, &[expire_ix(player)]);
    assert!(o.ok());
    assert_eq!(lam(&p, &player) - pl, payout);
    let g = game(&p, &player);
    assert_eq!((status(&g), g.settled), (1, false));
    let v = accounts::Vault::decode(&p.port.get_account(&ids::VAULT).unwrap().data).unwrap();
    assert_eq!(v.total_payouts - paid0, payout);
    assert_eq!(event_name(&o.events[0]), "GameWon");
    assert_eq!(v2(&p).total_outstanding_max_payout, reserved, "cash branch leaves the release to settle_game");

    // the house crank: [expire_game, settle_game] in one tx on a referred game; released exactly once
    p.warp(p.slot() + 301);
    let mut st = settle_ix(&w, p2, 0b100, [8; 32]);
    st.accounts.push(AccountMeta::new(pda::referral(&referrer), false));
    let o = expire(&mut p, w.house, &[expire_ix(p2), st]);
    assert!(o.ok(), "{}", o.logs.join("\n"));
    println!("CU [expire_game, settle_game]: port {}", o.cu);
    assert!(o.cu < CLIENT_CU_LIMIT);
    assert_eq!(v2(&p).total_outstanding_max_payout, held, "released exactly once");
    let s = accounts::PlayerStats::decode(&p.port.get_account(&pda::stats(&p2)).unwrap().data).unwrap();
    assert_eq!((s.games_played, s.games_won), (1, 1));
    let r = accounts::ReferralAccount::decode(&p.port.get_account(&pda::referral(&referrer)).unwrap().data).unwrap();
    assert_eq!(r.accrued_lamports, BET * 50 / 10_000);
    assert!(game(&p, &p2).settled);
}

#[test]
fn f2_mult_below_one_takes_refund_branch() {
    let mut p = Pair::new();
    let w = p.house_world();
    p.ok(&[ix::UpdateVault { owner: w.owner, ..Default::default() }.ix(Some(1_000), None, None, None, None, None, None)]);
    let player = p.user("player");
    p.start_game(player, 1, BET, 0b100, [7; 32]);
    reveal(&mut p, &w, player, 0, false);
    let g = p.read(&pda::game(&player), GameSession::decode);
    assert!(g.multiplier_bps < 10_000, "{}", g.multiplier_bps); // 16/15 x 0.9 = 9599 (floor)
    p.warp(p.slot() + 301);
    let cranker = p.user("cranker");
    let pl = lam(&p, &player);
    assert!(expire(&mut p, cranker, &[expire_ix(player)]).ok());
    assert_eq!(lam(&p, &player) - pl, BET, "bet beats the 0.96x cash value");
    assert_eq!(status(&game(&p, &player)), 3);
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
}

#[test]
fn f2_no_partial_refund_6006() {
    let (mut p, _w, player, cranker) = one_game();
    p.warp(p.slot() + 301);
    set_lamports(&mut p, ids::VAULT, rent_min(accounts::Vault::SPACE) + BET / 2);
    let before = p.get(&pda::game(&player)).unwrap();
    assert_eq!(expire(&mut p, cranker, &[expire_ix(player)]).code(), Some(6006));
    assert_eq!(p.port.get_account(&pda::game(&player)).unwrap(), before, "game untouched");
    // the player's signed refund_expired still pays the partial amount, identically on both
    let pl = p.lamports(&player);
    p.ok(&[ix::RefundExpired { game: pda::game(&player), player, ..Default::default() }.ix()]);
    assert_eq!(p.lamports(&player) - pl, BET / 2);
}

#[test]
fn f2_cash_branch_vault_short_6006() {
    let (mut p, w, player, cranker) = one_game();
    reveal(&mut p, &w, player, 0, false);
    p.warp(p.slot() + 301);
    set_lamports(&mut p, ids::VAULT, rent_min(accounts::Vault::SPACE) + BET);
    let before = p.get(&pda::game(&player)).unwrap();
    assert_eq!(expire(&mut p, cranker, &[expire_ix(player)]).code(), Some(6006));
    assert_eq!(p.port.get_account(&pda::game(&player)).unwrap(), before);
}

#[test]
fn f2_wrong_player_6007() {
    let (mut p, _w, player, cranker) = one_game();
    p.warp(p.slot() + 301);
    let mut i = expire_ix(player);
    i.accounts[3].pubkey = cranker;
    assert_eq!(expire(&mut p, cranker, &[i]).code(), Some(6007));
}

#[test]
fn f2_account_checks_mirror_refund_expired() {
    let (mut p, _w, player, cranker) = one_game();
    p.warp(p.slot() + 301);
    let fake = key("fake-v2");
    p.set_account(fake, p.get(&ids::V2_STATE).unwrap());
    let cases: Vec<(&str, Box<dyn Fn(&mut Instruction)>, u32)> = vec![
        ("player readonly", Box::new(|i| i.accounts[3].is_writable = false), 2000),
        ("vault readonly", Box::new(|i| i.accounts[0].is_writable = false), 2000),
        ("game readonly", Box::new(|i| i.accounts[2].is_writable = false), 2000),
        ("fake v2", Box::new(move |i| i.accounts[1].pubkey = fake), 2006),
        ("v2 as vault", Box::new(|i| i.accounts[0].pubkey = ids::V2_STATE), 3002),
        ("not enough keys", Box::new(|i| i.accounts.truncate(3)), 3005),
    ];
    for (name, f, code) in cases {
        let mut i = expire_ix(player);
        f(&mut i);
        assert_eq!(expire(&mut p, cranker, &[i]).code(), Some(code), "{name}");
    }
    assert_eq!(status(&game(&p, &player)), 0);
}

#[test]
fn f2_not_playing_6003() {
    // second call after a successful expire: no double payment
    let (mut p, _w, player, cranker) = one_game();
    p.warp(p.slot() + 301);
    assert!(expire(&mut p, cranker, &[expire_ix(player)]).ok());
    let pl = lam(&p, &player);
    assert_eq!(expire(&mut p, cranker, &[expire_ix(player)]).code(), Some(6003));
    assert_eq!(lam(&p, &player), pl);
    // Lost
    let (mut p, w, player, cranker) = one_game();
    reveal(&mut p, &w, player, 2, true);
    p.warp(p.slot() + 301);
    assert_eq!(expire(&mut p, cranker, &[expire_ix(player)]).code(), Some(6003));
}

#[test]
fn f2_signed_paths_untouched() {
    // cash_out after expiry (no-expiry quirk) still identical on both, then expire is 6003
    let (mut p, w, player, cranker) = one_game();
    reveal(&mut p, &w, player, 0, false);
    p.warp(p.slot() + 301);
    p.ok(&[ix::CashOut { game: pda::game(&player), player, ..Default::default() }.ix()]);
    assert_eq!(expire(&mut p, cranker, &[expire_ix(player)]).code(), Some(6003));
    // refund_expired: identical on both, then expire is 6003
    let (mut p, _w, player, cranker) = one_game();
    p.warp(p.slot() + 301);
    p.ok(&[ix::RefundExpired { game: pda::game(&player), player, ..Default::default() }.ix()]);
    assert_eq!(expire(&mut p, cranker, &[expire_ix(player)]).code(), Some(6003));
}

#[test]
fn f2_batch_crank_cu() {
    let mut p = Pair::new();
    p.house_world();
    let players: Vec<Address> = (0..10).map(|i| p.user(&format!("p{i}"))).collect();
    for (i, a) in players.iter().enumerate() { p.start_game(*a, 1, 1_000_000, 0b100, [i as u8; 32]); }
    p.warp(p.slot() + 301);
    let cranker = p.user("cranker");
    let ixs: Vec<_> = players.iter().map(|a| expire_ix(*a)).collect();
    // legacy tx size: 1 signature + message (header, keys, blockhash, compiled instructions)
    let m = solana_message::Message::new(&ixs, Some(&cranker));
    let size = 1 + 64 + 3 + 1 + 32 * m.account_keys.len() + 32 + 1
        + m.instructions.iter().map(|c| 1 + 1 + c.accounts.len() + 1 + c.data.len()).sum::<usize>();
    let o = expire(&mut p, cranker, &ixs);
    assert!(o.ok(), "{}", o.logs.join("\n"));
    println!("CU 10 x expire_game: port {} | tx {size} bytes", o.cu);
    assert!(o.cu < CLIENT_CU_LIMIT && size <= 1232);
    assert_eq!(v2(&p).total_outstanding_max_payout, 0);
}
