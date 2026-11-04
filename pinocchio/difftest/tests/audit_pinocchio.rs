//! Adversarial audit, Pinocchio memory/runtime lens: aliasing, closed-account reuse in one tx,
//! short raw accounts, MAX_ACCOUNTS (10) overflow, process_undelegation seed edges.
//! Every case must be DIFF-POLICY identical between the Anchor reference and kaboom-p.
use difftest::*;

const BET: u64 = 10_000_000;

fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    rem != 0 && u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
fn rand_for(safe: u8, mines: u8, mine: bool) -> [u8; 32] {
    (0..=255u8).map(|b| [b; 32]).find(|r| is_mine(r, safe, mines) == mine).unwrap()
}
fn start_ix(player: Address, session: Address) -> Instruction {
    ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), player_stats: pda::stats(&player), ..Default::default() }
        .ix(1, BET, session)
}
fn settle_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury, player_stats: pda::stats(&player), ..Default::default() }.ix()
}
fn refund_ix(caller: Address, player: Address) -> Instruction {
    ix::RefundStalledVrf { caller, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), ..Default::default() }.ix()
}
fn sys_transfer(from: Address, to: Address, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction { program_id: ids::SYSTEM, accounts: vec![AccountMeta::new(from, true), AccountMeta::new(to, false)], data }
}

struct V { p: Pair, w: World, player: Address, session: Address, game: Address, claim: Address }

fn started(with_referrer: bool) -> V {
    let mut p = Pair::new();
    let w = p.house_world();
    p.enable_vrf(&w, key("validator"));
    let player = p.user("player");
    let session = p.user("session");
    if with_referrer {
        let r = p.user("referrer");
        p.ok(&[ix::SetReferrer { player_stats: pda::stats(&player), referrer: r, referral_account: pda::referral(&r), player, ..Default::default() }.ix()]);
    }
    p.start_game_vrf(player, 1, BET, session);
    V { p, w, player, session, game: pda::vrf_game(&player), claim: pda::vrf_claim(&player) }
}
fn won(with_referrer: bool) -> V {
    let mut v = started(with_referrer);
    let g = v.p.get(&v.game).unwrap().data;
    let r = rand_for(g[77], g[74], false);
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 3; });
    v.p.ok(&[ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game: v.game }.ix(r)]);
    v.p.ok(&[ix::CashOutVrf { signer: v.session, game: v.game }.ix()]);
    v
}

/// settle_vrf closes claim + game; start_game_vrf re-inits both PDAs in the SAME tx.
#[test]
fn audit_settle_then_restart_same_tx() {
    let mut v = won(false);
    v.p.run(&[settle_ix(v.session, v.player, v.w.treasury), start_ix(v.player, v.session)]).assert_ok();
}

/// Closed claim reused in the same tx: the second settle must fail identically.
#[test]
fn audit_settle_twice_same_tx() {
    let mut v = won(false);
    let s = settle_ix(v.session, v.player, v.w.treasury);
    let d = v.p.run(&[s.clone(), s]);
    d.assert_same().assert_failed();
}

/// refund_stalled_vrf zero-closes the game (owner + len kept, 0 lamports). Re-credit it in the same
/// tx so it survives; then re-refund / restart / delegate in later txs.
#[test]
fn audit_zero_closed_game_recredited_same_tx() {
    let mut v = started(false);
    v.p.warp(START_SLOT + 26);
    let pl = v.player;
    v.p.run(&[refund_ix(pl, pl), sys_transfer(pl, v.game, rent_min(621))]).assert_ok();
    let g = v.p.get(&v.game).unwrap();
    assert_eq!((g.owner, g.data.len(), g.data.iter().all(|b| *b == 0)), (PROGRAM_ID, 621, true));
    // claim is gone, so refund cannot be replayed
    v.p.run(&[refund_ix(pl, pl)]).assert_same().assert_failed();
    // init on a program-owned zeroed account fails the same way on both sides
    v.p.run(&[start_ix(pl, v.session)]).assert_same().assert_failed();
    v.p.run(&[delegate_vrf_ix(pl)]).assert_same().assert_failed();
    v.p.run(&[ix::CashOutVrf { signer: pl, game: v.game }.ix()]).assert_same().assert_failed();
}

