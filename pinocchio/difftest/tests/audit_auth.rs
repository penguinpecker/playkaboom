//! Adversarial audit, lens: account validation and authorization.
//! Every case runs on both builds (Anchor ref + kaboom-p) and must agree (DIFF POLICY).
//! `auth_*_finding` tests reproduce a real risk that exists in BOTH builds (inherited); they PASS
//! when the risk is present, so they document it rather than gate the port.
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const BET: u64 = 10_000_000;

fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    rem != 0 && u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
fn rand_for(safe: u8, mines: u8, mine: bool) -> [u8; 32] {
    (0..=255u8).map(|b| [b; 32]).find(|r| is_mine(r, safe, mines) == mine).unwrap()
}
/// VRF callback so the next reveal of `tile` is (not) a mine.
fn reveal(p: &mut Pair, game: Address, tile: u8, mine: bool) {
    let g = p.get(&game).unwrap().data;
    let r = rand_for(g[77], g[74], mine);
    p.patch(game, |d| { d[79] = 1; d[80] = tile; });
    p.ok(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(r)]);
}
fn settle_vrf_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury,
        player_stats: pda::stats(&player), ..Default::default() }.ix()
}

/// FINDING (inherited, D15), FIXED on the port. INTENDED: F1. `initialize_vault` is permissionless in
/// Anchor: on a fresh program id the first caller owns the single vault PDA forever and can drain what
/// the operator funds. The port only lets `DEPLOYER` sign it (6055), so the squat fails there.
#[test]
fn auth_initialize_vault_frontrun_finding() {
    let mut p = Pair::new();
    let attacker = p.user("attacker");
    let owner = p.deployer();
    // attacker front-runs the operator's init: Anchor accepts it, the port refuses
    let d = p.run(&[ix::InitializeVault { house_authority: attacker, treasury: attacker, owner: attacker, ..Default::default() }
        .ix(1_000, 1_000, 5_000)]);
    assert!(d.anchor.ok(), "Anchor: the squat works (the finding)");
    assert_eq!(d.port.code(), Some(6055));
    // the real operator: Anchor can no longer initialize (Allocate fails), the port can
    let d = p.run(&[ix::InitializeVault { house_authority: owner, treasury: owner, owner, ..Default::default() }.ix(100, 100, 1_000)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
    // operator funds the vault; on the port the attacker can neither allowlist itself nor withdraw
    assert!(p.run(&[ix::FundVault { funder: owner, ..Default::default() }.ix(5 * SOL)]).port.ok());
    assert_eq!(p.run(&[ix::AllowlistAdd { owner: attacker, ..Default::default() }.ix(attacker)]).port.code(), Some(6007));
    let before = p.port.get_account(&attacker).unwrap().lamports;
    let d = p.run(&[ix::WithdrawToTreasury { treasury: attacker, destination: attacker, ..Default::default() }.ix(u64::MAX)]);
    assert!(d.anchor.ok(), "Anchor: the squatter drains the vault");
    assert_eq!(d.port.code(), Some(6007));
    assert_eq!(p.port.get_account(&attacker).unwrap().lamports, before, "port: nothing reached the attacker");
}

/// FINDING (inherited), FIXED on the port. INTENDED: F5. `settle_vrf` is permissionless and in Anchor
/// `remaining_accounts[0]` (the referral PDA) is optional, so any third party can settle a referred
/// player's game without it and the referrer's cut is silently skipped. The port requires it (6022).
#[test]
fn auth_settle_vrf_skip_referral_finding() {
    let run = |with_ref: bool| -> Option<u64> {
        let mut p = Pair::new();
        let w = p.house_world();
        p.enable_vrf(&w, key("validator"));
        let player = p.user("player");
        let session = p.user("session");
        let referrer = p.user("referrer");
        let stranger = p.user("stranger");
        p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()]);
        let game = p.start_game_vrf(player, 1, BET, session);
        reveal(&mut p, game, 3, false);
        p.ok(&[ix::CashOutVrf { signer: session, game }.ix()]);
        let mut i = settle_vrf_ix(stranger, player, w.treasury);
        if with_ref { i.accounts.push(AccountMeta::new(pda::referral(&referrer), false)); }
        let d = p.run(&[i]);
        if !with_ref {
            assert!(d.anchor.ok(), "Anchor: the stranger skips the referral account (the finding)");
            assert_eq!(d.port.code(), Some(6022), "port: a referred settle needs the referral PDA");
            return None;
        }
        d.assert_ok();
        Some(p.read(&pda::referral(&referrer), accounts::ReferralAccount::decode).accrued_lamports)
    };
    assert!(run(true).unwrap() > 0, "control: referral cut paid when the account is passed");
    assert_eq!(run(false), None);
}

