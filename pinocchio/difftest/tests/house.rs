//! House LP group (spec/house.md): house_deposit, house_request_withdraw, house_cancel_withdraw,
//! house_complete_withdraw. Every tx runs on both builds; any DIFF POLICY disagreement fails the test.
//! Tests whose name starts with `DIFF_` reproduce a known disagreement (kept failing on purpose).
//! Matrix tests collect every failing case and print them all before panicking.
//! None of these four instructions has an init / init_if_needed account, so there is no pre-funded PDA case.
use difftest::accounts::{Vault, VaultV2State};
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const COOLDOWN: u64 = 648_000; // DEFAULT_WITHDRAW_COOLDOWN_SLOTS
const EV_DEP: [u8; 8] = [0xad, 0x71, 0xd7, 0x1a, 0xe5, 0x1b, 0xa3, 0xe7];
const EV_REQ: [u8; 8] = [0xfe, 0x1e, 0x16, 0x3f, 0x06, 0x6d, 0x77, 0x00];
const EV_CAN: [u8; 8] = [0xac, 0xb8, 0xbf, 0xfa, 0xbd, 0xa9, 0x10, 0x54];
const EV_CMP: [u8; 8] = [0xcd, 0xb3, 0x18, 0x82, 0xb1, 0xc9, 0xba, 0x09];

// ---------- local helpers ----------

fn cu(tag: &str, d: &Diff) {
    let (a, p) = d.cu();
    println!("CU {tag}: anchor {a} port {p}");
}
fn v2(p: &Pair) -> VaultV2State { p.read(&ids::V2_STATE, VaultV2State::decode) }
fn vault(p: &Pair) -> Vault { p.read(&ids::VAULT, Vault::decode) }
fn set_v2(p: &mut Pair, f: impl FnOnce(&mut VaultV2State)) {
    let mut s = v2(p);
    f(&mut s);
    let e = s.encode();
    p.patch(ids::V2_STATE, |d| d[..e.len()].copy_from_slice(&e));
}
fn set_vault(p: &mut Pair, f: impl FnOnce(&mut Vault)) {
    let mut s = vault(p);
    f(&mut s);
    let e = s.encode();
    p.patch(ids::VAULT, |d| d[..e.len()].copy_from_slice(&e));
}
fn set_lamports(p: &mut Pair, k: Address, l: u64) {
    let mut a = p.get(&k).unwrap();
    a.lamports = l;
    p.set_account(k, a);
}
fn assets(p: &Pair) -> u64 { p.lamports(&ids::VAULT).saturating_sub(rent_min(Vault::SPACE)) }
fn ev(disc: [u8; 8], parts: &[&[u8]]) -> Vec<u8> {
    let mut v = disc.to_vec();
    for x in parts { v.extend_from_slice(x); }
    v
}

fn dep(owner: Address, amount: u64) -> Instruction { ix::HouseDeposit { owner, ..Default::default() }.ix(amount) }
fn req(owner: Address, units: u128) -> Instruction { ix::HouseRequestWithdraw { owner, ..Default::default() }.ix(units) }
fn can(owner: Address) -> Instruction { ix::HouseCancelWithdraw { owner, ..Default::default() }.ix() }
fn cmp(owner: Address) -> Instruction { ix::HouseCompleteWithdraw { owner, ..Default::default() }.ix() }

/// house_world + a pending house withdraw of 1 SOL worth of units whose cooldown has elapsed,
/// so all four instructions would succeed (cancel/complete) on the unmodified state.
fn world_pending() -> (Pair, World) {
    let mut p = Pair::new();
    let w = p.house_world();
    p.ok(&[req(w.owner, SOL as u128)]);
    p.warp(p.slot() + COOLDOWN);
    (p, w)
}

/// The four base instructions (each valid on `world_pending` state).
fn all4(owner: Address) -> Vec<(&'static str, Instruction)> {
    vec![("deposit", dep(owner, SOL)), ("request", req(owner, 1)), ("cancel", can(owner)), ("complete", cmp(owner))]
}

#[derive(Clone, Copy, Debug)]
enum Expect {
    Ok,
    Err(u32),
    Failed,
    /// any outcome, as long as both sides agree
    Same,
}

/// On `world_pending` state a request needs the pending one cancelled first (same tx).
fn ok_tx(name: &str, i: Instruction, owner: Address) -> Vec<Instruction> {
    if name == "request" { vec![can(owner), i] } else { vec![i] }
}
/// Run one case; on disagreement or wrong outcome return the description (does not panic).
fn check(p: &mut Pair, label: &str, i: Instruction, e: Expect) -> Option<String> { check_tx(p, label, vec![i], e) }
fn check_tx(p: &mut Pair, label: &str, ixs: Vec<Instruction>, e: Expect) -> Option<String> {
    let d = p.run(&ixs);
    if !d.is_same() {
        return Some(format!("[DIFF] {label}: {}", d.report()));
    }
    let bad = match e {
        Expect::Ok => !d.anchor.ok(),
        Expect::Err(c) => d.anchor.code() != Some(c) || d.port.code() != Some(c),
        Expect::Failed => d.anchor.ok(),
        Expect::Same => false,
    };
    bad.then(|| format!("[expect {e:?}] {label}: {}", d.report()))
}
fn finish(fails: Vec<String>) {
    if !fails.is_empty() {
        panic!("{} case(s) failed:\n{}", fails.len(), fails.join("\n"));
    }
}
fn meta(i: &mut Instruction, idx: usize, f: impl FnOnce(&mut AccountMeta)) -> Instruction {
    f(&mut i.accounts[idx]);
    i.clone()
}

// =====================================================================================
// house_deposit
// =====================================================================================

#[test]
fn hd_happy() {
    let mut p = Pair::new();
    let w = p.house_world();
    let s0 = v2(&p);
    let (a0, o0) = (assets(&p), p.lamports(&w.owner));
    let amount = 2 * SOL + 7;
    let d = p.run(&[dep(w.owner, amount)]);
    d.assert_ok();
    cu("house_deposit", &d);
    let minted = amount as u128 * s0.total_units / a0 as u128;
    let s1 = v2(&p);
    assert_eq!(s1.total_units, s0.total_units + minted);
    assert_eq!(s1.house_units, s0.house_units + minted);
    assert_eq!(p.lamports(&w.owner), o0 - amount);
    assert_eq!(assets(&p), a0 + amount);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: HouseDeposit"]);
    let slot = p.slot();
    assert_eq!(d.anchor.events, vec![ev(EV_DEP, &[&amount.to_le_bytes(), &minted.to_le_bytes(), &s1.total_units.to_le_bytes(), &slot.to_le_bytes()])]);
    d.assert_cpi_same();
}

