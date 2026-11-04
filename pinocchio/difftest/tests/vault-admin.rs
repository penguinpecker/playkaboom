//! vault-admin group (spec/vault-admin.md): initialize_vault, fund_vault, withdraw_to_treasury,
//! unlock_operator_position, update_vault, allowlist_add, allowlist_remove, propose_owner,
//! cancel_proposed_owner, accept_ownership.
//!
//! Every case runs the same tx on the Anchor reference and the port. Cases inside one test are collected
//! (`Chk`) so one diff does not hide the rest; the test panics at the end listing every `DIFF` (policy
//! disagreement) and every `UNEXPECTED` (both agree but not on the outcome the spec predicts).
//! CU for each happy path is printed as `CU <ix>: anchor A port P` (run with --nocapture).
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const VAULT_RENT: u64 = (428 + 128) * RENT_PER_BYTE; // 2_824_480

#[derive(Clone, Copy, Debug)]
enum E {
    Ok,
    Err(u32),
    Fail,
    Same,
}

#[derive(Default)]
struct Chk(Vec<String>);
impl Chk {
    fn c(&mut self, tag: &str, d: &Diff, e: E) {
        println!("CASE {tag} => anchor {} | port {}", fmt_err(&d.anchor.err), fmt_err(&d.port.err));
        for a in &d.accepted { println!("ACCEPTED {tag}: {a}"); }
        if !d.is_same() {
            self.0.push(format!("DIFF {tag}\n{}", d.report()));
            return;
        }
        let good = match e {
            E::Ok => d.anchor.ok(),
            E::Err(c) => d.anchor.code() == Some(c) && d.port.code() == Some(c),
            E::Fail => !d.anchor.ok() && !d.port.ok(),
            E::Same => true,
        };
        if !good { self.0.push(format!("UNEXPECTED {tag} (wanted {e:?})\n{}", d.report())); }
    }
    fn cpi(&mut self, tag: &str, d: &Diff) {
        if !d.cpi_diffs.is_empty() { self.0.push(format!("CPI-DIFF {tag}\n{}", d.report())); }
    }
    fn done(self) {
        if !self.0.is_empty() { panic!("{} problem(s):\n{}", self.0.len(), self.0.join("\n")); }
    }
}

fn cu(tag: &str, d: &Diff) {
    let (a, p) = d.cu();
    println!("CU {tag}: anchor {a} port {p}");
}

fn vault(p: &Pair) -> accounts::Vault { p.read(&ids::VAULT, accounts::Vault::decode) }
fn v2(p: &Pair) -> accounts::VaultV2State { p.read(&ids::V2_STATE, accounts::VaultV2State::decode) }
fn set_vault(p: &mut Pair, f: impl FnOnce(&mut accounts::Vault)) {
    let mut v = vault(p);
    f(&mut v);
    p.patch(ids::VAULT, |d| d[..428].copy_from_slice(&v.encode()));
}
fn set_v2(p: &mut Pair, f: impl FnOnce(&mut accounts::VaultV2State)) {
    let mut v = v2(p);
    f(&mut v);
    p.patch(ids::V2_STATE, |d| d[..191].copy_from_slice(&v.encode()));
}
fn allow(p: &mut Pair, w: &World, a: Address) {
    p.ok(&[ix::AllowlistAdd { owner: w.owner, ..Default::default() }.ix(a)]);
}
fn uv(owner: Address) -> ix::UpdateVault { ix::UpdateVault { owner, ..Default::default() } }
fn none7() -> (Option<u16>, Option<u16>, Option<u16>, Option<u16>, Option<bool>, Option<Address>, Option<Address>) {
    (None, None, None, None, None, None, None)
}
fn uv_ix(owner: Address, a: (Option<u16>, Option<u16>, Option<u16>, Option<u16>, Option<bool>, Option<Address>, Option<Address>)) -> Instruction {
    uv(owner).ix(a.0, a.1, a.2, a.3, a.4, a.5, a.6)
}
type A = (Option<u16>, Option<u16>, Option<u16>, Option<u16>, Option<bool>, Option<Address>, Option<Address>);
fn with(f: impl FnOnce(&mut A)) -> A { let mut x = none7(); f(&mut x); x }
fn ev(d: &Diff) -> Vec<&'static str> { d.anchor.events.iter().map(|e| event_name(e)).collect() }

/// Account-level substitutions on a typed account (Vault or VaultV2State) used at `idx` of `base`.
/// Each case sets the account, runs, then restores it.
#[allow(clippy::too_many_arguments)]
fn typed_battery(p: &mut Pair, k: &mut Chk, tag: &str, base: &Instruction, key: Address, idx: usize,
                 space: usize, bool_off: usize, bump_off: usize, other_disc: [u8; 8]) {
    let orig = p.get(&key).unwrap();
    // snapshot every account of the tx so a case that succeeds (E::Same) does not leak into the next
    let snap: Vec<(Address, Option<Account>)> = base.accounts.iter().map(|m| (m.pubkey, p.get(&m.pubkey))).collect();
    let restore = |p: &mut Pair| for (k, a) in &snap {
        p.set_account(*k, a.clone().unwrap_or(Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 }));
    };
    type M = Box<dyn Fn(&mut Account)>;
    let cases: Vec<(&str, M, E)> = vec![
        ("owner=DLP", Box::new(|a| a.owner = ids::DLP), E::Err(3007)),
        ("owner=System (lamports>0, no data)", Box::new(|a| { a.owner = ids::SYSTEM; a.data.clear(); }), E::Err(3007)),
        ("owner=System (lamports>0, data kept)", Box::new(|a| a.owner = ids::SYSTEM), E::Err(3007)),
        ("absent", Box::new(|a| *a = Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 }), E::Err(3012)),
        ("data len 0", Box::new(|a| a.data.clear()), E::Err(3001)),
        ("data len 7", Box::new(|a| a.data.truncate(7)), E::Err(3001)),
        ("disc flipped", Box::new(|a| a.data[3] ^= 0x40), E::Err(3002)),
        ("other type's disc", Box::new(move |a| a.data[..8].copy_from_slice(&other_disc)), E::Err(3002)),
        ("data len 8", Box::new(|a| a.data.truncate(8)), E::Err(3003)),
        ("data len SPACE-1", Box::new(move |a| a.data.truncate(space - 1)), E::Err(3003)),
        ("bool byte = 2", Box::new(move |a| a.data[bool_off] = 2), E::Err(3003)),
        ("bool byte = 255", Box::new(move |a| a.data[bool_off] = 255), E::Err(3003)),
        ("stored bump - 1", Box::new(move |a| a.data[bump_off] = a.data[bump_off].wrapping_sub(1)), E::Err(2006)),
        ("stored bump 0", Box::new(move |a| a.data[bump_off] = 0), E::Err(2006)),
        ("data longer than SPACE (+72)", Box::new(move |a| a.data.resize(space + 72, 0xab)), E::Same),
    ];
    for (name, m, e) in cases {
        let mut a = orig.clone();
        m(&mut a);
        p.set_account(key, a);
        let d = p.run(std::slice::from_ref(base));
        k.c(&format!("{tag}: {key}: {name}"), &d, e);
        restore(p);
    }
    // fake copy at another address (wrong PDA)
    let fake = key_of(&format!("{tag}-fake-{idx}"));
    p.set_account(fake, orig.clone());
    let mut i = base.clone();
    i.accounts[idx].pubkey = fake;
    let d = p.run(&[i]);
    k.c(&format!("{tag}: idx{idx} fake copy at other address"), &d, E::Err(2006));
    // not writable
    let mut i = base.clone();
    i.accounts[idx].is_writable = false;
    let d = p.run(&[i]);
    k.c(&format!("{tag}: idx{idx} not writable"), &d, E::Err(2000));
}
fn key_of(s: &str) -> Address { key(s) }

/// Instruction-level attacks: signer cleared, wrong signer, short account lists, bad data.
fn ix_battery(p: &mut Pair, k: &mut Chk, tag: &str, base: &Instruction, signer: usize, wrong_signer: Option<u32>, has_args: bool) {
    let mut i = base.clone();
    i.accounts[signer].is_signer = false;
    k.c(&format!("{tag}: signer cleared"), &p.run(&[i]), E::Err(3010));
    if let Some(code) = wrong_signer {
        let intruder = p.user("intruder");
        let mut i = base.clone();
        i.accounts[signer].pubkey = intruder;
        k.c(&format!("{tag}: someone else signs"), &p.run(&[i]), E::Err(code));
    }
    for n in 0..base.accounts.len() {
        let mut i = base.clone();
        i.accounts.truncate(n);
        k.c(&format!("{tag}: accounts truncated to {n}"), &p.run(&[i]), if n == 0 { E::Err(3005) } else { E::Fail });
    }
    for n in [0usize, 1, 7] {
        let mut i = base.clone();
        i.data.truncate(n);
        k.c(&format!("{tag}: data len {n}"), &p.run(&[i]), E::Err(101));
    }
    let mut i = base.clone();
    i.data[..8].copy_from_slice(&[0xff; 8]);
    k.c(&format!("{tag}: unknown disc"), &p.run(&[i]), E::Err(101));
    if has_args {
        let mut i = base.clone();
        i.data.pop();
        k.c(&format!("{tag}: args 1 byte short"), &p.run(&[i]), E::Err(102));
        let mut i = base.clone();
        i.data.truncate(8);
        k.c(&format!("{tag}: args empty"), &p.run(&[i]), E::Err(102));
    }
}

