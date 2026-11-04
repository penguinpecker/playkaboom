//! F4 (MONEY-3): a matured LP withdrawal can be completed only in [unlock, unlock + 9_000] and
//! `complete_withdraw` no longer needs the user's signature (a keeper completes it). Anchor has neither,
//! so a late or unsigned completion is an INTENDED divergence. See spec/FIXES.md section 5.
use accounts::LpPosition;
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const W: u64 = 9_000;
const ERR: u32 = 6056;

fn dep(user: Address, amount: u64) -> Instruction {
    ix::LpDeposit { position: pda::lp(&user), user, ..Default::default() }.ix(amount)
}
fn req(user: Address, units: u128) -> Instruction {
    ix::RequestWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix(units)
}
fn cancel(user: Address) -> Instruction {
    ix::CancelWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix()
}
fn complete(user: Address) -> Instruction {
    ix::CompleteWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix()
}
fn unsigned(mut i: Instruction) -> Instruction {
    i.accounts[3].is_signer = false;
    i
}
fn pos(p: &Pair, u: &Address) -> LpPosition { p.read(&pda::lp(u), LpPosition::decode) }
fn port_pos(p: &Pair, u: &Address) -> LpPosition { LpPosition::decode(&p.port.get_account(&pda::lp(u)).unwrap().data).unwrap() }
fn port_v2(p: &Pair) -> accounts::VaultV2State { accounts::VaultV2State::decode(&p.port.get_account(&ids::V2_STATE).unwrap().data).unwrap() }
fn port_lamports(p: &Pair, k: &Address) -> u64 { p.port.get_account(k).map(|a| a.lamports).unwrap_or(0) }
fn port_assets(p: &Pair) -> u64 { port_lamports(p, &ids::VAULT) - rent_min(accounts::Vault::SPACE) }

/// house_world + "lp" with 1 SOL, half of it requested. Returns (pair, world, lp, unlock).
fn pending_world() -> (Pair, World, Address, u64) {
    let mut p = Pair::new();
    let w = p.house_world();
    let u = p.user("lp");
    p.ok(&[dep(u, SOL)]);
    let half = pos(&p, &u).units / 2;
    p.ok(&[req(u, half)]);
    let unlock = pos(&p, &u).pending_unlock_slot;
    (p, w, u, unlock)
}

#[test]
fn f4_window_inclusive_upper_bound() {
    let (mut p, _w, u, unlock) = pending_world();
    p.warp(unlock + W);
    let ul = p.lamports(&u);
    p.ok(&[complete(u)]);
    assert_eq!(p.lamports(&u) - ul, SOL / 2);

    let (mut p, _w, u, unlock) = pending_world();
    p.warp(unlock + W + 1);
    let (ul, vl, before) = (p.lamports(&u), p.lamports(&ids::VAULT), pos(&p, &u));
    let d = p.run(&[complete(u)]);
    assert!(d.anchor.ok());
    assert_eq!(d.port.code(), Some(ERR));
    let after = port_pos(&p, &u);
    assert_eq!((after.pending_units, after.pending_unlock_slot), (before.pending_units, before.pending_unlock_slot));
    assert_eq!((port_lamports(&p, &u), port_lamports(&p, &ids::VAULT)), (ul, vl));
}

#[test]
fn f4_lapsed_request_restarts() {
    let (mut p, _w, u, unlock) = pending_world();
    p.warp(unlock + W + 1);
    let units = pos(&p, &u).pending_units;
    assert_eq!(p.run(&[complete(u)]).port.code(), Some(ERR));
    // recovery: [cancel, request(same units)] in one signed tx (Anchor already completed, so ignore it)
    assert!(p.run(&[cancel(u), req(u, units)]).port.ok());
    let new_unlock = port_pos(&p, &u).pending_unlock_slot;
    assert_eq!(new_unlock, unlock + W + 1 + 648_000);
    p.warp(new_unlock);
    let s = port_v2(&p);
    let expect = (units * port_assets(&p) as u128 / s.total_units) as u64;
    let ul = port_lamports(&p, &u);
    assert!(p.run(&[complete(u)]).port.ok());
    assert_eq!(port_lamports(&p, &u) - ul, expect);
}

#[test]
fn f4_keeper_completes_without_user_signature() {
    let (mut p, _w, u, unlock) = pending_world();
    let keeper = p.user("keeper");
    // before unlock: still 6037 on the port (Anchor: 3010)
    let d = p.run_as(keeper, &[unsigned(complete(u))]);
    assert_eq!((d.anchor.code(), d.port.code()), (Some(3010), Some(6037)));
    p.warp(unlock);
    let (ul, kl) = (p.lamports(&u), p.lamports(&keeper));
    let d = p.run_as(keeper, &[unsigned(complete(u))]);
    assert_eq!(d.anchor.code(), Some(3010));
    assert!(d.port.ok(), "{}", d.report());
    println!("CU complete_withdraw (keeper, unsigned user): port {}", d.port.cu);
    assert_eq!(port_lamports(&p, &u) - ul, SOL / 2, "the LP gets exactly the Anchor amount");
    assert_eq!(kl - port_lamports(&p, &keeper), 5_000, "keeper pays only the fee");
    assert_eq!(port_pos(&p, &u).pending_units, 0);
    // after the window: 6056 unsigned too
    let (mut p, _w, u, unlock) = pending_world();
    let keeper = p.user("keeper");
    p.warp(unlock + W + 1);
    assert_eq!(p.run_as(keeper, &[unsigned(complete(u))]).port.code(), Some(ERR));
}