#[test]
fn hd_first_deposit_total_units_zero_mints_amount() {
    let mut p = Pair::new();
    let w = p.house_world();
    set_v2(&mut p, |s| { s.total_units = 0; s.house_units = 0; s.seed_units = 0; });
    let d = p.run(&[dep(w.owner, 3 * SOL)]);
    d.assert_ok();
    let s = v2(&p);
    assert_eq!((s.total_units, s.house_units), (3 * SOL as u128, 3 * SOL as u128));
    // total_units == 0 with zero assets is also fine (no zero-asset trap on the first deposit)
    set_v2(&mut p, |s| { s.total_units = 0; s.house_units = 0; });
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE));
    p.run(&[dep(w.owner, 1)]).assert_ok();
    assert_eq!(v2(&p).total_units, 1);
}

#[test]
fn hd_handler_errors() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    f.extend(check(&mut p, "amount 0 -> 6009", dep(w.owner, 0), Expect::Err(6009)));
    // floor-div gives 0 units -> MathOverflow (not InvalidAmount)
    set_v2(&mut p, |s| s.total_units = 1);
    f.extend(check(&mut p, "units_minted 0 -> 6008", dep(w.owner, 1), Expect::Err(6008)));
    // boundary: amount * total / assets == 1 exactly (assets 1000, total 1)
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) + 1000);
    f.extend(check(&mut p, "units_minted 999/1000 -> 6008", dep(w.owner, 999), Expect::Err(6008)));
    f.extend(check(&mut p, "units_minted exactly 1 -> ok", dep(w.owner, 1000), Expect::Ok));
    // zero-asset trap: total_units > 0, vault at rent floor
    let mut p = Pair::new();
    let w = p.house_world();
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE));
    f.extend(check(&mut p, "zero assets + live units -> 6008", dep(w.owner, SOL), Expect::Err(6008)));
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) - 1);
    f.extend(check(&mut p, "vault below rent (saturating 0) -> 6008", dep(w.owner, SOL), Expect::Err(6008)));
    // mul overflow
    let mut p = Pair::new();
    let w = p.house_world();
    set_v2(&mut p, |s| s.total_units = u128::MAX);
    f.extend(check(&mut p, "amount*total overflow -> 6008", dep(w.owner, 2), Expect::Err(6008)));
    // total_units add overflow: assets 1, total MAX/2, amount 2 -> minted MAX-1
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) + 1);
    set_v2(&mut p, |s| { s.total_units = u128::MAX / 2; s.house_units = 0; s.seed_units = 0; });
    f.extend(check(&mut p, "total_units add overflow -> 6008", dep(w.owner, 2), Expect::Err(6008)));
    // house_units add overflow
    set_v2(&mut p, |s| { s.total_units = 1; s.house_units = u128::MAX; });
    f.extend(check(&mut p, "house_units add overflow -> 6008", dep(w.owner, 1), Expect::Err(6008)));
    // boundary: house_units MAX-1 + 1 fits
    set_v2(&mut p, |s| { s.total_units = 1; s.house_units = u128::MAX - 1; });
    f.extend(check(&mut p, "house_units add to exactly MAX -> ok", dep(w.owner, 1), Expect::Ok));
    // system transfer failures propagate unchanged
    let mut p = Pair::new();
    let w = p.house_world();
    let bal = p.lamports(&w.owner);
    f.extend(check(&mut p, "amount > balance -> system Custom(1)", dep(w.owner, bal + 1), Expect::Err(1)));
    f.extend(check(&mut p, "amount u64::MAX -> system Custom(1)", dep(w.owner, u64::MAX), Expect::Err(1)));
    f.extend(check(&mut p, "amount == whole balance -> ok", dep(w.owner, bal), Expect::Ok));
    finish(f);
}

#[test]
fn hd_not_checked_paused_and_min_lp_deposit() {
    let mut p = Pair::new();
    let w = p.house_world();
    set_vault(&mut p, |v| v.paused = true);
    set_v2(&mut p, |s| s.min_lp_deposit = u64::MAX);
    p.run(&[dep(w.owner, 1)]).assert_ok();
}

#[test]
fn hd_system_program_checks() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    let base = dep(w.owner, SOL);
    f.extend(check(&mut p, "sysprog = DLP (executable) -> 3008", meta(&mut base.clone(), 3, |m| m.pubkey = ids::DLP), Expect::Err(3008)));
    f.extend(check(&mut p, "sysprog = kaboom -> 3008", meta(&mut base.clone(), 3, |m| m.pubkey = PROGRAM_ID), Expect::Err(3008)));
    f.extend(check(&mut p, "sysprog = random -> 3008", meta(&mut base.clone(), 3, |m| m.pubkey = key("rnd")), Expect::Err(3008)));
    f.extend(check(&mut p, "sysprog = owner -> 3008", meta(&mut base.clone(), 3, |m| m.pubkey = w.owner), Expect::Err(3008)));
    // order: owner signer (3010) is checked before system_program (3008)
    let mut i = meta(&mut base.clone(), 3, |m| m.pubkey = ids::DLP);
    f.extend(check(&mut p, "owner !signer + bad sysprog -> 3010", meta(&mut i, 2, |m| m.is_signer = false), Expect::Err(3010)));
    // order: system_program (deser pass) before vault seeds (constraint pass)
    let fake = key("fake-vault");
    let va = p.get(&ids::VAULT).unwrap();
    p.set_account(fake, va);
    let mut i = meta(&mut base.clone(), 3, |m| m.pubkey = ids::DLP);
    f.extend(check(&mut p, "bad sysprog + fake vault -> 3008", meta(&mut i, 0, |m| m.pubkey = fake), Expect::Err(3008)));
    // order: owner constraint (6007) before handler amount check (6009)
    let other = p.user("other");
    f.extend(check(&mut p, "non-owner + amount 0 -> 6007", dep(other, 0), Expect::Err(6007)));
    // short args before accounts
    let mut i = dep(other, SOL);
    i.data.truncate(12);
    i.accounts.truncate(1);
    f.extend(check(&mut p, "short args + short accounts -> 102", i, Expect::Err(102)));
    finish(f);
}

