//! Challenge F4: the claim window does not bound an LP who schedules its own payout.
//!
//! F4's residual bound (W/(C+W) of the time "armed") assumes payout events arrive independently of
//! the LP's unlock. But `unlock = request_slot + cooldown` is fixed and known at request time, and an
//! attacker who also plays (a second wallet) decides when its own win exists. It plays just before
//! its own unlock, holds the winning VRF game unsettled (on mainnet: delegated on the ER, which only
//! the player/session key can undelegate; the F3 relay waits 60 s for terminal games and 5 min idle
//! for PLAYING games), and exits at slot == unlock. The exit is priced on `vault_assets`, which
//! still ignores the open game, so the remaining LPs carry the attacker's share of its own payout.
//! W plays no role (exit is at unlock + 0), and the keeper does not help: it completes at the same
//! pre-payout NAV.
//!
//! EV per attacker game, LP share s, house edge e: player -e*B, LP +s*B (bet in NAV) with no -s*P,
//! so (s - e)*B > 0 whenever s > e. Defaults: s up to 10% per wallet (DEFAULT_MAX_USER_POSITION_BPS),
//! e = 1%: about +9% of every bet played into the exit, every cooldown cycle (not 1.37% of them).
//!
//! STATUS: confirmed, NOT fixed on-chain (no fix fits the binding constraints; owner decision, FIXES.md
//! sections 10 and 12). This test records the residual and must keep passing until the owner picks a fix.
use accounts::LpPosition;
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;

fn dep(user: Address, amount: u64) -> Instruction {
    ix::LpDeposit { position: pda::lp(&user), user, ..Default::default() }.ix(amount)
}
fn req(user: Address, units: u128) -> Instruction {
    ix::RequestWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix(units)
}
fn complete(user: Address) -> Instruction {
    ix::CompleteWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix()
}
fn unsigned(mut i: Instruction) -> Instruction {
    i.accounts[3].is_signer = false;
    i
}
fn pos(p: &Pair, u: &Address) -> LpPosition { p.read(&pda::lp(u), LpPosition::decode) }
fn port_lamports(p: &Pair, k: &Address) -> u64 { p.port.get_account(k).map(|a| a.lamports).unwrap_or(0) }

fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    rem != 0 && u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
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

/// Attacker LP (2 SOL, all requested) + attacker player wallet. The player clears the board
/// 50 slots BEFORE the LP's unlock (cooldown not elapsed: complete is still 6037), holds the WON
/// game, then at slot == unlock the LP exits. Returns the LP's proceeds.
fn run(exit_first: bool, keeper: bool) -> u64 {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    let lp = p.user("lp");
    p.ok(&[dep(lp, 2 * SOL)]);
    let units = pos(&p, &lp).units;
    p.ok(&[req(lp, units)]);
    let unlock = pos(&p, &lp).pending_unlock_slot;

    p.warp(unlock - 50);
    p.run(&[complete(lp)]).assert_err(6037); // not matured: the window has not even opened
    let player = p.user("attacker_player");
    let s = p.user("s");
    let game = p.start_game_vrf(player, 1, 300_000_000, s);
    for t in 0..15 { safe_reveal(&mut p, game, t); }
    assert_eq!(p.port.get_account(&game).unwrap().data[8], 1, "WON, held unsettled by its own player");

    p.warp(unlock); // unlock + 0: inside the window whatever W is
    let before = port_lamports(&p, &lp);
    let st = settle_vrf_ix(player, player, w.treasury);
    if !exit_first {
        p.run_as(player, &[st]).assert_ok();
        p.run_as(lp, &[complete(lp)]).assert_ok();
    } else if keeper {
        // F4's own keeper, unsigned (Anchor 3010), then the player settles.
        let k = p.user("keeper");
        let d = p.run_as(k, &[unsigned(complete(lp))]);
        assert!(d.port.ok(), "{}", d.report());
        assert!(p.run_as(player, &[st]).port.ok());
    } else {
        p.run_as(lp, &[complete(lp), st]).assert_ok(); // the original repro tx, identical on both
    }
    port_lamports(&p, &lp) - before
}

#[test]
fn challenge_f4_self_scheduled_win_exits_at_unlock() {
    let fair = run(false, false);
    let dodge = run(true, false);
    let keeper = run(true, true);
    println!("lp proceeds: fair {fair}  exit-first {dodge}  keeper-exit {keeper}  extracted {}", dodge - fair);
    assert!(dodge > fair + 50_000_000, "port: LP still dodges its share of a known (self-made) win");
    assert!(keeper >= dodge, "the F4 keeper completes at the same pre-payout NAV (LP saves its own fees)");
}