/// Proof (no finding): every privileged / owner-bound path rejects an outside signer on both builds,
/// and nothing moves.
#[test]
fn auth_outsider_rejected_everywhere() {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    let a = p.user("attacker");
    let victim = p.user("victim");
    let referrer = p.user("referrer");
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&victim), referrer, referral_account: pda::referral(&referrer), player: victim, ..Default::default() }.ix()]);
    p.ok(&[ix::AllowlistAdd { owner: w.owner, ..Default::default() }.ix(a)]); // even an allowlisted dest
    p.ok(&[ix::LpDeposit { position: pda::lp(&victim), user: victim, ..Default::default() }.ix(SOL / 10)]);
    let lgame = p.start_game(victim, 1, BET, 0b1, [7; 32]);
    let v2p = p.user("vrf-player");
    let v2s = p.user("vrf-session");
    let vgame = p.start_game_vrf(v2p, 1, BET, v2s);
    let vault_before = p.lamports(&ids::VAULT);

    let cases: Vec<(&str, Instruction, Option<u32>)> = vec![
        ("update_vault", ix::UpdateVault { owner: a, ..Default::default() }.ix(None, None, None, None, None, Some(a), Some(a)), Some(6007)),
        ("allowlist_add", ix::AllowlistAdd { owner: a, ..Default::default() }.ix(a), Some(6007)),
        ("allowlist_remove", ix::AllowlistRemove { owner: a, ..Default::default() }.ix(a), Some(6007)),
        ("propose_owner", ix::ProposeOwner { owner: a, ..Default::default() }.ix(a), Some(6007)),
        ("cancel_proposed_owner", ix::CancelProposedOwner { owner: a, ..Default::default() }.ix(), Some(6007)),
        ("accept_ownership (none pending)", ix::AcceptOwnership { new_owner: a, ..Default::default() }.ix(), Some(6007)),
        ("withdraw_to_treasury", ix::WithdrawToTreasury { treasury: a, destination: a, ..Default::default() }.ix(SOL), Some(6007)),
        ("unlock_operator_position", ix::UnlockOperatorPosition { owner: a, destination: a, ..Default::default() }.ix(), Some(6007)),
        ("update_v2_config", ix::UpdateV2Config { owner: a, ..Default::default() }.ix(None, None, None, None, None, None, Some(a), None), Some(6007)),
        ("house_deposit", ix::HouseDeposit { owner: a, ..Default::default() }.ix(SOL), Some(6007)),
        ("house_request_withdraw", ix::HouseRequestWithdraw { owner: a, ..Default::default() }.ix(1), Some(6007)),
        ("house_cancel_withdraw", ix::HouseCancelWithdraw { owner: a, ..Default::default() }.ix(), Some(6007)),
        ("house_complete_withdraw", ix::HouseCompleteWithdraw { owner: a, ..Default::default() }.ix(), Some(6007)),
        ("repair_referral", ix::RepairReferral { referrer: a, referral_account: pda::referral(&referrer), owner: a, ..Default::default() }.ix(), Some(6007)),
        ("admin_release_vrf_claim", ix::AdminReleaseVrfClaim { owner: a, player: v2p, claim: pda::vrf_claim(&v2p), ..Default::default() }.ix(), Some(6007)),
        ("admin_close_orphaned_game_v2", ix::AdminCloseOrphanedGameV2 { owner: a, player: victim, game: pda::game_v2(&victim), ..Default::default() }.ix(), Some(6007)),
        ("reveal_tile", ix::RevealTile { game: lgame, house_authority: a, ..Default::default() }.ix(1, false), Some(6007)),
        ("settle_game", ix::SettleGame { game: lgame, player_stats: pda::stats(&victim), house_authority: a, treasury: w.treasury, ..Default::default() }.ix(0b1, [7; 32]), Some(6007)),
        ("settle_game treasury swap", ix::SettleGame { game: lgame, player_stats: pda::stats(&victim), house_authority: w.house, treasury: a, ..Default::default() }.ix(0b1, [7; 32]), Some(6007)),
        ("cash_out other's game", ix::CashOut { game: lgame, player: a, ..Default::default() }.ix(), Some(6007)),
        ("refund_expired other's game", ix::RefundExpired { game: lgame, player: a, ..Default::default() }.ix(), Some(6007)),
        ("close_game other's game", ix::CloseGame { game: lgame, player: a }.ix(), Some(6007)),
        ("request_withdraw other's LP", ix::RequestWithdraw { position: pda::lp(&victim), user: a, ..Default::default() }.ix(1), Some(2006)),
        ("close_lp other's LP", ix::CloseLpPosition { position: pda::lp(&victim), user: a }.ix(), Some(2006)),
        ("claim_referral other's", ix::ClaimReferral { referral_account: pda::referral(&referrer), referrer: a }.ix(), Some(2006)),
        ("refund_stalled_vrf stranger", ix::RefundStalledVrf { caller: a, player: v2p, claim: pda::vrf_claim(&v2p), game: vgame, ..Default::default() }.ix(), Some(6007)),
        ("cash_out_vrf stranger", ix::CashOutVrf { signer: a, game: vgame }.ix(), None),
        ("settle_and_undelegate stranger", ix::SettleAndUndelegateVrf { payer: a, game: vgame, ..Default::default() }.ix(), None),
        ("reveal_request_vrf stranger", ix::RevealRequestVrf { session: a, game: vgame, ..Default::default() }.ix(1, 1), None),
        ("reveal_callback fake identity", ix::RevealCallbackVrf { vrf_program_identity: a, game: vgame }.ix([0; 32]), Some(2012)),
        ("settle_vrf redirect payout", ix::SettleVrf { payer: a, player: a, claim: pda::vrf_claim(&v2p), game: vgame, treasury: w.treasury,
            player_stats: pda::stats(&v2p), ..Default::default() }.ix(), Some(2006)),
        ("refund_stalled_vrf redirect refund", ix::RefundStalledVrf { caller: a, player: a, claim: pda::vrf_claim(&v2p), game: vgame, ..Default::default() }.ix(), Some(2006)),
    ];
    let mut bad = vec![];
    for (name, i, code) in cases {
        let d = p.run(&[i]);
        let ok = d.is_same() && !d.anchor.ok() && code.is_none_or(|c| d.anchor.code() == Some(c));
        println!("CASE {name}: anchor {} | port {}", fmt_err(&d.anchor.err), fmt_err(&d.port.err));
        if !ok { bad.push(format!("{name}\n{}", d.report())); }
    }
    assert_eq!(p.lamports(&ids::VAULT), vault_before);
    assert!(bad.is_empty(), "{}", bad.join("\n\n"));
}

