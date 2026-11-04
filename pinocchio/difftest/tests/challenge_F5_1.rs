//! Challenge F5: now that the referral PDA is mandatory in `settle_vrf`, can a player pick a referrer
//! that makes their own settle unsendable (and so freeze their reservation past the F3 crank)?
//! 1. Liveness: the referral PDA is always created by `set_referrer`; a third party cannot remove it.
//! 2. CU: the player chooses the referrer bytes freely, so they can grind a low canonical bump and make
//!    the mandatory `find_program_address` in `pay_referral` expensive. Measure the per-bump cost.
use difftest::*;

const BET: u64 = 10_000_000;

fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    rem != 0 && u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}

/// Referrer address whose referral PDA has canonical bump <= `max_bump`.
fn grind(max_bump: u8) -> (Address, u8) {
    (0u64..).map(|i| key(&format!("grind{i}")))
        .map(|r| (r, pda::find(&[b"kaboom_referral", r.as_ref()], &PROGRAM_ID).1))
        .find(|(_, b)| *b <= max_bump).unwrap()
}

/// Port CU of a referred, lost `settle_vrf` sent by a stranger, with `referrer`.
fn settle_cu(referrer: Address) -> u64 {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    let player = p.user("player");
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
    let game = p.start_game_vrf(player, 1, BET, player);
    let g = p.get(&game).unwrap().data;
    let r = (0..=255u8).map(|b| [b; 32]).find(|r| is_mine(r, g[77], g[74])).unwrap();
    p.patch(game, |d| { d[79] = 1; d[80] = 3; });
    p.ok(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(r)]);
    let stranger = p.user("stranger");
    let mut i = ix::SettleVrf { payer: stranger, player, claim: pda::vrf_claim(&player), game, treasury: w.treasury,
        player_stats: pda::stats(&player), ..Default::default() }.ix();
    i.accounts.push(AccountMeta::new(pda::referral(&referrer), false));
    let d = p.run(&[i]);
    assert!(d.port.ok(), "{}", d.report());
    d.port.cu
}

#[test]
fn challenge_f5_low_bump_referrer_cu() {
    let (lo, lo_bump) = grind(247);
    let hi = (0u64..).map(|i| key(&format!("hi{i}")))
        .find(|r| pda::find(&[b"kaboom_referral", r.as_ref()], &PROGRAM_ID).1 == 255).unwrap();
    let (base, ground) = (settle_cu(hi), settle_cu(lo));
    let iters = (255 - lo_bump) as u64;
    let per = (ground - base) / iters;
    let headroom_iters = 200_000u64.saturating_sub(base) / per.max(1);
    println!("settle_vrf port CU: bump255={base} bump{lo_bump}={ground} per_bump={per} iters_to_200k={headroom_iters}");
    // Grinding k extra bumps costs ~2^k PDA trials; anything past ~60 is infeasible.
    assert!(headroom_iters > 60, "a ground referrer can push settle_vrf past 200k CU");
}
