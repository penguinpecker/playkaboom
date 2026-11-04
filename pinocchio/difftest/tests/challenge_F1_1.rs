//! Adversarial challenge of F1 (deployer-only `initialize_vault`). Each test tries a way around the
//! check or a way to grief the deployer's init; all are expected to FAIL to break it.
use difftest::*;

fn init(owner: Address, house: Address, treasury: Address) -> Instruction {
    ix::InitializeVault { house_authority: house, treasury, owner, ..Default::default() }.ix(100, 100, 1_000)
}
fn sys_transfer(from: Address, to: Address, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction { program_id: ids::SYSTEM, accounts: vec![AccountMeta::new(from, true), AccountMeta::new(to, false)], data }
}

/// Stranger owner with DEPLOYER as house/treasury (or a DEPLOYER-signed fee payer) is still rejected.
#[test]
fn c1_deployer_in_other_slots_does_not_pass() {
    let mut p = Pair::new();
    let s = p.user("stranger");
    let dep = p.deployer();
    assert_eq!(p.run(&[init(s, DEPLOYER, DEPLOYER)]).port.code(), Some(6055));
    // DEPLOYER is the fee payer (a signer of the tx) but not the `owner` account
    assert_eq!(p.run_as(dep, &[init(s, s, s)]).port.code(), Some(6055));
    assert!(p.port.get_account(&ids::VAULT).is_none_or(|a| a.lamports == 0));
}

/// Attacker pre-funds the vault PDA and bundles a failing init: cannot block the deployer.
#[test]
fn c2_prefund_and_failed_frontrun_cannot_block_deployer() {
    let mut p = Pair::new();
    let s = p.user("stranger");
    let d = p.run(&[sys_transfer(s, ids::VAULT, 7), init(s, s, s)]);
    assert_eq!(d.port.code(), Some(6055)); // Anchor accepts (the original hole); port reverts atomically
    assert!(p.port.get_account(&ids::VAULT).is_none_or(|a| a.lamports == 0), "pre-fund reverted too");
    let mut p = Pair::new(); // fresh pair: both sides agree again
    let s = p.user("stranger");
    p.run(&[sys_transfer(s, ids::VAULT, LAMPORTS_PER_SOL)]).assert_ok();
    let dep = p.deployer();
    // fee payer is the stranger; owner = DEPLOYER signs. Both sides: same init on a pre-funded PDA.
    p.run_as(s, &[init(dep, dep, dep)]).assert_ok().assert_same();
    let v = accounts::Vault::decode(&p.port.get_account(&ids::VAULT).unwrap().data).unwrap();
    assert_eq!(v.owner, DEPLOYER);
    // re-init by anyone (deployer included) fails the same on both sides
    p.run(&[init(dep, s, s)]).assert_failed().assert_same();
    p.run(&[init(s, s, s)]).assert_failed().assert_same();
}

/// After the deployer's init a stranger cannot take the next singleton (v2 state).
#[test]
fn c3_stranger_cannot_initialize_v2() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * LAMPORTS_PER_SOL);
    let s = p.user("stranger");
    p.run(&[ix::InitializeV2 { owner: s, ..Default::default() }.ix()]).assert_err(6007);
    p.init_v2(&w);
}

/// Handover to a non-deployer owner works (the planned move to Squads) and leaves DEPLOYER powerless.
#[test]
fn c4_handover_strips_deployer() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let squads = p.user("squads");
    p.ok(&[ix::ProposeOwner { owner: w.owner, ..Default::default() }.ix(squads)]);
    p.ok(&[ix::AcceptOwnership { new_owner: squads, ..Default::default() }.ix()]);
    let v = accounts::Vault::decode(&p.port.get_account(&ids::VAULT).unwrap().data).unwrap();
    assert_eq!(v.owner, squads);
    p.run(&[ix::AllowlistAdd { owner: DEPLOYER, ..Default::default() }.ix(DEPLOYER)]).assert_err(6007);
}
