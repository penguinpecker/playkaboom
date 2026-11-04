//! F1 (AUTH-1/MONEY-4/PINO-1): only `DEPLOYER` may sign `initialize_vault`. Anchor has no such check,
//! so a stranger's init is an INTENDED divergence (Anchor ok, port 6055). See spec/FIXES.md section 2.
use difftest::*;

fn init(owner: Address) -> Instruction {
    ix::InitializeVault { house_authority: owner, treasury: owner, owner, ..Default::default() }.ix(100, 100, 1_000)
}

#[test]
fn f1_stranger_cannot_initialize() {
    let mut p = Pair::new();
    let stranger = p.user("stranger");
    let d = p.run(&[init(stranger)]);
    assert!(d.anchor.ok());
    assert_eq!(d.port.code(), Some(6055));
    assert!(p.port.get_account(&ids::VAULT).is_none_or(|a| a.lamports == 0), "port: no vault created");
}

#[test]
fn f1_deployer_initializes_after_failed_frontrun() {
    let mut p = Pair::new();
    let stranger = p.user("stranger");
    assert_eq!(p.run(&[init(stranger)]).port.code(), Some(6055));
    let owner = p.deployer();
    let d = p.run(&[init(owner)]);
    assert!(!d.anchor.ok() && d.port.ok(), "{}", d.report());
    let v = accounts::Vault::decode(&p.port.get_account(&ids::VAULT).unwrap().data).unwrap();
    assert_eq!((v.owner, v.house_authority, v.treasury), (DEPLOYER, DEPLOYER, DEPLOYER));
    assert!(p.run(&[ix::FundVault { funder: owner, ..Default::default() }.ix(LAMPORTS_PER_SOL)]).port.ok());
    assert_eq!(p.run(&[ix::AllowlistAdd { owner: stranger, ..Default::default() }.ix(stranger)]).port.code(), Some(6007));
    let d = p.run(&[ix::WithdrawToTreasury { treasury: stranger, destination: stranger, ..Default::default() }.ix(u64::MAX)]);
    assert_eq!(d.port.code(), Some(6007));
}

#[test]
fn f1_deployer_not_signer_3010() {
    let mut p = Pair::new();
    let owner = p.deployer();
    let mut i = init(owner);
    i.accounts[3].is_signer = false;
    p.run(&[i]).assert_err(3010);
    // and the signed deployer init stays byte-identical to Anchor
    p.ok(&[init(owner)]);
}