#[test]
fn hd_args_malformed() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    for n in [8, 9, 15] {
        let mut i = dep(w.owner, SOL);
        i.data.truncate(n);
        f.extend(check(&mut p, &format!("data len {n} -> 102"), i, Expect::Err(102)));
    }
    let mut i = dep(w.owner, SOL);
    i.data.extend_from_slice(&[0xff; 40]);
    f.extend(check(&mut p, "trailing data ignored -> ok", i, Expect::Ok));
    let mut i = dep(w.owner, SOL);
    i.accounts.push(AccountMeta::new(key("extra"), false));
    i.accounts.push(AccountMeta::new_readonly(ids::VAULT, false));
    f.extend(check(&mut p, "extra remaining accounts ignored -> ok", i, Expect::Ok));
    finish(f);
}

// =====================================================================================
// Account checks shared by all four (HouseDepositCtx / HouseLpAction)
// =====================================================================================

#[test]
fn all_account_substitution_and_flags() {
    let mut f = vec![];
    let (mut p, w) = world_pending();
    let other = p.user("other");
    let ghost = key("ghost"); // no account: system-owned, 0 lamports
    let sys_funded = p.user("sys-funded");
    let fake_vault = key("fake-vault");
    let fake_v2 = key("fake-v2");
    let dlp_vault = key("dlp-vault");
    let va = p.get(&ids::VAULT).unwrap();
    let v2a = p.get(&ids::V2_STATE).unwrap();
    p.set_account(fake_vault, va.clone());
    p.set_account(fake_v2, v2a.clone());
    p.set_account(dlp_vault, Account { owner: ids::DLP, ..va.clone() });
    // someone else's program account of another type: a PlayerStats from a real start_game
    let player = p.user("player");
    p.start_game(player, 1, 10_000_000, 0b100, [7; 32]);
    let stats = pda::stats(&player);
    let game = pda::game(&player);

    for (name, base) in all4(w.owner) {
        let n = base.accounts.len();
        let mut c = |label: &str, i: Instruction, e: Expect| f.extend(check(&mut p, &format!("{name}: {label}"), i, e));
        let b = || base.clone();
        c("owner !signer -> 3010", meta(&mut b(), 2, |m| m.is_signer = false), Expect::Err(3010));
        c("owner !writable -> 2000", meta(&mut b(), 2, |m| m.is_writable = false), Expect::Err(2000));
        c("vault !writable -> 2000", meta(&mut b(), 0, |m| m.is_writable = false), Expect::Err(2000));
        c("v2 !writable -> 2000", meta(&mut b(), 1, |m| m.is_writable = false), Expect::Err(2000));
        c("non-owner signer -> 6007", meta(&mut b(), 2, |m| m.pubkey = other), Expect::Err(6007));
        c("house_authority as owner -> 6007", meta(&mut b(), 2, |m| m.pubkey = w.house), Expect::Err(6007));
        c("vault = ghost -> 3012", meta(&mut b(), 0, |m| m.pubkey = ghost), Expect::Err(3012));
        c("vault = system funded -> 3007", meta(&mut b(), 0, |m| m.pubkey = sys_funded), Expect::Err(3007));
        c("vault = DLP-owned copy -> 3007", meta(&mut b(), 0, |m| m.pubkey = dlp_vault), Expect::Err(3007));
        c("vault = v2_state -> 3002", meta(&mut b(), 0, |m| m.pubkey = ids::V2_STATE), Expect::Err(3002));
        c("vault = PlayerStats -> 3002", meta(&mut b(), 0, |m| m.pubkey = stats), Expect::Err(3002));
        c("vault = GameSession -> 3002", meta(&mut b(), 0, |m| m.pubkey = game), Expect::Err(3002));
        c("vault = copy at other address -> 2006", meta(&mut b(), 0, |m| m.pubkey = fake_vault), Expect::Err(2006));
        c("v2 = ghost -> 3012", meta(&mut b(), 1, |m| m.pubkey = ghost), Expect::Err(3012));
        c("v2 = system funded -> 3007", meta(&mut b(), 1, |m| m.pubkey = sys_funded), Expect::Err(3007));
        c("v2 = vault (same acct twice) -> 3002", meta(&mut b(), 1, |m| m.pubkey = ids::VAULT), Expect::Err(3002));
        c("v2 = PlayerStats -> 3002", meta(&mut b(), 1, |m| m.pubkey = stats), Expect::Err(3002));
        c("v2 = copy at other address -> 2006", meta(&mut b(), 1, |m| m.pubkey = fake_v2), Expect::Err(2006));
        c("owner = ghost (unsigned-able key, signer flag set) -> 6007", meta(&mut b(), 2, |m| m.pubkey = ghost), Expect::Err(6007));
        // ordering between checks
        let mut i = meta(&mut b(), 2, |m| m.pubkey = other);
        c("non-owner + owner !signer -> 3010", meta(&mut i, 2, |m| m.is_signer = false), Expect::Err(3010));
        let mut i = meta(&mut b(), 2, |m| m.pubkey = other);
        c("non-owner + vault !writable -> 2000", meta(&mut i, 0, |m| m.is_writable = false), Expect::Err(2000));
        let mut i = meta(&mut b(), 2, |m| m.pubkey = other);
        c("non-owner + v2 !writable -> 6007", meta(&mut i, 1, |m| m.is_writable = false), Expect::Err(6007));
        let mut i = meta(&mut b(), 2, |m| m.pubkey = other);
        c("non-owner + fake v2 -> 6007", meta(&mut i, 1, |m| m.pubkey = fake_v2), Expect::Err(6007));
        let mut i = meta(&mut b(), 0, |m| m.pubkey = fake_vault);
        c("fake vault + owner !signer -> 3010", meta(&mut i, 2, |m| m.is_signer = false), Expect::Err(3010));
        let mut i = meta(&mut b(), 1, |m| m.pubkey = stats);
        c("v2 wrong disc + owner !signer -> 3002", meta(&mut i, 2, |m| m.is_signer = false), Expect::Err(3002));
        let mut i = meta(&mut b(), 0, |m| m.pubkey = fake_vault);
        c("fake vault + v2 wrong disc -> 3002", meta(&mut i, 1, |m| m.pubkey = stats), Expect::Err(3002));
        let mut i = meta(&mut b(), 0, |m| m.is_writable = false);
        c("vault !writable + fake v2 -> 2000", meta(&mut i, 1, |m| m.pubkey = fake_v2), Expect::Err(2000));
        let mut i = meta(&mut b(), 1, |m| m.pubkey = fake_v2);
        c("fake v2 + owner !writable -> 2006", meta(&mut i, 2, |m| m.is_writable = false), Expect::Err(2006));
        let mut i = meta(&mut b(), 0, |m| m.pubkey = ghost);
        c("vault ghost + v2 ghost -> 3012", meta(&mut i, 1, |m| m.pubkey = ghost), Expect::Err(3012));
        // short account lists
        for k in 0..n {
            let mut i = b();
            i.accounts.truncate(k);
            c(&format!("{k} accounts -> 3005"), i, Expect::Err(3005));
        }
        // a bad earlier field and a missing later one: Anchor checks lazily, field by field
        let mut i = meta(&mut b(), 0, |m| m.pubkey = ghost);
        i.accounts.truncate(1);
        c("vault ghost + 1 account -> 3012", i, Expect::Err(3012));
        let mut i = meta(&mut b(), 1, |m| m.pubkey = ids::VAULT);
        i.accounts.truncate(2);
        c("v2=vault + 2 accounts -> 3002", i, Expect::Err(3002));
        // truncated discriminator
        let mut i = b();
        i.data.truncate(4);
        c("4-byte data (no disc)", i, Expect::Failed);
        // nothing above may have changed state
    }
    let pend = v2(&p);
    assert_eq!(pend.house_pending_units, SOL as u128);
    finish(f);
}

