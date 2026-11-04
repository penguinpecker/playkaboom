//! F5 (AUTH-2): `settle_vrf` needs the referral PDA when `player_stats.referrer` is Some (6022 if
//! missing). Anchor skips the cut, so the missing-account settle is an INTENDED divergence. Legacy
//! `settle_game` stays optional (house-gated). See spec/FIXES.md section 6.
use difftest::*;

const BET: u64 = 10_000_000;

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
fn settle_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury,
        player_stats: pda::stats(&player), ..Default::default() }.ix()
}

/// A resolved (won or lost) VRF game; `referred` sets a referrer first. Returns (pair, world, player, referrer).
fn resolved(referred: bool, lose: bool) -> (Pair, World, Address, Address) {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    let player = p.user("player");
    let referrer = p.user("referrer");
    if referred {
        p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
    }
    let game = p.start_game_vrf(player, 1, BET, player);
    reveal(&mut p, game, 3, lose);
    if !lose { p.ok(&[ix::CashOutVrf { signer: player, game }.ix()]); }
    (p, w, player, referrer)
}

fn port(p: &Pair, k: &Address) -> Option<Account> { p.port.get_account(k) }

/// Missing referral PDA: Anchor settles (cut skipped), the port refuses and changes nothing; the same
/// settle with the PDA then succeeds on the port and the referrer accrues the cut.
fn missing_then_passed(lose: bool) {
    let (mut p, w, player, referrer) = resolved(true, lose);
    let stranger = p.user("stranger");
    let watched = [pda::vrf_claim(&player), pda::vrf_game(&player), ids::VAULT, ids::V2_STATE, player];
    let before: Vec<_> = watched.iter().map(|k| port(&p, k)).collect();
    let d = p.run(&[settle_ix(stranger, player, w.treasury)]);
    assert!(d.anchor.ok(), "Anchor skips the referrer's cut");
    assert_eq!(d.port.code(), Some(6022));
    let after: Vec<_> = watched.iter().map(|k| port(&p, k)).collect();
    assert_eq!(before, after, "port: failed settle changed state");
    let accrued0 = accounts::ReferralAccount::decode(&port(&p, &pda::referral(&referrer)).unwrap().data).unwrap().accrued_lamports;
    let mut i = settle_ix(stranger, player, w.treasury);
    i.accounts.push(AccountMeta::new(pda::referral(&referrer), false));
    let d = p.run(&[i]);
    assert!(d.port.ok(), "{}", d.report());
    let r = accounts::ReferralAccount::decode(&port(&p, &pda::referral(&referrer)).unwrap().data).unwrap();
    assert_eq!(r.accrued_lamports - accrued0, BET * 50 / 10_000, "bronze cut");
    assert!(port(&p, &pda::vrf_claim(&player)).is_none_or(|a| a.lamports == 0));
}

#[test]
fn f5_referred_settle_without_referral_6022() { missing_then_passed(false); }

#[test]
fn f5_referred_loss_requires_referral() { missing_then_passed(true); }

#[test]
fn f5_unreferred_settle_unchanged() {
    for lose in [false, true] {
        let (mut p, w, player, _) = resolved(false, lose);
        let stranger = p.user("stranger");
        p.ok(&[settle_ix(stranger, player, w.treasury)]);
    }
}

#[test]
fn f5_legacy_settle_game_still_optional() {
    let mut p = Pair::new();
    let w = p.house_world();
    let player = p.user("player");
    let referrer = p.user("referrer");
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
    let (layout, salt) = (0b100u16, [7u8; 32]);
    let game = p.start_game(player, 1, BET, layout, salt);
    p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(0, false)]);
    p.ok(&[ix::CashOut { game, player, ..Default::default() }.ix()]);
    // house settles a referred legacy game without the referral account: identical on both (cut skipped)
    p.ok(&[ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: w.treasury,
        ..Default::default() }.ix(layout, salt)]);
    assert_eq!(p.read(&pda::referral(&referrer), accounts::ReferralAccount::decode).accrued_lamports, 0);
}
