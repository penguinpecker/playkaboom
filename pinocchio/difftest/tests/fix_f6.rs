//! F6 (MB-6): `start_game_vrf` reuses an orphaned VrfGame (program-owned, VrfGame disc, no claim) left by
//! `admin_release_vrf_claim`. Anchor can only fail there, so each reuse is an INTENDED divergence
//! (Anchor fails, port ok). See spec/FIXES.md section 7 and design-F6.md section 4.
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
/// Fake the DLP undelegation of `player`'s game: L1 copy, delegation record and metadata emptied (the DLP
/// closes them), buffer holds `bytes`, then process_undelegation re-creates it program-owned (both sides).
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
/// Start (1 mine), warp past ABANDON_SLOTS, admin release: a never-delegated orphan.
fn orphan(p: &mut Pair, w: &World, player: Address) {
    p.start_game_vrf(player, 1, BET, player);
    p.warp(START_SLOT + 216_001);
    p.ok(&[release_ix(w.owner, player)]);
}
fn port(p: &Pair, k: &Address) -> Account { p.port.get_account(k).unwrap() }

#[test]
fn f6_released_never_delegated_game_is_reused() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    orphan(&mut p, &w, player);
    p.run(&[refund_ix(player, player)]).assert_same().assert_failed();
    p.run(&[settle_ix(player, player, w.treasury)]).assert_same().assert_failed();
    let game = pda::vrf_game(&player);
    let (old_game_lamports, pl0) = (p.lamports(&game), p.lamports(&player));
    let s2 = key("s2");
    let d = p.run(&[start_ix(player, 2, s2)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
    println!("CU start_game_vrf (orphan reuse): {}", d.port.cu);
    let g = accounts::VrfGame::decode(&port(&p, &game).data).unwrap();
    assert_eq!((g.status, g.mine_count, g.session_key, g.player), (0, 2, s2, player));
    assert_eq!((g.reveal_count, g.safe_reveals, g.revealed_mask, g.mine_mask, g.pending, g.pending_tile, g.multiplier_bps),
        (0, 0, 0, 0, false, 255, 10_000));
    assert_eq!(port(&p, &game).lamports, old_game_lamports, "game rent carried over");
    assert_eq!(pl0 - port(&p, &player).lamports, BET + rent_min(accounts::VrfClaim::SPACE), "no game rent charged");
    let c = accounts::VrfClaim::decode(&port(&p, &pda::vrf_claim(&player)).data).unwrap();
    assert_eq!(c.start_slot, START_SLOT + 216_001);
    let v2 = accounts::VaultV2State::decode(&port(&p, &ids::V2_STATE).data).unwrap();
    assert_eq!(v2.total_outstanding_max_payout, c.reserved);
    p.warp(START_SLOT + 216_001 + 26);
    let before = port(&p, &player).lamports;
    assert!(p.run(&[refund_ix(player, player)]).port.ok());
    assert_eq!(port(&p, &player).lamports - before, BET + rent_min(accounts::VrfClaim::SPACE) + old_game_lamports);
}

/// Released while delegated, then the ER returns a Lost game: reuse wipes every stale byte; the
/// web client's atomic `[start, delegate]` also works on the reused game.
#[test]
fn f6_released_game_back_from_er_with_result_is_wiped() {
    for atomic in [false, true] {
        let (mut p, w, validator) = world();
        let player = p.user("player");
        p.start_game_vrf(player, 1, BET, player);
        p.ok(&[deleg_ix(player, validator)]);
        let game = pda::vrf_game(&player);
        let mut lost = p.get(&game).unwrap().data;
        lost[8] = 2;
        lost[78] = 1;
        lost[81..83].copy_from_slice(&(1u16 << 3).to_le_bytes());
        lost[83..85].copy_from_slice(&(1u16 << 3).to_le_bytes());
        lost[93] = 3;
        lost[94..126].copy_from_slice(&[0x42; 32]);
        p.warp(START_SLOT + 216_001);
        p.ok(&[release_ix(w.owner, player)]);
        undelegate(&mut p, player, lost);
        p.run(&[settle_ix(player, player, w.treasury)]).assert_same().assert_failed();
        if atomic {
            let d = p.run(&[start_ix(player, 1, player), deleg_ix(player, validator)]);
            assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
            assert_eq!(port(&p, &game).owner, ids::DLP);
            continue;
        }
        let d = p.run(&[start_ix(player, 1, player)]);
        assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
        let data = port(&p, &game).data;
        assert!(data[93..621].iter().all(|b| *b == 0), "stale reveals survived");
        let g = accounts::VrfGame::decode(&data).unwrap();
        assert_eq!((g.status, g.mine_mask, g.revealed_mask, g.safe_reveals, g.reveal_count), (0, 0, 0, 0, 0));
        let d = p.run(&[deleg_ix(player, validator)]);
        assert!(d.port.ok(), "{}", d.port.logs.join("\n"));
    }
}

#[test]
fn f6_still_delegated_orphan_not_reused() {
    let (mut p, w, validator) = world();
    let player = p.user("player");
    p.start_game_vrf(player, 1, BET, player);
    p.ok(&[deleg_ix(player, validator)]);
    p.warp(START_SLOT + 216_001);
    p.ok(&[release_ix(w.owner, player)]);
    p.run(&[start_ix(player, 1, player)]).assert_same().assert_failed();
}

#[test]
fn f6_cannot_take_over_another_wallets_orphan() {
    let (mut p, w, _) = world();
    let a = p.user("alice");
    let b = p.user("bob");
    orphan(&mut p, &w, a);
    let ga = pda::vrf_game(&a);
    let before = p.get(&ga).unwrap();
    let mut i = start_ix(b, 1, b);
    i.accounts[4].pubkey = ga;
    p.run(&[i]).assert_err(2006);
    assert_eq!(port(&p, &ga), before, "alice's orphan untouched");
}

#[test]
fn f6_readonly_orphan_game_slot() {
    let (mut p, w, _) = world();
    let player = p.user("player");
    orphan(&mut p, &w, player);
    let mut i = start_ix(player, 1, player);
    i.accounts[4].is_writable = false;
    assert_eq!(p.run(&[i]).port.code(), Some(2000));
}

/// F3 + F6: a delegated orphan the house forces back (VOID) is reused by the next start.
#[test]
fn f6_reuses_void_orphan_from_f3() {
    let (mut p, w, validator) = world();
    let player = p.user("player");
    p.start_game_vrf(player, 1, BET, player);
    p.ok(&[deleg_ix(player, validator)]);
    p.warp(START_SLOT + 216_001);
    p.ok(&[release_ix(w.owner, player)]);
    let game = pda::vrf_game(&player);
    let bytes = p.get(&game).unwrap().data;
    p.er_game(game, bytes); // ER view
    let force = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(w.house, true),
            AccountMeta::new(game, false),
            AccountMeta::new_readonly(ids::MAGIC_PROGRAM, false),
            AccountMeta::new(ids::MAGIC_CONTEXT, false),
            AccountMeta::new_readonly(ids::VAULT, false),
        ],
        data: vec![0xda, 0x30, 0xa3, 0xda, 0x54, 0xf8, 0xe4, 0x65],
    };
    assert!(p.run(&[force]).port.ok());
    let void = port(&p, &game).data;
    assert_eq!(void[8], 3);
    undelegate(&mut p, player, void);
    let d = p.run(&[start_ix(player, 1, player)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
    assert_eq!(port(&p, &game).data[8], 0, "fresh PLAYING game");
}