#[test]
fn all_account_data_corruption() {
    let mut f = vec![];
    let (mut p, w) = world_pending();
    let va = p.get(&ids::VAULT).unwrap();
    let v2a = p.get(&ids::V2_STATE).unwrap();
    type Mut = Box<dyn Fn(&mut Account)>;
    let cases: Vec<(&str, Address, Mut, Expect)> = vec![
        ("vault data len 0 -> 3001", ids::VAULT, Box::new(|a| a.data.truncate(0)), Expect::Err(3001)),
        ("vault data len 7 -> 3001", ids::VAULT, Box::new(|a| a.data.truncate(7)), Expect::Err(3001)),
        ("vault data len 8 (disc only) -> 3003", ids::VAULT, Box::new(|a| a.data.truncate(8)), Expect::Err(3003)),
        ("vault data len 427 -> 3003", ids::VAULT, Box::new(|a| a.data.truncate(427)), Expect::Err(3003)),
        ("vault disc flipped -> 3002", ids::VAULT, Box::new(|a| a.data[0] ^= 1), Expect::Err(3002)),
        ("vault zeroed -> 3002", ids::VAULT, Box::new(|a| a.data.iter_mut().for_each(|b| *b = 0)), Expect::Err(3002)),
        ("vault paused=2 -> 3003", ids::VAULT, Box::new(|a| a.data[137] = 2), Expect::Err(3003)),
        ("vault paused=255 -> 3003", ids::VAULT, Box::new(|a| a.data[137] = 255), Expect::Err(3003)),
        ("vault bump 253 -> 2006", ids::VAULT, Box::new(|a| a.data[104] = 253), Expect::Err(2006)),
        ("vault bump 255 -> 2006", ids::VAULT, Box::new(|a| a.data[104] = 255), Expect::Err(2006)),
        ("vault bump 0 -> 2006", ids::VAULT, Box::new(|a| a.data[104] = 0), Expect::Err(2006)),
        ("vault owner=system 0 lamports -> 3012", ids::VAULT, Box::new(|a| { a.owner = ids::SYSTEM; a.lamports = 0; }), Expect::Err(3012)),
        ("vault owner=system w/ lamports -> 3007", ids::VAULT, Box::new(|a| a.owner = ids::SYSTEM), Expect::Err(3007)),
        ("vault program-owned 0 lamports -> same", ids::VAULT, Box::new(|a| a.lamports = 0), Expect::Same),
        ("v2 data len 0 -> 3001", ids::V2_STATE, Box::new(|a| a.data.truncate(0)), Expect::Err(3001)),
        ("v2 data len 7 -> 3001", ids::V2_STATE, Box::new(|a| a.data.truncate(7)), Expect::Err(3001)),
        ("v2 data len 190 -> 3003", ids::V2_STATE, Box::new(|a| a.data.truncate(190)), Expect::Err(3003)),
        ("v2 disc flipped -> 3002", ids::V2_STATE, Box::new(|a| a.data[7] ^= 0x80), Expect::Err(3002)),
        ("v2 vrf_mode_enabled=2 -> 3003", ids::V2_STATE, Box::new(|a| a.data[127] = 2), Expect::Err(3003)),
        ("v2 bump 254 -> 2006", ids::V2_STATE, Box::new(|a| a.data[8] = 254), Expect::Err(2006)),
        ("v2 owner=DLP -> 3007", ids::V2_STATE, Box::new(|a| a.owner = ids::DLP), Expect::Err(3007)),
        ("v2 owner=system 0 lamports -> 3012", ids::V2_STATE, Box::new(|a| { a.owner = ids::SYSTEM; a.lamports = 0; }), Expect::Err(3012)),
    ];
    for (label, k, m, e) in &cases {
        for (name, i) in all4(w.owner) {
            let orig = if *k == ids::VAULT { va.clone() } else { v2a.clone() };
            let mut a = orig.clone();
            m(&mut a);
            p.set_account(*k, a);
            f.extend(check(&mut p, &format!("{name}: {label}"), i, *e));
            p.set_account(*k, orig);
        }
    }
    // ordering: vault corrupt (3003) beats v2 corrupt and missing signer
    for (name, mut i) in all4(w.owner) {
        let (mut a, mut b) = (va.clone(), v2a.clone());
        a.data[137] = 2;
        b.data[0] ^= 1;
        p.set_account(ids::VAULT, a);
        p.set_account(ids::V2_STATE, b);
        i.accounts[2].is_signer = false;
        f.extend(check(&mut p, &format!("{name}: vault 3003 + v2 3002 + !signer -> 3003"), i, Expect::Err(3003)));
        p.set_account(ids::VAULT, va.clone());
        p.set_account(ids::V2_STATE, v2a.clone());
    }
    // trailing bytes past SPACE are fine and preserved
    for (name, i) in all4(w.owner) {
        let (mut a, mut b) = (va.clone(), v2a.clone());
        a.data.extend_from_slice(&[0xab; 64]);
        a.lamports += 64 * RENT_PER_BYTE;
        b.data.extend_from_slice(&[0xcd; 32]);
        p.set_account(ids::VAULT, a);
        p.set_account(ids::V2_STATE, b);
        f.extend(check_tx(&mut p, &format!("{name}: oversize vault/v2 data -> ok"), ok_tx(name, i, w.owner), Expect::Ok));
        p.set_account(ids::VAULT, va.clone());
        p.set_account(ids::V2_STATE, v2a.clone());
    }
    // vault.paused = 1 is not checked by any of the four
    for (name, i) in all4(w.owner) {
        let mut a = va.clone();
        a.data[137] = 1;
        p.set_account(ids::VAULT, a);
        f.extend(check_tx(&mut p, &format!("{name}: paused vault -> ok"), ok_tx(name, i, w.owner), Expect::Ok));
        p.set_account(ids::VAULT, va.clone());
        p.set_account(ids::V2_STATE, v2a.clone());
    }
    finish(f);
}