/// Last: trailing data + 20 extra accounts (more than the port's MAX_ACCOUNTS = 10). Mutates state.
fn tail_battery(p: &mut Pair, k: &mut Chk, tag: &str, base: &Instruction) {
    let mut i = base.clone();
    for n in 0..20 { i.accounts.push(AccountMeta::new_readonly(key(&format!("extra{n}")), false)); }
    i.accounts.push(AccountMeta::new(base.accounts[0].pubkey, false)); // duplicate of slot 0 as remaining
    i.data.extend_from_slice(&[9, 9, 9, 9, 9]);
    k.c(&format!("{tag}: trailing data + 21 extra accounts"), &p.run(&[i]), E::Same);
}

fn vault_typed(p: &mut Pair, k: &mut Chk, tag: &str, base: &Instruction) {
    typed_battery(p, k, tag, base, ids::VAULT, 0, 428, 137, 104, accounts::VaultV2State::DISC);
}

// ───────────────────────────── initialize_vault ─────────────────────────────

fn init_ix(owner: Address, house: Address, treasury: Address, a: (u16, u16, u16)) -> Instruction {
    ix::InitializeVault { house_authority: house, treasury, owner, ..Default::default() }.ix(a.0, a.1, a.2)
}

#[test]
fn initialize_vault_happy_and_reinit() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let owner = p.deployer();
    let (house, treasury) = (key("house"), key("treasury"));
    let d = p.run(&[init_ix(owner, house, treasury, (100, 100, 1_000))]);
    k.c("init happy", &d, E::Ok);
    k.cpi("init happy", &d);
    cu("initialize_vault", &d);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: InitializeVault"]);
    assert_eq!(ev(&d), ["VaultInitialized"]);
    let v = vault(&p);
    assert_eq!((v.owner, v.house_authority, v.treasury, v.bump, v.treasury_split_bps, v.version), (owner, house, treasury, 254, 5_000, 1));
    assert_eq!(p.lamports(&ids::VAULT), VAULT_RENT);
    // second init: system Allocate refuses (AccountAlreadyInUse = Custom(0))
    let d = p.run(&[init_ix(owner, house, treasury, (100, 100, 1_000))]);
    k.c("re-init same owner", &d, E::Err(0));
    let other = p.user("other");
    let d = p.run(&[init_ix(other, other, other, (1, 1, 1))]);
    k.c("re-init by someone else", &d, E::Err(0));
    k.done();
}

#[test]
fn initialize_vault_arg_bounds() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let owner = p.deployer();
    let (house, treasury) = (key("house"), key("treasury"));
    for a in [(1_001, 100, 1_000), (u16::MAX, 100, 1_000), (100, 0, 1_000), (100, 1_001, 1_000), (100, u16::MAX, 1_000),
              (100, 100, 0), (100, 100, 5_001), (100, 100, u16::MAX), (u16::MAX, 0, 0)] {
        let d = p.run(&[init_ix(owner, house, treasury, a)]);
        k.c(&format!("init args {a:?}"), &d, E::Err(6010));
    }
    assert!(p.get(&ids::VAULT).is_none(), "failed init must leave no vault");
    for a in [(0, 1, 1), (1_000, 1_000, 5_000), (0, 1_000, 1)] {
        let mut p = Pair::new();
        let owner = p.deployer();
        let d = p.run(&[init_ix(owner, house, treasury, a)]);
        k.c(&format!("init args {a:?}"), &d, E::Ok);
    }
    k.done();
}

