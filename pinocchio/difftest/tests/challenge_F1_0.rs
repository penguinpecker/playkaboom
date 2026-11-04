//! Adversarial challenge of F1 (initialize_vault only by DEPLOYER). Each test is an attack variant that
//! must FAIL on the port. Anchor results are not asserted unless relevant (Anchor is the unfixed reference).
use difftest::*;

fn init(owner: Address, house: Address, treasury: Address) -> Instruction {
    ix::InitializeVault { house_authority: house, treasury, owner, ..Default::default() }.ix(100, 100, 1_000)
}

/// Pre-funded vault PDA (Allocate+Assign branch): stranger still 6055, deployer still succeeds.
#[test]
fn c1_prefunded_vault_pda() {
    let mut p = Pair::new();
    p.fund(ids::VAULT, 5 * LAMPORTS_PER_SOL);
    let s = p.user("stranger");
    assert_eq!(p.run(&[init(s, s, s)]).port.code(), Some(6055));
    let a = p.port.get_account(&ids::VAULT).unwrap();
    assert_eq!((a.owner, a.data.len()), (ids::SYSTEM, 0), "port: prefunded PDA untouched");
    let d = p.deployer();
    assert!(p.run(&[init(d, d, d)]).port.ok());
    let v = accounts::Vault::decode(&p.port.get_account(&ids::VAULT).unwrap().data).unwrap();
    assert_eq!(v.owner, DEPLOYER);
}

/// Stranger is fee payer and names DEPLOYER as owner but cannot sign for it: 3010 on both.
/// Stranger naming itself as house/treasury while DEPLOYER signs is the deployer's own choice (not an attack).
#[test]
fn c2_deployer_named_but_unsigned() {
    let mut p = Pair::new();
    let s = p.user("stranger");
    let d = p.deployer();
    let mut i = init(d, s, s);
    i.accounts[3].is_signer = false;
    assert_eq!(p.run_as(s, &[i]).port.code(), Some(3010));
}

/// Same-tx bundling: [deployer init, stranger init] and [stranger init, deployer init] both revert whole tx
/// on the port; after a real deployer init, nobody (incl. the deployer) can re-init and overwrite owner.
#[test]
fn c3_bundled_and_reinit() {
    let mut p = Pair::new();
    let s = p.user("stranger");
    let d = p.deployer();
    assert!(!p.run(&[init(s, s, s), init(d, d, d)]).port.ok());
    assert!(p.port.get_account(&ids::VAULT).is_none_or(|a| a.lamports == 0));
    assert!(!p.run(&[init(d, d, d), init(s, s, s)]).port.ok());
    assert!(p.port.get_account(&ids::VAULT).is_none_or(|a| a.lamports == 0));
    assert!(p.run(&[init(d, d, d)]).port.ok());
    assert!(!p.run(&[init(s, s, s)]).port.ok());
    assert!(!p.run(&[init(d, s, s)]).port.ok());
    let v = accounts::Vault::decode(&p.port.get_account(&ids::VAULT).unwrap().data).unwrap();
    assert_eq!((v.owner, v.house_authority, v.treasury), (DEPLOYER, DEPLOYER, DEPLOYER));
}

/// Next singleton (v2_state) and ownership handover cannot be front-run by a stranger.
#[test]
fn c4_v2_and_ownership_not_frontrunnable() {
    let mut p = Pair::new();
    let s = p.user("stranger");
    let d = p.deployer();
    assert!(p.run(&[init(d, d, d)]).port.ok());
    assert!(p.run(&[ix::FundVault { funder: d, ..Default::default() }.ix(10 * LAMPORTS_PER_SOL)]).port.ok());
    assert_eq!(p.run(&[ix::InitializeV2 { owner: s, ..Default::default() }.ix()]).port.code(), Some(6007));
    assert!(p.port.get_account(&ids::V2_STATE).is_none_or(|a| a.lamports == 0));
    assert!(!p.run(&[ix::AcceptOwnership { new_owner: s, ..Default::default() }.ix()]).port.ok());
    assert!(p.run(&[ix::InitializeV2 { owner: d, ..Default::default() }.ix()]).port.ok());
}