/// A program-owned Vault / VaultV2State stored at a valid but NON-canonical PDA
/// (`create_program_address([seed, [b]])`, b below the canonical bump) with that bump written in its data.
/// Anchor's `seeds = [..], bump = vault.bump` accepts it, and since the D2 fix so does the port
/// (create_program_address with the stored bump). Unreachable on chain (init uses the canonical bump);
/// the test pins the accept set. Each case runs past the seeds check into the handler, in sequence:
/// deposit ok, request 6035 (pending exists), cancel ok, complete 6036 (nothing pending after cancel).
#[test]
#[allow(non_snake_case)]
fn DIFF_all_noncanonical_bump_pda() {
    let mut f = vec![];
    let (mut p, w) = world_pending();
    let pick = |seed: &[u8], below: u8| (0..below).rev()
        .find_map(|b| Address::create_program_address(&[seed, &[b]], &PROGRAM_ID).ok().map(|a| (a, b))).unwrap();
    let (nv, bv) = pick(b"kaboom_vault", 254);
    let (n2, b2) = pick(b"kaboom_v2_state", 255);
    let mut va = p.get(&ids::VAULT).unwrap();
    va.data[104] = bv;
    p.set_account(nv, va);
    let mut v2a = p.get(&ids::V2_STATE).unwrap();
    v2a.data[8] = b2;
    p.set_account(n2, v2a);
    for (name, i) in all4(w.owner) {
        let e = match name { "request" => Expect::Err(6035), "complete" => Expect::Err(6036), _ => Expect::Ok };
        f.extend(check(&mut p, &format!("{name}: vault at non-canonical bump {bv}"), meta(&mut i.clone(), 0, |m| m.pubkey = nv), e));
        f.extend(check(&mut p, &format!("{name}: v2 at non-canonical bump {b2}"), meta(&mut i.clone(), 1, |m| m.pubkey = n2), e));
    }
    finish(f);
}

// =====================================================================================
// house_request_withdraw
// =====================================================================================

#[test]
fn hrw_happy() {
    let mut p = Pair::new();
    let w = p.house_world();
    let s0 = v2(&p);
    let units = 3 * SOL as u128 + 11;
    let o0 = p.lamports(&w.owner);
    let vl = p.lamports(&ids::VAULT);
    let d = p.run(&[req(w.owner, units)]);
    d.assert_ok();
    cu("house_request_withdraw", &d);
    let slot = p.slot();
    let s1 = v2(&p);
    assert_eq!((s1.house_units, s1.house_pending_units, s1.house_pending_unlock_slot), (s0.house_units - units, units, slot + COOLDOWN));
    assert_eq!(s1.total_units, s0.total_units);
    assert_eq!((p.lamports(&w.owner), p.lamports(&ids::VAULT)), (o0, vl));
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: HouseRequestWithdraw"]);
    assert_eq!(d.anchor.events, vec![ev(EV_REQ, &[&units.to_le_bytes(), &(slot + COOLDOWN).to_le_bytes(), &slot.to_le_bytes()])]);
    assert!(d.anchor.cpis.is_empty());
}

#[test]
fn hrw_handler_errors() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    let house = v2(&p).house_units;
    f.extend(check(&mut p, "units 0 -> 6009", req(w.owner, 0), Expect::Err(6009)));
    f.extend(check(&mut p, "units house+1 -> 6038", req(w.owner, house + 1), Expect::Err(6038)));
    f.extend(check(&mut p, "units u128::MAX -> 6038", req(w.owner, u128::MAX), Expect::Err(6038)));
    let mut i = req(w.owner, 1);
    i.data.truncate(23);
    f.extend(check(&mut p, "data len 23 -> 102", i, Expect::Err(102)));
    let mut i = req(w.owner, 1);
    i.data.truncate(8);
    f.extend(check(&mut p, "data len 8 -> 102", i, Expect::Err(102)));
    // pending exists: checked before units 0 / InsufficientUnits
    p.ok(&[req(w.owner, 5)]);
    f.extend(check(&mut p, "pending exists -> 6035", req(w.owner, 1), Expect::Err(6035)));
    f.extend(check(&mut p, "pending exists + units 0 -> 6035", req(w.owner, 0), Expect::Err(6035)));
    f.extend(check(&mut p, "pending exists + units MAX -> 6035", req(w.owner, u128::MAX), Expect::Err(6035)));
    // user_units_total underflow -> 6008
    let mut p = Pair::new();
    let w = p.house_world();
    set_v2(&mut p, |s| s.seed_units = s.total_units + 1);
    f.extend(check(&mut p, "seed > total (user_units_total underflow) -> 6008", req(w.owner, 1), Expect::Err(6008)));
    set_v2(&mut p, |s| { s.seed_units = 0; s.house_units = s.total_units + 10; });
    f.extend(check(&mut p, "house > total (underflow) -> 6008", req(w.owner, 1), Expect::Err(6008)));
    // underflow with floor disabled still fails (user_units_total is computed before the bps==0 shortcut)
    set_v2(&mut p, |s| s.min_house_share_bps = 0);
    f.extend(check(&mut p, "underflow with floor off -> 6008", req(w.owner, 1), Expect::Err(6008)));
    // floor mul overflow: house_after * 10_000 overflows
    set_v2(&mut p, |s| { s.min_house_share_bps = 5000; s.total_units = u128::MAX; s.house_units = u128::MAX; s.seed_units = 0; });
    f.extend(check(&mut p, "house_after*10000 overflow -> 6008", req(w.owner, 1), Expect::Err(6008)));
    // boundary: house_after*10000 exactly fits u128
    set_v2(&mut p, |s| { s.total_units = u128::MAX / 10_000 + 1; s.house_units = u128::MAX / 10_000 + 1; });
    f.extend(check(&mut p, "house_after = MAX/10000 -> ok", req(w.owner, 1), Expect::Ok));
    finish(f);
}