#[test]
fn initialize_vault_prefunded_pda() {
    let mut k = Chk::default();
    for dust in [1, VAULT_RENT - 1, VAULT_RENT, VAULT_RENT + 1, 10 * SOL] {
        let mut p = Pair::new();
        let owner = p.deployer();
        p.fund(ids::VAULT, dust);
        let d = p.run(&[init_ix(owner, key("house"), key("treasury"), (100, 100, 1_000))]);
        k.c(&format!("init pre-funded {dust}"), &d, E::Ok);
        k.cpi(&format!("init pre-funded {dust}"), &d);
        if dust == 1 { cu("initialize_vault (pre-funded 1 lamport)", &d); }
        if d.anchor.ok() {
            assert_eq!(p.lamports(&ids::VAULT), dust.max(VAULT_RENT));
            let d = p.run(&[init_ix(owner, key("house"), key("treasury"), (100, 100, 1_000))]);
            k.c(&format!("re-init after pre-funded {dust}"), &d, E::Err(0));
        }
    }
    // pre-funded + owner not writable: Allocate/Assign succeed, then owner `mut` -> 2000 (no Transfer needed)
    let mut p = Pair::new();
    let owner = p.deployer();
    p.fund(ids::VAULT, SOL);
    let mut i = init_ix(owner, key("house"), key("treasury"), (100, 100, 1_000));
    i.accounts[3].is_writable = false;
    k.c("init pre-funded 1 SOL, owner not writable", &p.run(&[i.clone()]), E::Err(2000));
    // pre-funded 1 lamport + owner not writable: the top-up Transfer CPI fails first
    p.fund(ids::VAULT, 1);
    k.c("init pre-funded 1 lamport, owner not writable", &p.run(&[i]), E::Fail);
    // pre-funded and owner == vault (duplicate, signer) -> 4101
    let mut i = init_ix(owner, key("house"), key("treasury"), (100, 100, 1_000));
    i.accounts[3].pubkey = ids::VAULT;
    k.c("init pre-funded, owner = vault", &p.run(&[i]), E::Err(4101));
    // vault address holds a system-owned account with data -> Allocate fails
    p.set_account(ids::VAULT, Account { lamports: SOL, data: vec![1; 5], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    k.c("init: vault is system-owned with data", &p.run(&[init_ix(owner, key("house"), key("treasury"), (100, 100, 1_000))]), E::Fail);
    // vault address owned by another program
    p.set_account(ids::VAULT, Account { lamports: SOL, data: vec![], owner: ids::DLP, executable: false, rent_epoch: 0 });
    k.c("init: vault owned by DLP, empty", &p.run(&[init_ix(owner, key("house"), key("treasury"), (100, 100, 1_000))]), E::Fail);
    // vault already holds a valid Vault image but owned by us: Allocate refuses
    let img = accounts::Vault {
        owner, house_authority: owner, treasury: owner, bump: 254, house_edge_bps: 1, max_bet_bps: 1, max_payout_bps: 1,
        treasury_split_bps: 0, total_games: 0, total_wagered: 0, total_payouts: 0, paused: false, version: 1,
        allowlist_count: 0, withdraw_allowlist: [Address::default(); 8], pending_owner: Address::default(),
    };
    p.set_program_account(ids::VAULT, img.encode());
    k.c("init: vault already initialised", &p.run(&[init_ix(owner, key("house"), key("treasury"), (100, 100, 1_000))]), E::Err(0));
    k.done();
}

#[test]
fn initialize_vault_account_attacks() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let owner = p.deployer();
    let (house, treasury) = (key("house"), key("treasury"));
    let base = init_ix(owner, house, treasury, (100, 100, 1_000));
    let mut run = |p: &mut Pair, tag: &str, f: &dyn Fn(&mut Instruction), e: E| {
        let mut i = base.clone();
        f(&mut i);
        let d = p.run(&[i]);
        k.c(tag, &d, e);
    };
    run(&mut p, "init: vault = random key", &|i| i.accounts[0].pubkey = key("notvault"), E::Err(2006));
    run(&mut p, "init: vault = v2_state PDA", &|i| i.accounts[0].pubkey = ids::V2_STATE, E::Err(2006));
    run(&mut p, "init: vault = owner", &|i| i.accounts[0].pubkey = owner, E::Err(2006));
    run(&mut p, "init: vault not writable", &|i| i.accounts[0].is_writable = false, E::Fail);
    run(&mut p, "init: owner not signer", &|i| i.accounts[3].is_signer = false, E::Err(3010));
    run(&mut p, "init: owner not writable", &|i| i.accounts[3].is_writable = false, E::Fail);
    run(&mut p, "init: system_program = random", &|i| i.accounts[4].pubkey = key("notsys"), E::Err(3008));
    run(&mut p, "init: system_program = VRF program", &|i| i.accounts[4].pubkey = ids::VRF_PROGRAM, E::Err(3008));
    run(&mut p, "init: system_program = vault", &|i| i.accounts[4].pubkey = ids::VAULT, E::Err(3008));
    run(&mut p, "init: owner = vault (dup, empty PDA)", &|i| i.accounts[3].pubkey = ids::VAULT, E::Fail);
    for n in 0..5 {
        run(&mut p, &format!("init: accounts truncated to {n}"), &|i| i.accounts.truncate(n), if n == 0 { E::Err(3005) } else { E::Fail });
    }
    run(&mut p, "init: data len 7", &|i| i.data.truncate(7), E::Err(101));
    run(&mut p, "init: args 5 bytes", &|i| i.data.truncate(13), E::Err(102));
    run(&mut p, "init: args empty", &|i| i.data.truncate(8), E::Err(102));
    // order: phase A (signer, program) before phase B (seeds) before handler args
    run(&mut p, "init: bad vault + owner not signer", &|i| { i.accounts[0].pubkey = key("x"); i.accounts[3].is_signer = false; }, E::Err(3010));
    run(&mut p, "init: bad vault + bad system_program", &|i| { i.accounts[0].pubkey = key("x"); i.accounts[4].pubkey = key("y"); }, E::Err(3008));
    run(&mut p, "init: owner not signer + bad system_program", &|i| { i.accounts[3].is_signer = false; i.accounts[4].pubkey = key("y"); }, E::Err(3010));
    run(&mut p, "init: bad vault + bad args", &|i| { i.accounts[0].pubkey = key("x"); i.data[8] = 0xff; i.data[9] = 0xff; }, E::Err(2006));
    run(&mut p, "init: short args + owner not signer", &|i| { i.data.truncate(12); i.accounts[3].is_signer = false; }, E::Err(102));
    run(&mut p, "init: bad args + owner not signer", &|i| { i.data[10] = 0; i.data[11] = 0; i.accounts[3].is_signer = false; }, E::Err(3010));
    // owner too poor for rent
    let poor = key("poor");
    p.fund(poor, 1_000);
    run(&mut p, "init: owner has 1000 lamports", &|i| i.accounts[3].pubkey = poor, E::Err(1));
    // owner owns data (system-owned with data) -> CreateAccount refuses `from` with data
    let dataful = key("dataful");
    p.set_account(dataful, Account { lamports: 10 * SOL, data: vec![0; 3], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    run(&mut p, "init: owner carries data", &|i| i.accounts[3].pubkey = dataful, E::Fail);
    assert!(p.get(&ids::VAULT).is_none());
    k.done();
}

#[test]
fn initialize_vault_odd_but_valid_keys() {
    let mut k = Chk::default();
    // house_authority = vault (dup), treasury = owner (dup)
    let mut p = Pair::new();
    let owner = p.deployer();
    let d = p.run(&[init_ix(owner, ids::VAULT, owner, (0, 1, 1))]);
    k.c("init house=vault treasury=owner", &d, E::Ok);
    // house = treasury = zero key (no check at init), trailing data, extra accounts, owner = fee payer
    let mut p = Pair::new();
    let owner = p.deployer();
    let mut i = init_ix(owner, Address::default(), Address::default(), (1_000, 1_000, 5_000));
    i.data.extend_from_slice(&[1, 2, 3]);
    for n in 0..12 { i.accounts.push(AccountMeta::new_readonly(key(&format!("extra{n}")), false)); }
    let d = p.run_as(owner, &[i]);
    k.c("init zero house/treasury, trailing data, 12 extra accts, owner pays fee", &d, E::Ok);
    k.cpi("init zero keys", &d);
    k.done();
}

// ───────────────────────────── fund_vault ─────────────────────────────

fn fund_ix(funder: Address, amount: u64) -> Instruction { ix::FundVault { funder, ..Default::default() }.ix(amount) }

#[test]
fn fund_vault_happy_and_bounds() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let d = p.run(&[fund_ix(w.owner, 5 * SOL)]);
    k.c("fund happy", &d, E::Ok);
    k.cpi("fund happy", &d);
    cu("fund_vault", &d);
    assert_eq!(ev(&d), ["VaultFunded"]);
    let stranger = p.user("stranger");
    k.c("fund by stranger 1 lamport", &p.run(&[fund_ix(stranger, 1)]), E::Ok);
    k.c("fund amount 0", &p.run(&[fund_ix(stranger, 0)]), E::Err(6009));
    k.c("fund > balance", &p.run(&[fund_ix(stranger, 101 * SOL)]), E::Err(1));
    k.c("fund u64::MAX", &p.run(&[fund_ix(stranger, u64::MAX)]), E::Err(1));
    // funder drains itself to exactly 0
    let exact = key("exact");
    p.fund(exact, 3 * SOL);
    k.c("fund whole balance", &p.run(&[fund_ix(exact, 3 * SOL)]), E::Ok);
    // funder carries data -> system Transfer refuses
    let dataful = key("dataful");
    p.set_account(dataful, Account { lamports: 10 * SOL, data: vec![0; 3], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    k.c("fund: funder carries data", &p.run(&[fund_ix(dataful, SOL)]), E::Fail);
    // funder program-owned
    let progowned = key("progowned");
    p.set_program_account(progowned, vec![0; 8]);
    k.c("fund: funder program-owned", &p.run(&[fund_ix(progowned, 1)]), E::Fail);
    // funder = vault (dup)
    k.c("fund: funder = vault", &p.run(&[fund_ix(ids::VAULT, 1)]), E::Fail);
    // works while paused
    p.ok(&[uv_ix(w.owner, (None, None, None, None, Some(true), None, None))]);
    k.c("fund while paused", &p.run(&[fund_ix(stranger, SOL)]), E::Ok);
    k.done();
}

#[test]
fn fund_vault_attacks() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let base = fund_ix(w.owner, SOL);
    vault_typed(&mut p, &mut k, "fund", &base);
    ix_battery(&mut p, &mut k, "fund", &base, 1, None, true);
    let mut i = base.clone();
    i.accounts[1].is_writable = false;
    k.c("fund: funder not writable", &p.run(&[i]), E::Err(2000));
    let mut i = base.clone();
    i.accounts[2].pubkey = key("notsys");
    k.c("fund: system_program random", &p.run(&[i]), E::Err(3008));
    let mut i = base.clone();
    i.accounts[2].pubkey = ids::DLP;
    k.c("fund: system_program = DLP", &p.run(&[i]), E::Err(3008));
    // order
    let mut i = fund_ix(w.owner, 0);
    i.accounts[1].is_writable = false;
    k.c("fund: amount 0 + funder not writable", &p.run(&[i]), E::Err(2000));
    let mut i = base.clone();
    i.accounts[1].is_signer = false;
    i.accounts[2].pubkey = key("notsys");
    k.c("fund: funder not signer + bad system_program", &p.run(&[i]), E::Err(3010));
    let mut i = base.clone();
    i.accounts[0].is_writable = false;
    i.accounts[2].pubkey = key("notsys");
    k.c("fund: vault not writable + bad system_program", &p.run(&[i]), E::Err(3008));
    let orig = p.get(&ids::VAULT).unwrap();
    p.patch(ids::VAULT, |d| d[104] = 1);
    let mut i = base.clone();
    i.accounts[1].is_signer = false;
    k.c("fund: bad bump + funder not signer", &p.run(&[i]), E::Err(3010));
    p.patch(ids::VAULT, |d| d[137] = 2);
    let mut i = base.clone();
    i.accounts[1].is_signer = false;
    k.c("fund: bad bool + funder not signer", &p.run(&[i]), E::Err(3003));
    p.set_account(ids::VAULT, orig);
    tail_battery(&mut p, &mut k, "fund", &base);
    // before init
    let mut p = Pair::new();
    let f = p.user("f");
    k.c("fund before init", &p.run(&[fund_ix(f, SOL)]), E::Err(3012));
    p.fund(ids::VAULT, SOL);
    k.c("fund: vault system-owned dust", &p.run(&[fund_ix(f, SOL)]), E::Err(3007));
    k.done();
}

// ───────────────────────────── withdraw_to_treasury ─────────────────────────────

fn wd_ix(treasury: Address, destination: Address, amount: u64) -> Instruction {
    ix::WithdrawToTreasury { treasury, destination, ..Default::default() }.ix(amount)
}

#[test]
fn withdraw_to_treasury_happy_and_caps() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let dest = p.user("dest");
    allow(&mut p, &w, dest);
    let d = p.run(&[wd_ix(w.treasury, dest, SOL)]);
    k.c("withdraw 1 SOL", &d, E::Ok);
    cu("withdraw_to_treasury", &d);
    assert_eq!(ev(&d), ["TreasuryWithdrawal"]);
    k.c("withdraw 1 lamport", &p.run(&[wd_ix(w.treasury, dest, 1)]), E::Ok);
    // paused vault is not gated
    p.ok(&[uv_ix(w.owner, (None, None, None, None, Some(true), None, None))]);
    k.c("withdraw while paused", &p.run(&[wd_ix(w.treasury, dest, SOL)]), E::Ok);
    // cap: u64::MAX drains to rent
    let d = p.run(&[wd_ix(w.treasury, dest, u64::MAX)]);
    k.c("withdraw u64::MAX (capped)", &d, E::Ok);
    assert_eq!(p.lamports(&ids::VAULT), VAULT_RENT);
    // nothing available: succeeds with amount 0
    let d = p.run(&[wd_ix(w.treasury, dest, 5)]);
    k.c("withdraw with 0 available", &d, E::Ok);
    k.c("withdraw amount 0", &p.run(&[wd_ix(w.treasury, dest, 0)]), E::Err(6009));
    // vault below rent (data intact): available saturates to 0
    let mut a = p.get(&ids::VAULT).unwrap();
    a.lamports = VAULT_RENT - 100;
    p.set_account(ids::VAULT, a);
    k.c("withdraw with vault below rent", &p.run(&[wd_ix(w.treasury, dest, SOL)]), E::Ok);
    k.done();
}

#[test]
fn withdraw_to_treasury_destinations() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let dest = p.user("dest");
    let not_allowed = p.user("not-allowed");
    allow(&mut p, &w, dest);
    k.c("wd: dest not allowlisted", &p.run(&[wd_ix(w.treasury, not_allowed, SOL)]), E::Err(6024));
    k.c("wd: dest = vault (not allowlisted)", &p.run(&[wd_ix(w.treasury, ids::VAULT, SOL)]), E::Err(6010));
    allow(&mut p, &w, ids::VAULT);
    k.c("wd: dest = vault (allowlisted)", &p.run(&[wd_ix(w.treasury, ids::VAULT, SOL)]), E::Err(6010));
    allow(&mut p, &w, ids::VRF_PROGRAM);
    k.c("wd: dest executable (allowlisted)", &p.run(&[wd_ix(w.treasury, ids::VRF_PROGRAM, SOL)]), E::Fail);
    let mut i = wd_ix(w.treasury, ids::DLP, SOL);
    i.accounts[2].is_writable = false;
    k.c("wd: dest executable readonly", &p.run(&[i]), E::Err(2000));
    allow(&mut p, &w, w.treasury);
    k.c("wd: dest = treasury signer", &p.run(&[wd_ix(w.treasury, w.treasury, SOL)]), E::Ok);
    allow(&mut p, &w, ids::V2_STATE);
    k.c("wd: dest = v2_state (program-owned)", &p.run(&[wd_ix(w.treasury, ids::V2_STATE, SOL)]), E::Ok);
    // dest that does not exist yet: below rent-exempt -> runtime rent failure; at rent -> ok
    let fresh = key("fresh");
    allow(&mut p, &w, fresh);
    k.c("wd: new dest gets 1 lamport", &p.run(&[wd_ix(w.treasury, fresh, 1)]), E::Fail);
    k.c("wd: new dest gets rent_min(0)", &p.run(&[wd_ix(w.treasury, fresh, rent_min(0))]), E::Ok);
    // dest owned by another program (credit is legal)
    let foreign = key("foreign");
    p.set_data(foreign, ids::DLP, vec![7; 10]);
    allow(&mut p, &w, foreign);
    k.c("wd: dest owned by DLP", &p.run(&[wd_ix(w.treasury, foreign, SOL)]), E::Ok);
    // dest lamports overflow
    let fat = key("fat");
    allow(&mut p, &w, fat);
    p.fund(fat, u64::MAX - 10);
    k.c("wd: dest lamports overflow", &p.run(&[wd_ix(w.treasury, fat, 100)]), E::Err(6008));
    // order: dest not writable + amount 0 -> 2000; amount 0 + not allowlisted -> 6009; exec + vault ...
    let mut i = wd_ix(w.treasury, not_allowed, 0);
    i.accounts[2].is_writable = false;
    k.c("wd: dest not writable + amount 0", &p.run(&[i]), E::Err(2000));
    k.c("wd: amount 0 + dest not allowlisted", &p.run(&[wd_ix(w.treasury, not_allowed, 0)]), E::Err(6009));
    k.c("wd: dest exec not allowlisted", &p.run(&[wd_ix(w.treasury, ids::MAGIC_PROGRAM, SOL)]), E::Fail);
    k.done();
}

#[test]
fn withdraw_to_treasury_allowlist_scan() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let x = p.user("x");
    // stale entry beyond count is not allowlisted
    set_vault(&mut p, |v| { v.allowlist_count = 1; v.withdraw_allowlist[0] = key("a"); v.withdraw_allowlist[1] = x; });
    k.c("wd: dest in stale slot beyond count", &p.run(&[wd_ix(w.treasury, x, SOL)]), E::Err(6024));
    // corrupt count > 8 clamps the scan to 8
    set_vault(&mut p, |v| { v.allowlist_count = 200; v.withdraw_allowlist[7] = x; });
    k.c("wd: count 200, dest at slot 7", &p.run(&[wd_ix(w.treasury, x, SOL)]), E::Ok);
    set_vault(&mut p, |v| { v.allowlist_count = 255; v.withdraw_allowlist = [key("b"); 8]; });
    k.c("wd: count 255, dest absent", &p.run(&[wd_ix(w.treasury, x, SOL)]), E::Err(6024));
    set_vault(&mut p, |v| { v.allowlist_count = 0; v.withdraw_allowlist = [x; 8]; });
    k.c("wd: count 0, all slots = dest", &p.run(&[wd_ix(w.treasury, x, SOL)]), E::Err(6024));
    k.done();
}