#[test]
fn f4_signer_still_required_for_request_and_cancel() {
    let (mut p, _w, u, _) = pending_world();
    p.run(&[unsigned(cancel(u))]).assert_err(3010);
    p.ok(&[cancel(u)]);
    p.run(&[unsigned(req(u, 1))]).assert_err(3010);
}

#[test]
fn f4_unsigned_cannot_redirect() {
    let (mut p, _w, a, unlock) = pending_world();
    p.warp(unlock);
    let bob = p.user("bob");
    let keeper = p.user("keeper");
    for user in [bob, keeper] {
        let i = ix::CompleteWithdraw { position: pda::lp(&a), user, ..Default::default() }.ix();
        p.run_as(keeper, &[i.clone()]).assert_err(2006); // signed: identical on both
        let d = p.run_as(keeper, &[unsigned(i)]);
        // the keeper is the fee payer, so it signs anyway; bob does not (Anchor 3010)
        let anchor = if user == keeper { 2006 } else { 3010 };
        assert_eq!((d.anchor.code(), d.port.code()), (Some(anchor), Some(2006)), "unsigned: seeds still bind user");
    }
    assert_eq!(pos(&p, &a).pending_unlock_slot, unlock, "nothing moved");
}

// ─── the audit repro (audit_money.rs::audit_matured_pending_withdraw_front_runs_known_vrf_win) ───

fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    rem != 0 && u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
/// Fake one safe VRF callback; tolerates earlier divergence (each side patched from its own copy).
fn safe_reveal(p: &mut Pair, game: Address, tile: u8) {
    let mut g = p.port.get_account(&game).unwrap();
    let r = (0..=255u8).map(|b| [b; 32]).find(|r| !is_mine(r, g.data[77], g.data[74])).unwrap();
    g.data[79] = 1;
    g.data[80] = tile;
    p.port.set_account(game, g).unwrap();
    if let Some(mut a) = p.anchor.get_account(&game) {
        a.data[79] = 1;
        a.data[80] = tile;
        p.anchor.set_account(game, a).unwrap();
    }
    let d = p.run(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(r)]);
    assert!(d.port.ok(), "{}", d.report());
}
fn settle_vrf_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury,
        player_stats: pda::stats(&player), ..Default::default() }.ix()
}
/// LP with 2 SOL, all requested; returns (pair, world, lp, unlock).
fn lp_requested() -> (Pair, World, Address, u64) {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    let lp = p.user("lp");
    p.ok(&[dep(lp, 2 * SOL)]);
    let units = pos(&p, &lp).units;
    p.ok(&[req(lp, units)]);
    let unlock = pos(&p, &lp).pending_unlock_slot;
    (p, w, lp, unlock)
}
/// A player clears the board (1 mine, 15 safe): committed VRF_WON awaiting settle_vrf.
fn full_clear(p: &mut Pair) -> Address {
    let player = p.user("winner");
    let s = p.user("s");
    let d = p.run(&[ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player),
        player_stats: pda::stats(&player), ..Default::default() }.ix(1, 300_000_000, s)]);
    assert!(d.port.ok(), "{}", d.report());
    let game = pda::vrf_game(&player);
    for t in 0..15 { safe_reveal(p, game, t); }
    assert_eq!(p.port.get_account(&game).unwrap().data[8], 1);
    player
}

#[test]
fn f4_repro_option_dies_after_window() {
    let (mut p, w, lp, unlock) = lp_requested();
    p.warp(unlock + W + 1);
    let player = full_clear(&mut p);
    let cw = complete(lp);
    let st = settle_vrf_ix(lp, player, w.treasury);
    let d = p.run_as(lp, &[cw, st.clone()]);
    assert!(d.anchor.ok(), "Anchor: the LP still exits at the pre-payout NAV");
    assert_eq!(d.port.code(), Some(ERR), "port: the matured option lapsed");
    assert_eq!(p.port.get_account(&pda::vrf_game(&player)).unwrap().data[8], 1, "port: whole tx reverted, game still WON");
    let pending = port_pos(&p, &lp).pending_units;
    let value = |p: &Pair| (pending * port_assets(p) as u128 / port_v2(p).total_units) as u64;
    let (v0, a0) = (value(&p), port_assets(&p));
    assert!(p.run_as(lp, &[st]).port.ok());
    let loss = a0 - port_assets(&p); // payout + treasury cut
    let share = (pending * loss as u128 / port_v2(&p).total_units) as u64;
    assert!((v0 - value(&p)).abs_diff(share) <= 1, "the LP bears its share of the payout");
}

#[test]
fn f4_keeper_completion_precedes_win() {
    let (mut p, w, lp, unlock) = lp_requested();
    p.warp(unlock);
    let keeper = p.user("keeper");
    let pending = pos(&p, &lp).pending_units;
    let nav = (pending * port_assets(&p) as u128 / port_v2(&p).total_units) as u64;
    let l0 = port_lamports(&p, &lp);
    let d = p.run_as(keeper, &[unsigned(complete(lp))]);
    assert!(d.port.ok(), "{}", d.report());
    assert_eq!(port_lamports(&p, &lp) - l0, nav, "paid at the pre-game NAV");
    let player = full_clear(&mut p);
    let l1 = port_lamports(&p, &lp);
    assert!(p.run_as(keeper, &[settle_vrf_ix(keeper, player, w.treasury)]).port.ok());
    assert_eq!(port_lamports(&p, &lp), l1, "the later win cannot touch the exited LP");
    assert_eq!(p.run_as(lp, &[complete(lp)]).port.code(), Some(6036), "nothing left to time");
}