#[test]
fn hrw_house_floor_with_lp_user() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    let lp = p.user("lp");
    p.ok(&[ix::LpDeposit { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(SOL)]);
    let s = v2(&p);
    let user = s.total_units - s.seed_units - s.house_units - s.house_pending_units;
    assert!(user > 0);
    // floor 50%: house_after >= user
    let max_ok = s.house_units - user;
    f.extend(check(&mut p, "one unit over the floor -> 6033", req(w.owner, max_ok + 1), Expect::Err(6033)));
    f.extend(check(&mut p, "whole house share -> 6033", req(w.owner, s.house_units), Expect::Err(6033)));
    f.extend(check(&mut p, "exactly at the floor -> ok", req(w.owner, max_ok), Expect::Ok));
    f.extend(check(&mut p, "cancel -> ok", can(w.owner), Expect::Ok));
    // bps 10000: no withdraw allowed while users exist
    set_v2(&mut p, |s| s.min_house_share_bps = 10_000);
    f.extend(check(&mut p, "bps 10000, 1 unit -> 6033", req(w.owner, 1), Expect::Err(6033)));
    // bps u16::MAX (above 100%)
    set_v2(&mut p, |s| s.min_house_share_bps = u16::MAX);
    f.extend(check(&mut p, "bps 65535, 1 unit -> 6033", req(w.owner, 1), Expect::Err(6033)));
    // floor off: everything
    set_v2(&mut p, |s| s.min_house_share_bps = 0);
    let h = v2(&p).house_units;
    f.extend(check(&mut p, "floor off, all house units -> ok", req(w.owner, h), Expect::Ok));
    finish(f);
}

#[test]
fn hrw_cooldown_values() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    for cd in [0u64, 1, u64::MAX - START_SLOT, u64::MAX - START_SLOT + 1, u64::MAX] {
        set_v2(&mut p, |s| s.withdraw_cooldown_slots = cd);
        let d = p.run(&[req(w.owner, 1)]);
        if !d.is_same() || !d.anchor.ok() {
            f.push(format!("cooldown {cd}: {}", d.report()));
        } else {
            let want = p.slot().saturating_add(cd);
            if v2(&p).house_pending_unlock_slot != want { f.push(format!("cooldown {cd}: unlock != {want}")); }
        }
        p.ok(&[can(w.owner)]);
    }
    // request everything when there are no users (denominator 0 path)
    let h = v2(&p).house_units;
    f.extend(check(&mut p, "all house units, no users -> ok", req(w.owner, h), Expect::Ok));
    assert_eq!(v2(&p).house_units, 0);
    finish(f);
}

// =====================================================================================
// house_cancel_withdraw
// =====================================================================================

#[test]
fn hcw_happy() {
    let mut p = Pair::new();
    let w = p.house_world();
    let s0 = v2(&p);
    let units = 2 * SOL as u128;
    p.ok(&[req(w.owner, units)]);
    // no cooldown needed to cancel
    let d = p.run(&[can(w.owner)]);
    d.assert_ok();
    cu("house_cancel_withdraw", &d);
    let s1 = v2(&p);
    assert_eq!(s1, s0);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: HouseCancelWithdraw"]);
    assert_eq!(d.anchor.events, vec![ev(EV_CAN, &[&units.to_le_bytes(), &p.slot().to_le_bytes()])]);
    // after the unlock slot too, with trailing data
    p.ok(&[req(w.owner, 9)]);
    p.warp(p.slot() + COOLDOWN + 5);
    let mut i = can(w.owner);
    i.data.extend_from_slice(&[1, 2, 3]);
    p.run(&[i]).assert_ok();
    assert_eq!(v2(&p), s0);
}

#[test]
fn hcw_errors() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    f.extend(check(&mut p, "no pending -> 6036", can(w.owner), Expect::Err(6036)));
    p.ok(&[req(w.owner, 1)]);
    p.ok(&[can(w.owner)]);
    f.extend(check(&mut p, "second cancel -> 6036", can(w.owner), Expect::Err(6036)));
    // only unlock slot set, no units: still 6036
    set_v2(&mut p, |s| s.house_pending_unlock_slot = 123);
    f.extend(check(&mut p, "unlock set, units 0 -> 6036", can(w.owner), Expect::Err(6036)));
    // house_units + pending overflow
    set_v2(&mut p, |s| { s.house_units = u128::MAX; s.house_pending_units = 1; });
    f.extend(check(&mut p, "house+pending overflow -> 6008", can(w.owner), Expect::Err(6008)));
    set_v2(&mut p, |s| { s.house_units = u128::MAX - 1; s.house_pending_units = 1; });
    f.extend(check(&mut p, "house+pending == MAX -> ok", can(w.owner), Expect::Ok));
    // pending u128::MAX with house 0
    set_v2(&mut p, |s| { s.house_units = 0; s.house_pending_units = u128::MAX; s.house_pending_unlock_slot = u64::MAX; });
    f.extend(check(&mut p, "pending MAX, house 0 -> ok", can(w.owner), Expect::Ok));
    finish(f);
}

// =====================================================================================
// house_complete_withdraw
// =====================================================================================

#[test]
fn hcmp_happy() {
    let mut p = Pair::new();
    let w = p.house_world();
    let units = 4 * SOL as u128 + 3;
    p.ok(&[req(w.owner, units)]);
    p.warp(p.slot() + COOLDOWN);
    let s0 = v2(&p);
    let (a0, o0, vl0) = (assets(&p), p.lamports(&w.owner), p.lamports(&ids::VAULT));
    let out = (units * a0 as u128 / s0.total_units) as u64;
    let d = p.run(&[cmp(w.owner)]);
    d.assert_ok();
    cu("house_complete_withdraw", &d);
    let s1 = v2(&p);
    assert_eq!((s1.house_pending_units, s1.house_pending_unlock_slot, s1.total_units, s1.house_units), (0, 0, s0.total_units - units, s0.house_units));
    assert_eq!((p.lamports(&w.owner), p.lamports(&ids::VAULT)), (o0 + out, vl0 - out));
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: HouseCompleteWithdraw"]);
    assert_eq!(d.anchor.events, vec![ev(EV_CMP, &[&units.to_le_bytes(), &out.to_le_bytes(), &p.slot().to_le_bytes()])]);
    assert!(d.anchor.cpis.is_empty());
    p.run(&[cmp(w.owner)]).assert_err(6036);
}