#[test]
fn withdraw_to_treasury_attacks() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let dest = p.user("dest");
    allow(&mut p, &w, dest);
    let base = wd_ix(w.treasury, dest, SOL);
    vault_typed(&mut p, &mut k, "withdraw", &base);
    ix_battery(&mut p, &mut k, "withdraw", &base, 1, Some(6007), true);
    let mut i = base.clone();
    i.accounts[1].pubkey = w.owner;
    k.c("withdraw: owner signs as treasury", &p.run(&[i]), E::Err(6007));
    let mut i = base.clone();
    i.accounts[2].is_writable = false;
    k.c("withdraw: dest not writable", &p.run(&[i]), E::Err(2000));
    let mut i = base.clone();
    i.accounts[1].pubkey = ids::VAULT;
    k.c("withdraw: treasury = vault (dup signer)", &p.run(&[i]), E::Err(6007));
    // order
    let mut i = base.clone();
    i.accounts[0].is_writable = false;
    i.accounts[1].pubkey = w.owner;
    k.c("withdraw: vault not writable + wrong treasury", &p.run(&[i]), E::Err(2000));
    let mut i = base.clone();
    i.accounts[1].pubkey = w.owner;
    i.accounts[2].is_writable = false;
    k.c("withdraw: wrong treasury + dest not writable", &p.run(&[i]), E::Err(6007));
    let orig = p.get(&ids::VAULT).unwrap();
    p.patch(ids::VAULT, |d| d[104] = 7);
    let mut i = base.clone();
    i.accounts[1].pubkey = w.owner;
    k.c("withdraw: bad bump + wrong treasury", &p.run(&[i]), E::Err(2006));
    p.set_account(ids::VAULT, orig);
    tail_battery(&mut p, &mut k, "withdraw", &base);
    k.done();
}

// ───────────────────────────── unlock_operator_position ─────────────────────────────

fn unlock_ix(owner: Address, destination: Address) -> Instruction {
    ix::UnlockOperatorPosition { owner, destination, ..Default::default() }.ix()
}