/// refund then restart in the same tx (zero-closed game still owned by the program).
#[test]
fn audit_refund_then_restart_same_tx() {
    let mut v = started(false);
    v.p.warp(START_SLOT + 26);
    v.p.run(&[refund_ix(v.player, v.player), start_ix(v.player, v.session)]).assert_same().assert_failed();
}

/// remaining_accounts[0] aliased onto fixed slots (referral must be the PDA -> 6022).
#[test]
fn audit_settle_referral_aliases() {
    let v = won(true);
    for alias in [v.claim, v.game, ids::VAULT, ids::V2_STATE, pda::stats(&v.player), v.player] {
        let mut p = won(true).p; // deterministic keys: same world each time
        let mut s = settle_ix(v.session, v.player, v.w.treasury);
        s.accounts.push(AccountMeta::new(alias, false));
        p.run(&[s]).assert_err(6022);
    }
}

/// More than MAX_ACCOUNTS (10): referral at index 9, then duplicates and junk beyond it.
#[test]
fn audit_settle_more_than_max_accounts() {
    let mut v = won(true);
    let referrer = v.p.user("referrer");
    let mut s = settle_ix(v.session, v.player, v.w.treasury);
    s.accounts.push(AccountMeta::new(pda::referral(&referrer), false));
    s.accounts.push(AccountMeta::new(ids::VAULT, false));
    s.accounts.push(AccountMeta::new(v.claim, false));
    s.accounts.push(AccountMeta::new_readonly(key("junk"), false));
    v.p.run(&[s]).assert_ok();
}