#[test]
fn hcmp_cooldown_boundary() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    f.extend(check(&mut p, "no pending -> 6036", cmp(w.owner), Expect::Err(6036)));
    p.ok(&[req(w.owner, SOL as u128)]);
    let unlock = v2(&p).house_pending_unlock_slot;
    f.extend(check(&mut p, "same slot -> 6037", cmp(w.owner), Expect::Err(6037)));
    p.warp(unlock - 1);
    f.extend(check(&mut p, "unlock-1 -> 6037", cmp(w.owner), Expect::Err(6037)));
    p.warp(unlock);
    f.extend(check(&mut p, "unlock exactly -> ok", cmp(w.owner), Expect::Ok));
    // cooldown 0 -> completes in the same slot
    set_v2(&mut p, |s| s.withdraw_cooldown_slots = 0);
    p.ok(&[req(w.owner, 7)]);
    f.extend(check(&mut p, "cooldown 0 same slot -> ok", cmp(w.owner), Expect::Ok));
    // saturated unlock u64::MAX never completes
    set_v2(&mut p, |s| s.withdraw_cooldown_slots = u64::MAX);
    p.ok(&[req(w.owner, 7)]);
    p.warp(p.slot() + 10 * COOLDOWN);
    f.extend(check(&mut p, "unlock u64::MAX -> 6037", cmp(w.owner), Expect::Err(6037)));
    // order: 6036 checked before cooldown (unlock in future, pending 0)
    set_v2(&mut p, |s| s.house_pending_units = 0);
    f.extend(check(&mut p, "pending 0 + future unlock -> 6036", cmp(w.owner), Expect::Err(6036)));
    finish(f);
}

#[test]
fn hcmp_math_edges() {
    let mut f = vec![];
    let mut p = Pair::new();
    let w = p.house_world();
    let ready = |s: &mut VaultV2State, units: u128| { s.house_pending_units = units; s.house_pending_unlock_slot = 0; };
    // assets_out == 0: vault at rent floor -> no lamports move, state cleared, event with 0
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE));
    set_v2(&mut p, |s| ready(s, 5));
    let o0 = p.lamports(&w.owner);
    let d = p.run(&[cmp(w.owner)]);
    if !d.is_same() || !d.anchor.ok() { f.push(format!("assets 0 -> ok: {}", d.report())); }
    else if p.lamports(&w.owner) != o0 || v2(&p).house_pending_units != 0 { f.push("assets 0: state".into()); }
    // vault below rent floor (assets saturate to 0) -> ok, nothing moves
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) - 1000);
    set_v2(&mut p, |s| ready(s, 5));
    f.extend(check(&mut p, "vault below rent -> ok (0 out)", cmp(w.owner), Expect::Ok));
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) + 50 * SOL);
    // floor rounding: out = floor(units * assets / total)
    set_v2(&mut p, |s| { s.total_units = 3; ready(s, 1); });
    let vl = p.lamports(&ids::VAULT);
    f.extend(check(&mut p, "1/3 of assets (floor) -> ok", cmp(w.owner), Expect::Ok));
    if p.lamports(&ids::VAULT) != vl - (50 * SOL) / 3 { f.push("rounding: wrong amount".into()); }
    // units round to 0 lamports
    set_v2(&mut p, |s| { s.total_units = u128::MAX / 2; ready(s, 1); });
    f.extend(check(&mut p, "dust units -> 0 lamports ok", cmp(w.owner), Expect::Ok));
    // total_units == 0 -> out 0, then total_units - units underflows -> 6008
    set_v2(&mut p, |s| { s.total_units = 0; ready(s, 1); });
    f.extend(check(&mut p, "total_units 0 -> 6008", cmp(w.owner), Expect::Err(6008)));
    // units > total_units -> out > assets -> 6039
    set_v2(&mut p, |s| { s.total_units = 10; ready(s, 11); });
    f.extend(check(&mut p, "units > total -> 6039", cmp(w.owner), Expect::Err(6039)));
    // units == total_units -> drain to the rent floor exactly
    set_v2(&mut p, |s| { s.total_units = 10; ready(s, 10); });
    f.extend(check(&mut p, "units == total -> ok, vault at rent floor", cmp(w.owner), Expect::Ok));
    if p.lamports(&ids::VAULT) != rent_min(Vault::SPACE) { f.push("drain: vault not at rent floor".into()); }
    // zero assets + units > total: out 0 <= 0, then underflow -> 6008
    set_v2(&mut p, |s| { s.total_units = 10; ready(s, 11); });
    f.extend(check(&mut p, "assets 0, units > total -> 6008", cmp(w.owner), Expect::Err(6008)));
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) + 50 * SOL);
    // units * assets overflows u128 -> 6008
    set_v2(&mut p, |s| { s.total_units = u128::MAX; ready(s, u128::MAX); });
    f.extend(check(&mut p, "units*assets overflow -> 6008", cmp(w.owner), Expect::Err(6008)));
    // result does not fit u64 -> 6008 (before the liquidity check)
    set_v2(&mut p, |s| { s.total_units = 1; ready(s, 1u128 << 64); });
    f.extend(check(&mut p, "out > u64::MAX -> 6008", cmp(w.owner), Expect::Err(6008)));
    // owner lamports overflow on credit -> 6008
    set_v2(&mut p, |s| { s.total_units = 50 * SOL as u128; ready(s, 1); });
    set_lamports(&mut p, w.owner, u64::MAX);
    f.extend(check(&mut p, "owner credit overflow -> 6008", cmp(w.owner), Expect::Err(6008)));
    set_lamports(&mut p, w.owner, u64::MAX - 1);
    f.extend(check(&mut p, "owner credit to exactly u64::MAX -> ok", cmp(w.owner), Expect::Ok));
    set_lamports(&mut p, w.owner, 100 * SOL);
    // oversize vault data (500 bytes): assets still priced on rent(428); draining all leaves it under rent(500)
    let mut va = p.get(&ids::VAULT).unwrap();
    va.data.resize(500, 0);
    p.set_account(ids::VAULT, va);
    set_v2(&mut p, |s| { s.total_units = 10; ready(s, 10); });
    f.extend(check(&mut p, "500-byte vault drained to rent(428)", cmp(w.owner), Expect::Failed));
    finish(f);
}