/// house_world + one LP (1 SOL) so the operator can unlock without zeroing health; dest allowlisted.
fn unlock_world() -> (Pair, World, Address) {
    let mut p = Pair::new();
    let w = p.house_world();
    let lp = p.user("lp");
    p.ok(&[ix::LpDeposit { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(SOL)]);
    let dest = p.user("dest");
    allow(&mut p, &w, dest);
    (p, w, dest)
}

#[test]
fn unlock_operator_position_happy() {
    let mut k = Chk::default();
    let (mut p, w, dest) = unlock_world();
    let before = v2(&p);
    let d = p.run(&[unlock_ix(w.owner, dest)]);
    k.c("unlock happy", &d, E::Ok);
    cu("unlock_operator_position", &d);
    assert_eq!(ev(&d), ["OperatorUnitsUnlocked"]);
    let after = v2(&p);
    assert_eq!((after.seed_units, after.house_units, after.house_pending_units), (0, 0, 0));
    assert_eq!(after.total_units, before.total_units - before.seed_units - before.house_units);
    k.c("unlock again (nothing left)", &p.run(&[unlock_ix(w.owner, dest)]), E::Err(6041));
    // all three unit kinds + pending slot, house_pending_unlock_slot zeroed
    let (mut p, w, dest) = unlock_world();
    set_v2(&mut p, |v| { v.house_units -= 1_000_000; v.house_pending_units = 1_000_000; v.house_pending_unlock_slot = 123_456; });
    let d = p.run(&[unlock_ix(w.owner, dest)]);
    k.c("unlock seed+house+house_pending", &d, E::Ok);
    // destination = v2_state itself (allowlisted)
    let (mut p, w, _) = unlock_world();
    allow(&mut p, &w, ids::V2_STATE);
    k.c("unlock to v2_state", &p.run(&[unlock_ix(w.owner, ids::V2_STATE)]), E::Ok);
    // destination = owner (signer, allowlisted)
    let (mut p, w, _) = unlock_world();
    allow(&mut p, &w, w.owner);
    k.c("unlock to owner", &p.run(&[unlock_ix(w.owner, w.owner)]), E::Ok);
    // min_health 0 and only operator units: drains everything above rent
    let mut p = Pair::new();
    let w = p.house_world();
    let dest = p.user("dest");
    allow(&mut p, &w, dest);
    set_v2(&mut p, |v| v.min_health_bps = 0);
    k.c("unlock full drain, min_health 0", &p.run(&[unlock_ix(w.owner, dest)]), E::Ok);
    k.done();
}

#[test]
fn unlock_operator_position_math() {
    let mut k = Chk::default();
    let (mut p, w, dest) = unlock_world();
    let snap: Vec<(Address, Account)> = [ids::V2_STATE, ids::VAULT, dest].iter().map(|a| (*a, p.get(a).unwrap())).collect();
    let assets = p.lamports(&ids::VAULT) - VAULT_RENT;
    let mut case = |p: &mut Pair, tag: &str, f: &dyn Fn(&mut accounts::VaultV2State), e: E| {
        set_v2(p, |v| f(v));
        let d = p.run(&[unlock_ix(w.owner, dest)]);
        k.c(tag, &d, e);
        for (a, acc) in &snap { p.set_account(*a, acc.clone()); }
    };
    case(&mut p, "unlock: no operator units", &|v| { v.seed_units = 0; v.house_units = 0; v.house_pending_units = 0; }, E::Err(6041));
    case(&mut p, "unlock: burn sum overflows", &|v| { v.seed_units = u128::MAX; v.house_units = 1; }, E::Err(6008));
    case(&mut p, "unlock: burn sum overflows (pending)", &|v| { v.seed_units = u128::MAX - 1; v.house_units = 1; v.house_pending_units = 1; }, E::Err(6008));
    case(&mut p, "unlock: total_units 0", &|v| v.total_units = 0, E::Err(6039));
    case(&mut p, "unlock: outstanding = assets", &move |v| v.total_outstanding_max_payout = assets, E::Err(6039));
    case(&mut p, "unlock: outstanding = u64::MAX", &|v| v.total_outstanding_max_payout = u64::MAX, E::Err(6039));
    case(&mut p, "unlock: outstanding caps payout (min_health 0)", &move |v| { v.total_outstanding_max_payout = assets - 1_000; v.min_health_bps = 0; }, E::Ok);
    case(&mut p, "unlock: outstanding caps payout (min_health default)", &move |v| v.total_outstanding_max_payout = assets / 2, E::Same);
    case(&mut p, "unlock: pending units reserve", &|v| { v.total_pending_units = v.total_units - v.seed_units - v.house_units; v.min_health_bps = 0; }, E::Ok);
    case(&mut p, "unlock: pending units > total", &|v| { v.total_pending_units = v.total_units * 4; v.min_health_bps = 0; }, E::Err(6039));
    case(&mut p, "unlock: total < burn (checked_sub)", &|v| { v.total_units = 1; v.seed_units = 1; v.house_units = 1; v.house_pending_units = 0; v.min_health_bps = 0; }, E::Err(6008));
    case(&mut p, "unlock: units_to_assets mul overflow", &|v| { v.total_units = 1; v.seed_units = u128::MAX / 2; v.house_units = 0; }, E::Err(6008));
    case(&mut p, "unlock: payout > u64", &|v| { v.total_units = 1; v.seed_units = 1u128 << 70; v.house_units = 0; }, E::Err(6008));
    case(&mut p, "unlock: min_health 10000 with outstanding", &|v| { v.total_outstanding_max_payout = 1; v.min_health_bps = 10_000; }, E::Err(6034));
    case(&mut p, "unlock: min_health 10000 no obligations", &|v| { v.total_outstanding_max_payout = 0; v.total_pending_units = 0; v.min_health_bps = 10_000; }, E::Ok);
    case(&mut p, "unlock: drain all, min_health 1", &|v| { v.total_units = v.seed_units + v.house_units; v.total_pending_units = 0; v.min_health_bps = 1; }, E::Err(6034));
    case(&mut p, "unlock: min_health u16::MAX", &|v| v.min_health_bps = u16::MAX, E::Err(6034));
    case(&mut p, "unlock: 1 seed unit of huge total (payout 0)", &|v| { v.seed_units = 1; v.house_units = 0; v.total_units = u128::MAX; }, E::Err(6039));
    // health exactly at the floor: outstanding 10% of post-unlock assets
    // post-unlock assets ~= the LP's 1 SOL, so 0.1 SOL outstanding puts health at ~9000 bps
    case(&mut p, "unlock: health boundary 9000", &|v| { v.total_outstanding_max_payout = 100_000_000; v.min_health_bps = 9_000; }, E::Ok);
    case(&mut p, "unlock: health boundary 9001", &|v| { v.total_outstanding_max_payout = 100_000_000; v.min_health_bps = 9_001; }, E::Same);
    case(&mut p, "unlock: health boundary 8999", &|v| { v.total_outstanding_max_payout = 100_000_000; v.min_health_bps = 8_999; }, E::Ok);
    // vault below rent: assets 0
    let va = snap[1].1.clone();
    let mut a = va.clone();
    a.lamports = VAULT_RENT - 1;
    p.set_account(ids::VAULT, a);
    k.c("unlock: vault below rent", &p.run(&[unlock_ix(w.owner, dest)]), E::Err(6039));
    p.set_account(ids::VAULT, va);
    k.done();
}

#[test]
fn unlock_operator_position_attacks() {
    let mut k = Chk::default();
    let (mut p, w, dest) = unlock_world();
    let base = unlock_ix(w.owner, dest);
    vault_typed(&mut p, &mut k, "unlock", &base);
    typed_battery(&mut p, &mut k, "unlock", &base, ids::V2_STATE, 1, 191, 127, 8, accounts::Vault::DISC);
    ix_battery(&mut p, &mut k, "unlock", &base, 2, Some(6007), false);
    let sub = |f: &dyn Fn(&mut Instruction)| { let mut i = base.clone(); f(&mut i); i };
    k.c("unlock: v2 slot = vault", &p.run(&[sub(&|i| i.accounts[1].pubkey = ids::VAULT)]), E::Err(3002));
    k.c("unlock: vault slot = v2", &p.run(&[sub(&|i| i.accounts[0].pubkey = ids::V2_STATE)]), E::Err(3002));
    k.c("unlock: treasury signs", &p.run(&[sub(&|i| i.accounts[2].pubkey = w.treasury)]), E::Err(6007));
    k.c("unlock: dest not writable", &p.run(&[sub(&|i| i.accounts[3].is_writable = false)]), E::Err(2000));
    let na = p.user("not-allowed");
    k.c("unlock: dest not allowlisted", &p.run(&[unlock_ix(w.owner, na)]), E::Err(6024));
    k.c("unlock: dest = vault", &p.run(&[unlock_ix(w.owner, ids::VAULT)]), E::Err(6010));
    allow(&mut p, &w, ids::VRF_PROGRAM);
    k.c("unlock: dest executable", &p.run(&[unlock_ix(w.owner, ids::VRF_PROGRAM)]), E::Fail);
    let fat = key("fat");
    allow(&mut p, &w, fat);
    p.fund(fat, u64::MAX - 10);
    k.c("unlock: dest lamports overflow", &p.run(&[unlock_ix(w.owner, fat)]), E::Err(6008));
    let fresh = key("fresh");
    allow(&mut p, &w, fresh);
    // order
    let orig = p.get(&ids::V2_STATE).unwrap();
    p.patch(ids::V2_STATE, |d| d[0] ^= 1);
    k.c("unlock: v2 disc bad + owner not signer", &p.run(&[sub(&|i| i.accounts[2].is_signer = false)]), E::Err(3002));
    p.set_account(ids::V2_STATE, orig.clone());
    p.patch(ids::V2_STATE, |d| d[8] = 1);
    k.c("unlock: v2 bump bad + wrong owner", &p.run(&[sub(&|i| i.accounts[2].pubkey = w.treasury)]), E::Err(6007));
    k.c("unlock: v2 bump bad + dest not writable", &p.run(&[sub(&|i| i.accounts[3].is_writable = false)]), E::Err(2006));
    p.set_account(ids::V2_STATE, orig.clone());
    set_v2(&mut p, |v| { v.seed_units = 0; v.house_units = 0; });
    k.c("unlock: no units + dest not writable", &p.run(&[sub(&|i| i.accounts[3].is_writable = false)]), E::Err(2000));
    k.c("unlock: no units + dest not allowlisted", &p.run(&[unlock_ix(w.owner, na)]), E::Err(6041));
    k.c("unlock: no units + dest = vault", &p.run(&[unlock_ix(w.owner, ids::VAULT)]), E::Err(6041));
    p.set_account(ids::V2_STATE, orig.clone());
    k.c("unlock: dest exec + not allowlisted", &p.run(&[unlock_ix(w.owner, ids::DLP)]), E::Fail);
    let mut i = base.clone();
    i.accounts[1].is_writable = false;
    i.accounts[2].pubkey = w.treasury;
    k.c("unlock: v2 not writable + wrong owner", &p.run(&[i]), E::Err(6007));
    tail_battery(&mut p, &mut k, "unlock", &base);
    // before init_v2
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 5 * SOL);
    let dest = p.user("dest");
    allow(&mut p, &w, dest);
    k.c("unlock before initialize_v2", &p.run(&[unlock_ix(w.owner, dest)]), E::Err(3012));
    k.done();
}