/// Proof (no finding): type confusion. Each program-owned account type, placed where another type is
/// expected (at the right PDA address where possible), is rejected by the discriminator check.
#[test]
fn auth_type_confusion_rejected() {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    let player = p.user("player");
    let session = p.user("session");
    let vgame = p.start_game_vrf(player, 1, BET, session);
    let vgame_bytes = p.get(&vgame).unwrap().data;
    let claim_bytes = p.get(&pda::vrf_claim(&player)).unwrap().data;
    let mut bad = vec![];
    let mut chk = |p: &mut Pair, name: &str, i: Instruction| {
        let d = p.run(&[i]);
        println!("CASE {name}: anchor {} | port {}", fmt_err(&d.anchor.err), fmt_err(&d.port.err));
        if !d.is_same() || d.anchor.ok() { bad.push(format!("{name}\n{}", d.report())); }
    };
    // VrfGame bytes (621 B, larger than GameSession 180 B) at the legacy game PDA
    let lg = pda::game(&player);
    p.set_program_account(lg, vgame_bytes.clone());
    chk(&mut p, "cash_out VrfGame-as-GameSession", ix::CashOut { game: lg, player, ..Default::default() }.ix());
    // GameSession-sized forgery with VrfGame disc at the VRF game PDA is still a VrfGame; instead put a
    // VrfClaim (69 B) where the VrfGame is expected, and the VrfGame where the claim is expected.
    p.set_program_account(vgame, claim_bytes.clone());
    chk(&mut p, "cash_out_vrf VrfClaim-as-VrfGame", ix::CashOutVrf { signer: session, game: vgame }.ix());
    p.set_program_account(vgame, vgame_bytes.clone());
    let claim = pda::vrf_claim(&player);
    p.set_program_account(claim, vgame_bytes.clone());
    chk(&mut p, "settle_vrf VrfGame-as-VrfClaim", settle_vrf_ix(session, player, w.treasury));
    p.set_program_account(claim, claim_bytes);
    // Vault <-> VaultV2State swap
    chk(&mut p, "fund_vault v2-as-vault", ix::FundVault { vault: ids::V2_STATE, funder: w.owner, ..Default::default() }.ix(1));
    // ReferralAccount bytes at the player's stats PDA in settle_vrf
    let r = p.user("r");
    p.ok(&[ix::SetReferrer { player_stats: pda::stats(&r), referrer: player, referral_account: pda::referral(&player), player: r, ..Default::default() }.ix()]);
    let ra = p.get(&pda::referral(&player)).unwrap().data;
    p.set_program_account(pda::stats(&player), ra);
    chk(&mut p, "settle_vrf Referral-as-PlayerStats", settle_vrf_ix(session, player, w.treasury));
    assert!(bad.is_empty(), "{}", bad.join("\n\n"));
}