#[test]
fn hcmp_owner_is_duplicate_account() {
    let mut f = vec![];
    // owner == vault (vault.owner patched to the vault key): debit and credit the same account
    let (mut p, _w) = world_pending();
    set_vault(&mut p, |v| v.owner = ids::VAULT);
    let vl = p.lamports(&ids::VAULT);
    let i = ix::HouseCompleteWithdraw { owner: ids::VAULT, ..Default::default() }.ix();
    f.extend(check(&mut p, "complete: owner = vault -> ok", i, Expect::Ok));
    if p.lamports(&ids::VAULT) != vl { f.push("owner=vault: lamports changed".into()); }
    p.ok(&[ix::HouseRequestWithdraw { owner: ids::VAULT, ..Default::default() }.ix(1)]);
    f.extend(check(&mut p, "cancel: owner = vault -> ok", ix::HouseCancelWithdraw { owner: ids::VAULT, ..Default::default() }.ix(), Expect::Ok));
    f.extend(check(&mut p, "deposit: owner = vault -> system error", ix::HouseDeposit { owner: ids::VAULT, ..Default::default() }.ix(SOL), Expect::Failed));
    // owner == v2_state: credit lands on the v2 account, whose data is also rewritten
    let (mut p, _w) = world_pending();
    set_vault(&mut p, |v| v.owner = ids::V2_STATE);
    let l2 = p.lamports(&ids::V2_STATE);
    let i = ix::HouseCompleteWithdraw { owner: ids::V2_STATE, ..Default::default() }.ix();
    f.extend(check(&mut p, "complete: owner = v2_state -> ok", i, Expect::Ok));
    if p.lamports(&ids::V2_STATE) <= l2 { f.push("owner=v2: not credited".into()); }
    f.extend(check(&mut p, "deposit: owner = v2_state -> system error", ix::HouseDeposit { owner: ids::V2_STATE, ..Default::default() }.ix(SOL), Expect::Failed));
    // owner is a program-owned account (not system): deposit transfer must fail identically
    let (mut p, _w) = world_pending();
    let po = key("prog-owner");
    p.set_account(po, Account { lamports: 10 * SOL, data: vec![], owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
    set_vault(&mut p, |v| v.owner = po);
    f.extend(check(&mut p, "deposit: owner program-owned -> system error", ix::HouseDeposit { owner: po, ..Default::default() }.ix(SOL), Expect::Failed));
    f.extend(check(&mut p, "complete: owner program-owned -> ok", ix::HouseCompleteWithdraw { owner: po, ..Default::default() }.ix(), Expect::Ok));
    // owner system account with data: transfer source must not carry data
    let (mut p, _w) = world_pending();
    let sd = key("sys-with-data");
    p.set_account(sd, Account { lamports: 10 * SOL, data: vec![0; 10], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    set_vault(&mut p, |v| v.owner = sd);
    f.extend(check(&mut p, "deposit: owner system w/ data -> system error", ix::HouseDeposit { owner: sd, ..Default::default() }.ix(SOL), Expect::Failed));
    finish(f);
}

// =====================================================================================
// Multi-step flows
// =====================================================================================

#[test]
fn flow_house_deposit_request_cancel_complete() {
    let mut p = Pair::new();
    let w = p.house_world();
    let o_start = p.lamports(&w.owner);
    p.ok(&[dep(w.owner, 5 * SOL)]);
    let s = v2(&p);
    let mine = s.house_units;
    // request, cancel, request again (all of it; no users -> no floor), wait, complete
    p.ok(&[req(w.owner, mine / 2)]);
    p.ok(&[can(w.owner)]);
    assert_eq!(v2(&p).house_units, mine);
    p.ok(&[req(w.owner, mine)]);
    p.run(&[req(w.owner, 1)]).assert_err(6035);
    p.warp(p.slot() + COOLDOWN - 1);
    p.run(&[cmp(w.owner)]).assert_err(6037);
    p.warp(p.slot() + 1);
    p.ok(&[cmp(w.owner)]);
    let s = v2(&p);
    assert_eq!((s.house_units, s.house_pending_units, s.total_units), (0, 0, s.seed_units));
    // the seed stays behind
    // (house_world's 50 SOL fund minus the 1 SOL seed was house-owned: 49 SOL net back to the owner)
    assert_eq!(p.lamports(&w.owner), o_start + 49 * SOL);
    assert_eq!(assets(&p), SOL);
    // house is empty now
    p.run(&[req(w.owner, 1)]).assert_err(6038);
    p.run(&[cmp(w.owner)]).assert_err(6036);
    p.run(&[can(w.owner)]).assert_err(6036);
    // deposit again on top of the seed only
    let d = p.ok(&[dep(w.owner, SOL)]);
    assert_eq!(v2(&p).house_units, SOL as u128);
    assert_eq!(d.anchor.events.len(), 1);
}

#[test]
fn flow_house_with_lp_user_and_value_change() {
    let mut p = Pair::new();
    let w = p.house_world();
    let lp = p.user("lp");
    p.ok(&[ix::LpDeposit { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(2 * SOL)]);
    // vault gains value (e.g. house wins) -> house deposit mints fewer units per lamport
    let vl = p.lamports(&ids::VAULT);
    set_lamports(&mut p, ids::VAULT, vl + 7 * SOL + 3);
    let s0 = v2(&p);
    let a0 = assets(&p);
    let d = p.ok(&[dep(w.owner, 3 * SOL)]);
    let minted = 3 * SOL as u128 * s0.total_units / a0 as u128;
    assert_eq!(v2(&p).house_units, s0.house_units + minted);
    assert_eq!(d.anchor.events.len(), 1);
    // request a chunk under the floor, value drops, complete pays at the new price
    let units = minted;
    p.ok(&[req(w.owner, units)]);
    let vl = p.lamports(&ids::VAULT);
    set_lamports(&mut p, ids::VAULT, vl - 4 * SOL);
    p.warp(p.slot() + COOLDOWN);
    let (s1, a1, o1) = (v2(&p), assets(&p), p.lamports(&w.owner));
    p.ok(&[cmp(w.owner)]);
    assert_eq!(p.lamports(&w.owner), o1 + (units * a1 as u128 / s1.total_units) as u64);
    // LP user still withdraws via the LP path afterwards (state stays consistent on both sides)
    let s2 = v2(&p);
    assert_eq!(s2.total_units, s1.total_units - units);
}

#[test]
fn flow_two_txs_in_one() {
    // deposit + request in one transaction, then cancel + request + cancel in one
    let mut p = Pair::new();
    let w = p.house_world();
    let d = p.ok(&[dep(w.owner, SOL), req(w.owner, SOL as u128)]);
    assert_eq!(d.anchor.ix_lines.len(), 2);
    assert_eq!(d.anchor.events.len(), 2);
    let d = p.ok(&[can(w.owner), req(w.owner, 5), can(w.owner)]);
    assert_eq!(d.anchor.events.len(), 3);
    // second ix fails -> whole tx reverts identically (error at ix index 1)
    let d = p.run(&[req(w.owner, 5), req(w.owner, 5)]);
    d.assert_err(6035);
    assert_eq!(v2(&p).house_pending_units, 0);
}