// ───────────────────────────── update_vault ─────────────────────────────

#[test]
fn update_vault_happy_and_bounds() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let d = p.run(&[uv_ix(w.owner, none7())]);
    k.c("update all None", &d, E::Ok);
    cu("update_vault (all None)", &d);
    assert_eq!(ev(&d), ["VaultUpdated"]);
    let (h2, t2) = (key("house2"), key("treasury2"));
    let d = p.run(&[uv_ix(w.owner, (Some(250), Some(500), Some(2_500), Some(7_000), Some(true), Some(h2), Some(t2)))]);
    k.c("update all Some", &d, E::Ok);
    cu("update_vault (all Some)", &d);
    let v = vault(&p);
    assert_eq!((v.house_edge_bps, v.max_bet_bps, v.max_payout_bps, v.treasury_split_bps, v.paused, v.house_authority, v.treasury),
               (250, 500, 2_500, 7_000, true, h2, t2));
    let cases: Vec<(&str, A, E)> = vec![
        ("edge 0", with(|x| { x.0 = Some(0); }), E::Ok),
        ("edge 1000", with(|x| { x.0 = Some(1_000); }), E::Ok),
        ("edge 1001", with(|x| { x.0 = Some(1_001); }), E::Err(6010)),
        ("edge MAX", with(|x| { x.0 = Some(u16::MAX); }), E::Err(6010)),
        ("bet 0", with(|x| { x.1 = Some(0); }), E::Err(6010)),
        ("bet 1", with(|x| { x.1 = Some(1); }), E::Ok),
        ("bet 1000", with(|x| { x.1 = Some(1_000); }), E::Ok),
        ("bet 1001", with(|x| { x.1 = Some(1_001); }), E::Err(6010)),
        ("payout 0", with(|x| { x.2 = Some(0); }), E::Err(6010)),
        ("payout 1", with(|x| { x.2 = Some(1); }), E::Ok),
        ("payout 5000", with(|x| { x.2 = Some(5_000); }), E::Ok),
        ("payout 5001", with(|x| { x.2 = Some(5_001); }), E::Err(6010)),
        ("split 0", with(|x| { x.3 = Some(0); }), E::Ok),
        ("split 10000", with(|x| { x.3 = Some(10_000); }), E::Ok),
        ("split 10001", with(|x| { x.3 = Some(10_001); }), E::Err(6010)),
        ("paused false", with(|x| { x.4 = Some(false); }), E::Ok),
        ("paused true", with(|x| { x.4 = Some(true); }), E::Ok),
        ("house zero", with(|x| { x.5 = Some(Address::default()); }), E::Err(6010)),
        ("house = vault", with(|x| { x.5 = Some(ids::VAULT); }), E::Ok),
        ("treasury zero", with(|x| { x.6 = Some(Address::default()); }), E::Err(6010)),
        ("treasury = owner", with(|x| { x.6 = Some(w.owner); }), E::Ok),
        ("valid edge then zero treasury (revert)", with(|x| { x.0 = Some(5); x.4 = Some(false); x.6 = Some(Address::default()); }), E::Err(6010)),
        ("valid edge then bad bet", with(|x| { x.0 = Some(5); x.1 = Some(0); }), E::Err(6010)),
        ("everything invalid", (Some(1_001), Some(0), Some(0), Some(10_001), Some(true), Some(Address::default()), Some(Address::default())), E::Err(6010)),
    ];
    for (tag, a, e) in cases {
        let d = p.run(&[uv_ix(w.owner, a)]);
        k.c(&format!("update {tag}"), &d, e);
    }
    k.done();
}

#[test]
fn update_vault_malformed_args() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let disc = ix::UpdateVault::DISC;
    let mk = |args: &[u8]| { let mut i = uv_ix(w.owner, none7()); i.data = [&disc[..], args].concat(); i };
    for pos in 0..7 {
        let mut a = vec![0u8; 7];
        a[pos] = 2;
        k.c(&format!("update: tag 2 at option {pos}"), &p.run(&[mk(&a)]), E::Err(102));
        a[pos] = 0xff;
        k.c(&format!("update: tag 0xff at option {pos}"), &p.run(&[mk(&a)]), E::Err(102));
    }
    k.c("update: paused Some(2)", &p.run(&[mk(&[0, 0, 0, 0, 1, 2, 0, 0])]), E::Err(102));
    k.c("update: paused Some(255)", &p.run(&[mk(&[0, 0, 0, 0, 1, 255, 0, 0])]), E::Err(102));
    k.c("update: 6 None tags", &p.run(&[mk(&[0; 6])]), E::Err(102));
    k.c("update: no args", &p.run(&[mk(&[])]), E::Err(102));
    k.c("update: Some(edge) missing 1 byte", &p.run(&[mk(&[1, 5])]), E::Err(102));
    k.c("update: house Some + 31 bytes", &p.run(&[mk(&[[0u8, 0, 0, 0, 0, 1].as_slice(), &[7; 31]].concat())]), E::Err(102));
    k.c("update: treasury Some + 31 bytes", &p.run(&[mk(&[[0u8, 0, 0, 0, 0, 0, 1].as_slice(), &[7; 31]].concat())]), E::Err(102));
    k.c("update: bad tag after an invalid Some (decode first)", &p.run(&[mk(&[1, 0xff, 0xff, 0, 0, 0, 0, 3])]), E::Err(102));
    k.c("update: trailing bytes", &p.run(&[mk(&[0, 0, 0, 0, 0, 0, 0, 1, 2, 3])]), E::Ok);
    // full 80-byte payload with trailing garbage
    let mut full = uv_ix(w.owner, (Some(1), Some(2), Some(3), Some(4), Some(false), Some(key("h")), Some(key("t"))));
    full.data.extend_from_slice(&[0xee; 16]);
    k.c("update: all Some + trailing", &p.run(&[full]), E::Ok);
    // order: bad tag + owner not signer -> 102
    let mut i = mk(&[3, 0, 0, 0, 0, 0, 0]);
    i.accounts[1].is_signer = false;
    k.c("update: bad tag + not signer", &p.run(&[i]), E::Err(102));
    let mut i = uv_ix(w.owner, (Some(5_000), None, None, None, None, None, None));
    i.accounts[1].is_signer = false;
    k.c("update: invalid edge + not signer", &p.run(&[i]), E::Err(3010));
    k.done();
}

#[test]
fn update_vault_attacks() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let base = uv_ix(w.owner, (Some(200), None, None, None, Some(true), None, None));
    vault_typed(&mut p, &mut k, "update", &base);
    ix_battery(&mut p, &mut k, "update", &base, 1, Some(6007), true);
    let sub = |f: &dyn Fn(&mut Instruction)| { let mut i = base.clone(); f(&mut i); i };
    k.c("update: house authority signs", &p.run(&[sub(&|i| i.accounts[1].pubkey = w.house)]), E::Err(6007));
    k.c("update: treasury signs", &p.run(&[sub(&|i| i.accounts[1].pubkey = w.treasury)]), E::Err(6007));
    k.c("update: owner = vault (dup)", &p.run(&[sub(&|i| i.accounts[1].pubkey = ids::VAULT)]), E::Err(6007));
    k.c("update: vault not writable + wrong signer", &p.run(&[sub(&|i| { i.accounts[0].is_writable = false; i.accounts[1].pubkey = w.house; })]), E::Err(2000));
    // pending owner cannot update
    let np = p.user("np");
    p.ok(&[ix::ProposeOwner { owner: w.owner, ..Default::default() }.ix(np)]);
    k.c("update: pending owner signs", &p.run(&[sub(&|i| i.accounts[1].pubkey = np)]), E::Err(6007));
    // vault whose owner field is the vault itself; vault "signs" in the owner slot (dup account)
    let orig = p.get(&ids::VAULT).unwrap();
    set_vault(&mut p, |v| v.owner = ids::VAULT);
    let mut i = sub(&|i| i.accounts[1].pubkey = ids::VAULT);
    k.c("update: vault.owner = vault, vault signs", &p.run(&[i.clone()]), E::Ok);
    i.accounts[1].is_signer = false;
    i.accounts[0].is_signer = false;
    k.c("update: vault.owner = vault, dup unsigned", &p.run(&[i]), E::Err(3010));
    p.set_account(ids::VAULT, orig);
    // short accounts when vault bad (early-3005 deviation)
    p.patch(ids::VAULT, |d| d[0] ^= 1);
    let d = p.run(&[sub(&|i| i.accounts.truncate(1))]);
    k.c("update: bad disc + no signer account", &d, E::Fail);
    p.patch(ids::VAULT, |d| d[0] ^= 1);
    tail_battery(&mut p, &mut k, "update", &base);
    k.done();
}