/// Short raw VrfGame (80 bytes = VRF_GAME_MIN_RAW_LEN) for the raw-read paths.
#[test]
fn audit_short_raw_game() {
    let mut v = started(false);
    let full = v.p.get(&v.game).unwrap();
    let short: Vec<u8> = full.data[..80].to_vec();
    v.p.set_account(v.game, Account { lamports: full.lamports, data: short.clone(), owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
    v.p.warp(START_SLOT + 26);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_ok();

    let mut v = started(false);
    v.p.set_account(v.game, Account { lamports: full.lamports, data: short, owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
    v.p.run(&[delegate_vrf_ix(v.player)]).assert_same();
    // 79 bytes: below the raw minimum
    let mut v = started(false);
    v.p.set_account(v.game, Account { lamports: full.lamports, data: full.data[..79].to_vec(), owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
    v.p.run(&[delegate_vrf_ix(v.player)]).assert_err(6049);
    v.p.warp(START_SLOT + 26);
    v.p.run(&[refund_ix(v.player, v.player)]).assert_err(6049);
}

/// process_undelegation: payer == base, 16 seeds, a 33-byte seed, empty seed list.
#[test]
fn audit_undelegation_edges() {
    let mut v = started(false);
    let er = v.p.get(&v.game).unwrap().data;
    let base = v.game;
    let buffer = pda::undelegate_buffer(&base);
    v.p.set_account(base, Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    v.p.set_data(buffer, ids::DLP, er);
    let payer = v.p.user("dlp-payer");
    let mk = |payer: Address, seeds: Vec<Vec<u8>>| {
        let mut u = ix::ProcessUndelegation { base_account: base, buffer, payer, ..Default::default() }.ix(seeds);
        u.accounts[1].is_signer = true;
        u.accounts[2].is_signer = true;
        u
    };
    let good = vec![b"kaboom_vrf_game".to_vec(), v.player.as_ref().to_vec()];
    v.p.run(&[mk(base, good.clone())]).assert_same().assert_failed();
    v.p.run(&[mk(payer, vec![vec![1u8]; 16])]).assert_same().assert_failed();
    v.p.run(&[mk(payer, vec![vec![7u8; 33]])]).assert_same().assert_failed();
    v.p.run(&[mk(payer, vec![])]).assert_same().assert_failed();
    // buffer passed twice (also as payer)
    v.p.run(&[mk(buffer, good.clone())]).assert_same().assert_failed();
    v.p.run(&[mk(payer, good)]).assert_ok();
}

/// Callback identity slot aliased to the game, and game passed as session in reveal_request.
#[test]
fn audit_vrf_slot_aliases() {
    let mut v = started(false);
    v.p.patch(v.game, |d| { d[79] = 1; d[80] = 3; });
    v.p.run(&[ix::RevealCallbackVrf { vrf_program_identity: v.game, game: v.game }.ix([1; 32])]).assert_same().assert_failed();
    v.p.run(&[ix::CashOutVrf { signer: v.game, game: v.game }.ix()]).assert_same().assert_failed();
    v.p.run(&[ix::SettleAndUndelegateVrf { payer: v.game, game: v.game, ..Default::default() }.ix()]).assert_same().assert_failed();
    // refund with player slot = vault / v2 (claim PDA then derives from the wrong key)
    v.p.warp(START_SLOT + 26);
    v.p.run(&[refund_ix(v.player, ids::VAULT)]).assert_same().assert_failed();
    v.p.run(&[refund_ix(ids::V2_STATE, v.player)]).assert_same().assert_failed();
}

/// Args still decode when the tx carries more accounts than MAX_ACCOUNTS (entrypoint must skip them).
#[test]
fn audit_args_after_skipped_accounts() {
    let mut p = Pair::new();
    p.house_world();
    let u = p.user("lp");
    let mut i = ix::LpDeposit { position: pda::lp(&u), user: u, ..Default::default() }.ix(LAMPORTS_PER_SOL);
    for n in 0..12 { i.accounts.push(AccountMeta::new_readonly(key(&format!("extra{n}")), false)); }
    i.accounts.push(AccountMeta::new(ids::VAULT, false)); // duplicate past the cap
    p.run(&[i]).assert_ok();
    let pos = p.read(&pda::lp(&u), accounts::LpPosition::decode);
    assert!(pos.units > 0);
}

/// INHERITED (D15), FIXED on the port. INTENDED: F1. In Anchor initialize_vault is permissionless: the
/// first caller becomes vault.owner + treasury, the real owner's init fails, and anything later funded
/// is withdrawable by the attacker. On the port the squat fails (6055) and the deployer's init lands.
#[test]
fn audit_init_vault_frontrun_inherited() {
    let mut p = Pair::new();
    let atk = p.user("attacker");
    let owner = p.deployer();
    let d = p.run(&[ix::InitializeVault { house_authority: atk, treasury: atk, owner: atk, ..Default::default() }.ix(100, 100, 1_000)]);
    assert!(d.anchor.ok());
    assert_eq!(d.port.code(), Some(6055));
    let d = p.run(&[ix::InitializeVault { house_authority: owner, treasury: owner, owner, ..Default::default() }.ix(100, 100, 1_000)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
    assert!(p.run(&[ix::FundVault { funder: owner, ..Default::default() }.ix(10 * LAMPORTS_PER_SOL)]).port.ok());
    assert_eq!(p.run(&[ix::AllowlistAdd { owner: atk, ..Default::default() }.ix(atk)]).port.code(), Some(6007));
    assert_eq!(p.run(&[ix::WithdrawToTreasury { treasury: atk, destination: atk, ..Default::default() }.ix(u64::MAX)]).port.code(), Some(6007));
    let v = accounts::Vault::decode(&p.port.get_account(&ids::VAULT).unwrap().data).unwrap();
    assert_eq!(v.owner, DEPLOYER);
}
