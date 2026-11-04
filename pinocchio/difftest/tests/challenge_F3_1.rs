//! Challenge F3, kept as the regression test of its fix. Bypass found: the attacker undelegated the game himself
//! (`settle_and_undelegate_vrf` had no status/pending check) while it was PLAYING with
//! (a) a reveal pending, or (b) one safe reveal and no pending.
//! On L1 the program-owned PLAYING game was out of every crank's reach (force ER-only, house refund 6007,
//! settle 6003, re-delegate 6044) until the 24 h admin release, and the attacker could refund its full bet.
//! FIXED (F3, `vrf.rs::end_playing`): (a) the undelegate fails 6044 and the game stays delegated, where the
//! callback lands and the house force crank ends it; (b) the undelegate cashes the game out (WON), so the
//! permissionless settle pays `bet x mult(1)` and releases the reservation; the free full-bet refund is gone.
use accounts::VaultV2State;
use difftest::*;

const DISC: [u8; 8] = [0xda, 0x30, 0xa3, 0xda, 0x54, 0xf8, 0xe4, 0x65];

fn start_ix(player: Address, mines: u8, bet: u64) -> Instruction {
    ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), player_stats: pda::stats(&player), ..Default::default() }
        .ix(mines, bet, player)
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
fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    rem != 0 && u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
/// Port-only fake DLP undelegation with the port's own ER bytes (the sides differ after F3).
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
fn outstanding(p: &Pair) -> u64 {
    VaultV2State::decode(&p.port.get_account(&ids::V2_STATE).unwrap().data).unwrap().total_outstanding_max_payout
}

fn run(pending: bool) {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    let a = p.user("attacker");
    let game = pda::vrf_game(&a);
    let bet = 10_000_000;
    p.ok(&[start_ix(a, 1, bet)]);
    let reserved = outstanding(&p);
    assert!(reserved > 0);
    p.ok(&[deleg_ix(a, validator)]);
    // ER view
    let bytes = p.get(&game).unwrap().data;
    p.er_game(game, bytes);
    let safe_r = (0..=255u8).map(|b| [b; 32]).find(|r| !is_mine(r, 0, 1)).unwrap();
    p.patch(game, |d| { d[79] = 1; d[80] = 3; }); // reveal_request_vrf effect (pending, tile 3)
    if !pending {
        p.ok(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(safe_r)]);
    }
    let d = p.run(&[ix::SettleAndUndelegateVrf { payer: a, game, ..Default::default() }.ix()]);
    assert!(d.anchor.ok(), "inherited: Anchor commits the PLAYING game as-is\n{}", d.report());
    if pending {
        // INTENDED: F3. Pending reveal: the port refuses (6044); the game stays delegated.
        assert_eq!(d.port.code(), Some(6044), "{}", d.report());
        // The oracle answers on the ER, then the relay's force ends the idle game (progress -> WON).
        let cb = ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(safe_r);
        assert!(p.run(&[cb]).port.ok());
        p.warp(START_SLOT + 1_000);
        let d = p.run(&[force_ix(w.house, a)]);
        assert!(d.port.ok(), "{}", d.report());
    } else {
        // INTENDED: F3. Progress: the port cashes the game out on the way out (WON).
        assert!(d.port.ok(), "{}", d.report());
        p.warp(START_SLOT + 100_000);
    }
    assert_eq!(p.port.get_account(&game).unwrap().data[8], 1, "port: WON");
    undelegate_port(&mut p, a);
    // L1: the permissionless settle (house relay) pays the cash-out and releases the reservation.
    let pl = p.port.get_account(&a).unwrap().lamports;
    let d = p.run(&[settle_ix(w.house, a, w.treasury)]);
    assert!(d.port.ok(), "{}", d.report());
    let paid = p.port.get_account(&a).unwrap().lamports - pl;
    assert!(paid > bet && paid < bet * 2, "cash-out at mult(1) plus rents: {paid}");
    assert_eq!(outstanding(&p), 0, "reservation released");
    // No free exit: the claim is gone, so the attacker's own refund fails.
    assert!(!p.run(&[refund_ix(a, a)]).port.ok());
}

#[test]
fn challenge_f3_pending_undelegated_game_unreachable_by_crank() { run(true); }

#[test]
fn challenge_f3_progress_undelegated_game_unreachable_by_crank() { run(false); }