// ───────────────────────────── allowlist_add / allowlist_remove ─────────────────────────────

fn add_ix(owner: Address, a: Address) -> Instruction { ix::AllowlistAdd { owner, ..Default::default() }.ix(a) }
fn rm_ix(owner: Address, a: Address) -> Instruction { ix::AllowlistRemove { owner, ..Default::default() }.ix(a) }

#[test]
fn allowlist_add_happy_and_limits() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let d = p.run(&[add_ix(w.owner, key("a0"))]);
    k.c("add first", &d, E::Ok);
    cu("allowlist_add", &d);
    assert_eq!(ev(&d), ["AllowlistChanged"]);
    k.c("add duplicate", &p.run(&[add_ix(w.owner, key("a0"))]), E::Err(6026));
    k.c("add zero key", &p.run(&[add_ix(w.owner, Address::default())]), E::Ok);
    k.c("add zero key again", &p.run(&[add_ix(w.owner, Address::default())]), E::Err(6026));
    k.c("add vault key", &p.run(&[add_ix(w.owner, ids::VAULT)]), E::Ok);
    k.c("add system program", &p.run(&[add_ix(w.owner, ids::SYSTEM)]), E::Err(6026)); // == zero key
    for n in 3..8 {
        k.c(&format!("add #{n}"), &p.run(&[add_ix(w.owner, key(&format!("a{n}")))]), E::Ok);
    }
    assert_eq!(vault(&p).allowlist_count, 8);
    k.c("add 9th", &p.run(&[add_ix(w.owner, key("a9"))]), E::Err(6025));
    k.c("add dup when full (full first)", &p.run(&[add_ix(w.owner, key("a0"))]), E::Err(6025));
    // corrupt counts
    set_vault(&mut p, |v| v.allowlist_count = 9);
    k.c("add with count 9", &p.run(&[add_ix(w.owner, key("z"))]), E::Err(6025));
    set_vault(&mut p, |v| v.allowlist_count = 255);
    k.c("add with count 255", &p.run(&[add_ix(w.owner, key("z"))]), E::Err(6025));
    // stale entry beyond count is not a duplicate; slot overwritten
    set_vault(&mut p, |v| { v.allowlist_count = 2; v.withdraw_allowlist[2] = key("stale"); });
    k.c("add address sitting in stale slot", &p.run(&[add_ix(w.owner, key("stale"))]), E::Ok);
    set_vault(&mut p, |v| { v.allowlist_count = 2; v.withdraw_allowlist[2] = key("stale"); });
    k.c("add other address over stale slot", &p.run(&[add_ix(w.owner, key("new"))]), E::Ok);
    set_vault(&mut p, |v| v.allowlist_count = 7);
    k.c("add at count 7 (last slot)", &p.run(&[add_ix(w.owner, key("last"))]), E::Ok);
    k.done();
}

#[test]
fn allowlist_remove_cases() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    k.c("remove from empty", &p.run(&[rm_ix(w.owner, key("a0"))]), E::Err(6027));
    k.c("remove zero key from empty", &p.run(&[rm_ix(w.owner, Address::default())]), E::Err(6027));
    allow(&mut p, &w, key("a0"));
    let d = p.run(&[rm_ix(w.owner, key("a0"))]);
    k.c("remove only entry", &d, E::Ok);
    cu("allowlist_remove", &d);
    assert_eq!(ev(&d), ["AllowlistChanged"]);
    k.c("remove again", &p.run(&[rm_ix(w.owner, key("a0"))]), E::Err(6027));
    for n in 0..8 { allow(&mut p, &w, key(&format!("a{n}"))); }
    let full = p.get(&ids::VAULT).unwrap();
    for idx in [0usize, 3, 7] {
        let d = p.run(&[rm_ix(w.owner, key(&format!("a{idx}")))]);
        k.c(&format!("remove idx {idx} of 8"), &d, E::Ok);
        if idx == 3 { cu("allowlist_remove (swap, 8 entries)", &d); }
        p.set_account(ids::VAULT, full.clone());
    }
    k.c("remove absent from full", &p.run(&[rm_ix(w.owner, key("zz"))]), E::Err(6027));
    // stale entry beyond count
    set_vault(&mut p, |v| v.allowlist_count = 3);
    k.c("remove stale entry beyond count", &p.run(&[rm_ix(w.owner, key("a5"))]), E::Err(6027));
    // duplicates [A, A]
    set_vault(&mut p, |v| { v.allowlist_count = 2; v.withdraw_allowlist[1] = key("a0"); });
    k.c("remove with duplicate entries", &p.run(&[rm_ix(w.owner, key("a0"))]), E::Ok);
    p.set_account(ids::VAULT, full.clone());
    // zero key entry in the middle
    set_vault(&mut p, |v| v.withdraw_allowlist[4] = Address::default());
    k.c("remove zero-key entry", &p.run(&[rm_ix(w.owner, Address::default())]), E::Ok);
    p.set_account(ids::VAULT, full.clone());
    // corrupt count 9: found at idx 0 (Anchor indexes [8] -> panic) / not found (Anchor indexes [8] in the scan)
    set_vault(&mut p, |v| v.allowlist_count = 9);
    k.c("remove with count 9, found", &p.run(&[rm_ix(w.owner, key("a0"))]), E::Fail);
    k.c("remove with count 9, absent", &p.run(&[rm_ix(w.owner, key("zz"))]), E::Fail);
    set_vault(&mut p, |v| v.allowlist_count = 255);
    k.c("remove with count 255, found at 7", &p.run(&[rm_ix(w.owner, key("a7"))]), E::Fail);
    k.done();
}

#[test]
fn allowlist_attacks() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    allow(&mut p, &w, key("a0"));
    allow(&mut p, &w, key("a1"));
    for (tag, base) in [("add", add_ix(w.owner, key("new"))), ("remove", rm_ix(w.owner, key("a0")))] {
        vault_typed(&mut p, &mut k, tag, &base);
        ix_battery(&mut p, &mut k, tag, &base, 1, Some(6007), true);
        let mut i = base.clone();
        i.accounts[1].pubkey = w.treasury;
        k.c(&format!("{tag}: treasury signs"), &p.run(&[i]), E::Err(6007));
        let mut i = base.clone();
        i.data.truncate(39);
        i.accounts[1].is_signer = false;
        k.c(&format!("{tag}: short args + not signer"), &p.run(&[i]), E::Err(102));
        tail_battery(&mut p, &mut k, tag, &base);
    }
    k.done();
}

// ───────────────────────────── propose / cancel / accept ─────────────────────────────

fn propose_ix(owner: Address, new_owner: Address) -> Instruction { ix::ProposeOwner { owner, ..Default::default() }.ix(new_owner) }
fn cancel_ix(owner: Address) -> Instruction { ix::CancelProposedOwner { owner, ..Default::default() }.ix() }
fn accept_ix(new_owner: Address) -> Instruction { ix::AcceptOwnership { new_owner, ..Default::default() }.ix() }

#[test]
fn propose_cancel_accept_happy() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let n1 = p.user("n1");
    let d = p.run(&[propose_ix(w.owner, n1)]);
    k.c("propose", &d, E::Ok);
    cu("propose_owner", &d);
    assert_eq!(ev(&d), ["OwnerProposed"]);
    let d = p.run(&[cancel_ix(w.owner)]);
    k.c("cancel", &d, E::Ok);
    cu("cancel_proposed_owner", &d);
    assert_eq!(ev(&d), ["OwnerProposalCancelled"]);
    k.c("cancel again", &p.run(&[cancel_ix(w.owner)]), E::Err(6028));
    k.c("accept after cancel", &p.run(&[accept_ix(n1)]), E::Err(6007));
    k.c("propose again", &p.run(&[propose_ix(w.owner, n1)]), E::Ok);
    let d = p.run(&[accept_ix(n1)]);
    k.c("accept", &d, E::Ok);
    cu("accept_ownership", &d);
    assert_eq!(ev(&d), ["OwnerAccepted"]);
    let v = vault(&p);
    assert_eq!((v.owner, v.pending_owner, v.house_authority, v.treasury), (n1, Address::default(), w.house, w.treasury));
    k.c("accept twice", &p.run(&[accept_ix(n1)]), E::Err(6007));
    k.done();
}

