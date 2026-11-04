//! Challenge F5: try to settle a referred VRF game on the port while skipping (or misdirecting) the
//! referrer's cut. Every variant must fail on the port with no state change; the honest settle with the
//! right PDA must still work afterwards (liveness), also after the referrer has claimed.
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
fn settle_ix(payer: Address, player: Address, treasury: Address, rem: &[AccountMeta]) -> Instruction {
    let mut i = ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury,
        player_stats: pda::stats(&player), ..Default::default() }.ix();
    i.accounts.extend_from_slice(rem);
    i
}
fn set_ref(p: &mut Pair, player: Address, referrer: Address) -> Diff {
    p.run(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()])
}
fn accrued(p: &Pair, referrer: &Address) -> u64 {
    accounts::ReferralAccount::decode(&p.port.get_account(&pda::referral(referrer)).unwrap().data).unwrap().accrued_lamports
}

fn run(lose: bool) {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    let player = p.user("player");
    let referrer = p.user("referrer");
    // Attacker (the player's second wallet) owns a live referral PDA of its own.
    let sock = p.user("sock");
    let decoy = p.user("decoy");
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&decoy), referrer: sock, referral_account: pda::referral(&sock), player: decoy, ..Default::default() }.ix()]);
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
    // Referrer cannot be swapped or cleared later (same tx or not).
    assert!(!set_ref(&mut p, player, sock).port.ok(), "referrer swap must fail");

    let game = p.start_game_vrf(player, 1, BET, player);
    reveal(&mut p, game, 3, lose);
    if !lose { p.ok(&[ix::CashOutVrf { signer: player, game }.ix()]); }

    let watched = [pda::vrf_claim(&player), pda::vrf_game(&player), ids::VAULT, ids::V2_STATE, player,
        pda::referral(&referrer), pda::referral(&sock)];
    let snap = |p: &Pair| watched.iter().map(|k| p.port.get_account(k)).collect::<Vec<_>>();
    let before = snap(&p);
    let ref_pda = pda::referral(&referrer);
    let variants: Vec<(&str, Vec<AccountMeta>)> = vec![
        ("none", vec![]),
        ("referrer wallet", vec![AccountMeta::new(referrer, false)]),
        ("attacker's own referral PDA", vec![AccountMeta::new(pda::referral(&sock), false)]),
        ("player_stats alias", vec![AccountMeta::new(pda::stats(&player), false)]),
        ("vault alias", vec![AccountMeta::new(ids::VAULT, false)]),
        ("junk then right PDA", vec![AccountMeta::new(sock, false), AccountMeta::new(ref_pda, false)]),
        ("right PDA read-only", vec![AccountMeta::new_readonly(ref_pda, false)]),
    ];
    for (name, rem) in variants {
        let d = p.run(&[settle_ix(sock, player, w.treasury, &rem)]);
        assert!(!d.port.ok(), "bypass via {name}: {}", d.report());
        assert_eq!(snap(&p), before, "{name}: failed settle changed state");
    }
    // Bundled: settle without the PDA next to an unrelated ok ix still reverts as a whole.
    let d = p.run(&[ix::SetReferrer { player_stats: pda::stats(&sock), referrer: decoy, referral_account: pda::referral(&decoy), player: sock, ..Default::default() }.ix(),
        settle_ix(sock, player, w.treasury, &[])]);
    assert!(!d.port.ok());
    assert_eq!(snap(&p), before);

    // Liveness: the referrer drains its PDA first, then a stranger settles with it.
    let a0 = accrued(&p, &referrer);
    if a0 > 0 { assert!(p.run(&[ix::ClaimReferral { referral_account: ref_pda, referrer }.ix()]).port.ok()); }
    let a0 = accrued(&p, &referrer);
    let d = p.run(&[settle_ix(sock, player, w.treasury, &[AccountMeta::new(ref_pda, false)])]);
    assert!(d.port.ok(), "{}", d.report());
    assert_eq!(accrued(&p, &referrer) - a0, BET * 50 / 10_000);
    assert!(p.port.get_account(&pda::vrf_claim(&player)).is_none_or(|a| a.lamports == 0));
}

#[test]
fn challenge_f5_variants_win() { run(false); }

#[test]
fn challenge_f5_variants_loss() { run(true); }