#[test]
fn propose_owner_cases() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    k.c("propose zero", &p.run(&[propose_ix(w.owner, Address::default())]), E::Err(6010));
    k.c("propose self", &p.run(&[propose_ix(w.owner, w.owner)]), E::Err(6010));
    k.c("propose vault key", &p.run(&[propose_ix(w.owner, ids::VAULT)]), E::Ok);
    k.c("propose overwrite", &p.run(&[propose_ix(w.owner, key("n2"))]), E::Ok);
    k.c("propose same pending again", &p.run(&[propose_ix(w.owner, key("n2"))]), E::Ok);
    k.c("propose zero with pending set", &p.run(&[propose_ix(w.owner, Address::default())]), E::Err(6010));
    let base = propose_ix(w.owner, key("n3"));
    vault_typed(&mut p, &mut k, "propose", &base);
    ix_battery(&mut p, &mut k, "propose", &base, 1, Some(6007), true);
    let mut i = base.clone();
    i.accounts[1].pubkey = key("n2"); // the pending owner cannot re-propose
    k.c("propose by pending owner", &p.run(&[i]), E::Err(6007));
    let mut i = propose_ix(w.owner, Address::default());
    i.accounts[1].is_signer = false;
    k.c("propose zero + not signer", &p.run(&[i]), E::Err(3010));
    tail_battery(&mut p, &mut k, "propose", &base);
    k.done();
}

#[test]
fn cancel_proposed_owner_cases() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    k.c("cancel with none pending", &p.run(&[cancel_ix(w.owner)]), E::Err(6028));
    p.ok(&[propose_ix(w.owner, key("n1"))]);
    let base = cancel_ix(w.owner);
    vault_typed(&mut p, &mut k, "cancel", &base);
    ix_battery(&mut p, &mut k, "cancel", &base, 1, Some(6007), false);
    let mut i = base.clone();
    i.accounts[1].pubkey = key("n1");
    k.c("cancel by pending owner", &p.run(&[i]), E::Err(6007));
    tail_battery(&mut p, &mut k, "cancel", &base);
    // wrong signer + none pending -> 6007 first
    let mut i = cancel_ix(key("intruder"));
    i.accounts[1].pubkey = key("intruder");
    k.c("cancel wrong signer, none pending", &p.run(&[i]), E::Err(6007));
    k.done();
}

#[test]
fn accept_ownership_cases() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let n1 = p.user("n1");
    k.c("accept with none pending", &p.run(&[accept_ix(n1)]), E::Err(6007));
    k.c("accept by owner, none pending", &p.run(&[accept_ix(w.owner)]), E::Err(6007));
    // the zero key "signs" (sigverify off): constraint passes, handler -> NoPendingOwner
    k.c("accept by zero key, none pending", &p.run(&[accept_ix(Address::default())]), E::Same);
    p.ok(&[propose_ix(w.owner, n1)]);
    let base = accept_ix(n1);
    vault_typed(&mut p, &mut k, "accept", &base);
    ix_battery(&mut p, &mut k, "accept", &base, 1, Some(6007), false);
    k.c("accept by current owner", &p.run(&[accept_ix(w.owner)]), E::Err(6007));
    k.c("accept by zero key, pending set", &p.run(&[accept_ix(Address::default())]), E::Same);
    let mut i = base.clone();
    i.accounts[0].is_writable = false;
    i.accounts[1].pubkey = w.owner;
    k.c("accept vault not writable + wrong signer", &p.run(&[i]), E::Err(2000));
    // pending owner = vault, vault "signs" (dup)
    let orig = p.get(&ids::VAULT).unwrap();
    set_vault(&mut p, |v| v.pending_owner = ids::VAULT);
    k.c("accept: pending = vault, vault signs", &p.run(&[accept_ix(ids::VAULT)]), E::Ok);
    p.set_account(ids::VAULT, orig);
    tail_battery(&mut p, &mut k, "accept", &base);
    k.done();
}

// ───────────────────────────── multi-step flows ─────────────────────────────

#[test]
fn ownership_handover_flow() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let (a, b) = (p.user("A"), p.user("B"));
    k.c("propose A", &p.run(&[propose_ix(w.owner, a)]), E::Ok);
    k.c("propose B (overwrites A)", &p.run(&[propose_ix(w.owner, b)]), E::Ok);
    k.c("A accepts (stale)", &p.run(&[accept_ix(a)]), E::Err(6007));
    k.c("B cannot update before accept", &p.run(&[uv_ix(b, none7())]), E::Err(6007));
    k.c("B accepts", &p.run(&[accept_ix(b)]), E::Ok);
    k.c("old owner update", &p.run(&[uv_ix(w.owner, none7())]), E::Err(6007));
    k.c("old owner allowlist_add", &p.run(&[add_ix(w.owner, key("x"))]), E::Err(6007));
    k.c("old owner propose itself back", &p.run(&[propose_ix(w.owner, w.owner)]), E::Err(6007));
    k.c("old owner cancel", &p.run(&[cancel_ix(w.owner)]), E::Err(6007));
    k.c("new owner update", &p.run(&[uv_ix(b, (Some(300), None, None, None, None, None, None))]), E::Ok);
    k.c("new owner allowlist_add", &p.run(&[add_ix(b, key("x"))]), E::Ok);
    k.c("new owner propose self", &p.run(&[propose_ix(b, b)]), E::Err(6010));
    k.c("new owner propose old owner back", &p.run(&[propose_ix(b, w.owner)]), E::Ok);
    k.c("old owner accepts back", &p.run(&[accept_ix(w.owner)]), E::Ok);
    k.c("B lost it again", &p.run(&[uv_ix(b, none7())]), E::Err(6007));
    // propose + accept + update in ONE tx (multi-ix)
    let c = p.user("C");
    let d = p.run(&[propose_ix(w.owner, c), accept_ix(c), uv_ix(c, (None, None, None, None, Some(true), None, None))]);
    k.c("propose+accept+update in one tx", &d, E::Ok);
    assert_eq!(d.anchor.ix_lines.len(), 3);
    // failing last ix reverts the whole tx
    let e = p.user("E");
    let d = p.run(&[propose_ix(c, e), accept_ix(e), cancel_ix(e)]);
    k.c("propose+accept+cancel(none) reverts", &d, E::Err(6028));
    assert_eq!(vault(&p).owner, c);
    k.done();
}

#[test]
fn treasury_ops_flow() {
    let mut k = Chk::default();
    let mut p = Pair::new();
    let w = p.house_world();
    let (d1, d2) = (p.user("d1"), p.user("d2"));
    // rotate treasury via update_vault; the old treasury loses the right
    let t2 = p.user("t2");
    k.c("allow d1,d2", &p.run(&[add_ix(w.owner, d1), add_ix(w.owner, d2)]), E::Ok);
    k.c("withdraw by t1", &p.run(&[wd_ix(w.treasury, d1, SOL)]), E::Ok);
    k.c("rotate treasury", &p.run(&[uv_ix(w.owner, (None, None, None, None, None, None, Some(t2)))]), E::Ok);
    k.c("withdraw by old treasury", &p.run(&[wd_ix(w.treasury, d1, SOL)]), E::Err(6007));
    k.c("withdraw by t2", &p.run(&[wd_ix(t2, d2, 2 * SOL)]), E::Ok);
    k.c("remove d1", &p.run(&[rm_ix(w.owner, d1)]), E::Ok);
    k.c("withdraw to removed d1", &p.run(&[wd_ix(t2, d1, SOL)]), E::Err(6024));
    k.c("d2 moved to slot 0, still allowed", &p.run(&[wd_ix(t2, d2, SOL)]), E::Ok);
    // fund + withdraw in one tx, two withdrawals in one tx
    let d = p.run(&[fund_ix(d1, 5 * SOL), wd_ix(t2, d2, 3 * SOL), wd_ix(t2, d2, u64::MAX)]);
    k.c("fund + withdraw + drain in one tx", &d, E::Ok);
    assert_eq!(p.lamports(&ids::VAULT), VAULT_RENT);
    // refill and unlock the operator position after an LP joins
    p.fund_vault(w.owner, 20 * SOL);
    let lp = p.user("lp");
    p.ok(&[ix::LpDeposit { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(SOL)]);
    k.c("unlock operator to d2", &p.run(&[unlock_ix(w.owner, d2)]), E::Ok);
    k.c("withdraw after unlock", &p.run(&[wd_ix(t2, d2, SOL)]), E::Ok);
    k.done();
}
