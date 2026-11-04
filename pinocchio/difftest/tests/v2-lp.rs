//! v2-lp group: initialize_v2, update_v2_config, lp_deposit, request_withdraw, cancel_withdraw,
//! complete_withdraw, close_lp_position. Checklist: spec/v2-lp.md.
//!
//! Every test runs the same tx on the Anchor reference and on kaboom-p and asserts DIFF POLICY parity.
//! Tests named `diff_*` are known disagreements and are EXPECTED TO FAIL (kept on purpose; see the
//! `DIFF:` comment on each). Happy paths print `CU <tag>: anchor A port P` (run with --nocapture).
use accounts::{LpPosition, Vault, VaultV2State};
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const COOLDOWN: u64 = 648_000;

// ─── local helpers ───────────────────────────────────────────────────────────

fn cu(tag: &str, d: &Diff) {
    let (a, p) = d.cu();
    println!("CU {tag}: anchor {a} port {p}");
}
fn dep(user: Address, amount: u64) -> Instruction {
    ix::LpDeposit { position: pda::lp(&user), user, ..Default::default() }.ix(amount)
}
fn req(user: Address, units: u128) -> Instruction {
    ix::RequestWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix(units)
}
fn cancel(user: Address) -> Instruction {
    ix::CancelWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix()
}
fn complete(user: Address) -> Instruction {
    ix::CompleteWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix()
}
fn close(user: Address) -> Instruction {
    ix::CloseLpPosition { position: pda::lp(&user), user }.ix()
}
fn init_v2(owner: Address) -> Instruction {
    ix::InitializeV2 { owner, ..Default::default() }.ix()
}
fn cfg_none(owner: Address) -> Instruction {
    ix::UpdateV2Config { owner, ..Default::default() }.ix(None, None, None, None, None, None, None, None)
}
/// update_v2_config with only one u16/u64 field set (index into the arg list).
fn cfg_one(owner: Address, field: usize, v: u64) -> Instruction {
    let b = ix::UpdateV2Config { owner, ..Default::default() };
    let s16 = Some(v as u16);
    match field {
        0 => b.ix(s16, None, None, None, None, None, None, None),
        1 => b.ix(None, s16, None, None, None, None, None, None),
        2 => b.ix(None, None, s16, None, None, None, None, None),
        3 => b.ix(None, None, None, Some(v), None, None, None, None),
        4 => b.ix(None, None, None, None, Some(v), None, None, None),
        7 => b.ix(None, None, None, None, None, None, None, s16),
        _ => unreachable!(),
    }
}
fn pos(p: &Pair, u: &Address) -> LpPosition { p.read(&pda::lp(u), LpPosition::decode) }
fn v2(p: &Pair) -> VaultV2State { p.read(&ids::V2_STATE, VaultV2State::decode) }
fn vault(p: &Pair) -> Vault { p.read(&ids::VAULT, Vault::decode) }
fn set_v2(p: &mut Pair, f: impl FnOnce(&mut VaultV2State)) {
    let mut s = v2(p);
    f(&mut s);
    p.patch(ids::V2_STATE, |d| *d = s.encode());
}
fn set_pos(p: &mut Pair, u: &Address, f: impl FnOnce(&mut LpPosition)) {
    let mut s = pos(p, u);
    f(&mut s);
    p.patch(pda::lp(u), |d| *d = s.encode());
}
fn set_vault(p: &mut Pair, f: impl FnOnce(&mut Vault)) {
    let mut s = vault(p);
    f(&mut s);
    p.patch(ids::VAULT, |d| *d = s.encode());
}
fn set_lamports(p: &mut Pair, k: Address, lamports: u64) {
    let mut a = p.get(&k).unwrap();
    a.lamports = lamports;
    p.set_account(k, a);
}
fn vault_assets(p: &Pair) -> u64 { p.lamports(&ids::VAULT) - rent_min(Vault::SPACE) }
fn lp_bump(u: &Address) -> u8 { pda::find(&[b"kaboom_lp", u.as_ref()], &PROGRAM_ID).1 }
fn position_bytes(user: Address, units: u128, pending: u128, unlock: u64) -> Vec<u8> {
    LpPosition { user, units, pending_units: pending, pending_unlock_slot: unlock, created_slot: START_SLOT, bump: lp_bump(&user), _reserved: [0; 32] }.encode()
}
/// Both sides failed (any error, same error) — for short account lists where the accepted early-3005 may apply.
fn assert_short(d: &Diff) {
    d.assert_failed();
}
/// A non-canonical bump `b` for which `create_program_address(seeds ++ [b])` is valid.
fn noncanonical(seed: &[u8], canonical: u8) -> (Address, u8) {
    (0..canonical).rev().find_map(|b| Address::create_program_address(&[seed, &[b]], &PROGRAM_ID).ok().map(|a| (a, b))).unwrap()
}

fn world() -> (Pair, World) {
    let mut p = Pair::new();
    let w = p.house_world();
    (p, w)
}
/// house_world + user "lp" holding a 1 SOL position.
fn lp_world() -> (Pair, World, Address) {
    let (mut p, w) = world();
    let u = p.user("lp");
    p.ok(&[dep(u, SOL)]);
    (p, w, u)
}
/// lp_world + a pending withdraw of half the units.
fn pending_world() -> (Pair, World, Address) {
    let (mut p, w, u) = lp_world();
    let half = pos(&p, &u).units / 2;
    p.ok(&[req(u, half)]);
    (p, w, u)
}

// ═══ initialize_v2 ═══════════════════════════════════════════════════════════

#[test]
fn init_v2_happy() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    let d = p.run(&[init_v2(w.owner)]);
    d.assert_ok().assert_cpi_same();
    cu("initialize_v2", &d);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: InitializeV2"]);
    assert_eq!(d.anchor.events.len(), 1);
    let s = v2(&p);
    assert_eq!((s.bump, s.total_units, s.seed_units, s.house_units), (255, 50 * SOL as u128, SOL as u128, 49 * SOL as u128));
    assert_eq!((s.min_house_share_bps, s.max_user_position_bps, s.min_health_bps, s.withdraw_cooldown_slots, s.min_lp_deposit), (5000, 1000, 1000, COOLDOWN, 10_000_000));
    assert!(!s.vrf_mode_enabled);
    assert_eq!(p.lamports(&ids::V2_STATE), rent_min(VaultV2State::SPACE));
}

#[test]
fn init_v2_second_call_fails_custom0() {
    let (mut p, w) = world();
    p.run(&[init_v2(w.owner)]).assert_err(0);
}

#[test]
fn init_v2_exact_seed_boundary_ok_house_zero() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, SOL);
    p.ok(&[init_v2(w.owner)]);
    assert_eq!(v2(&p).house_units, 0);
}

#[test]
fn init_v2_below_seed_6039() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) + SOL - 1);
    p.run(&[init_v2(w.owner)]).assert_err(6039);
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE));
    p.run(&[init_v2(w.owner)]).assert_err(6039);
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) - 1); // below rent: assets saturate to 0
    p.run(&[init_v2(w.owner)]).assert_err(6039);
}

#[test]
fn init_v2_non_owner_6007() {
    let mut p = Pair::new();
    let _w = p.init_vault(100, 100, 1_000);
    p.fund_vault(_w.owner, 50 * SOL);
    let bob = p.user("bob");
    p.run(&[init_v2(bob)]).assert_err(6007);
}

#[test]
fn init_v2_signer_and_writable_flags() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    let mut i = init_v2(w.owner);
    i.accounts[2].is_signer = false;
    p.run(&[i]).assert_err(3010);
    let mut i = init_v2(w.owner);
    i.accounts[2].is_writable = false; // payer readonly: CreateAccount CPI privilege error
    p.run(&[i]).assert_failed();
    let mut i = init_v2(w.owner);
    i.accounts[1].is_writable = false;
    p.run(&[i]).assert_failed();
    let mut i = init_v2(w.owner);
    i.accounts[0].is_writable = true; // extra writability is allowed; vault untouched
    p.run(&[i]).assert_ok();
}

#[test]
fn init_v2_wrong_system_program_3008() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    p.run(&[ix::InitializeV2 { owner: w.owner, system_program: key("not-system"), ..Default::default() }.ix()]).assert_err(3008);
    p.run(&[ix::InitializeV2 { owner: w.owner, system_program: ids::DLP, ..Default::default() }.ix()]).assert_err(3008);
}

#[test]
fn init_v2_wrong_v2_pda_2006() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    p.run(&[ix::InitializeV2 { owner: w.owner, v2_state: key("rand"), ..Default::default() }.ix()]).assert_err(2006);
    // same account twice: vault in the v2_state slot
    p.run(&[ix::InitializeV2 { owner: w.owner, v2_state: ids::VAULT, ..Default::default() }.ix()]).assert_err(2006);
    // non-canonical v2 PDA
    let (nc, _) = noncanonical(b"kaboom_v2_state", 255);
    p.run(&[ix::InitializeV2 { owner: w.owner, v2_state: nc, ..Default::default() }.ix()]).assert_err(2006);
}

#[test]
fn init_v2_vault_substitutions() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    let real = p.get(&ids::VAULT).unwrap();
    let run = |p: &mut Pair, k: Address| p.run(&[ix::InitializeV2 { owner: w.owner, vault: k, ..Default::default() }.ix()]);
    // uninitialised
    run(&mut p, key("nothing")).assert_err(3012);
    // vault bytes owned by another program
    let k = key("fake-vault-1");
    p.set_account(k, Account { owner: key("other-prog"), ..real.clone() });
    run(&mut p, k).assert_err(3007);
    // program-owned clone at a non-PDA address
    let k = key("fake-vault-2");
    p.set_account(k, real.clone());
    run(&mut p, k).assert_err(2006);
    // len < 8
    let k = key("fake-vault-3");
    p.set_program_account(k, vec![1; 7]);
    run(&mut p, k).assert_err(3001);
    // wrong discriminator
    let k = key("fake-vault-4");
    p.set_program_account(k, position_bytes(w.owner, 0, 0, 0));
    run(&mut p, k).assert_err(3002);
    // right disc, too short
    let k = key("fake-vault-5");
    p.set_program_account(k, real.data[..300].to_vec());
    run(&mut p, k).assert_err(3003);
    // system account (funded)
    run(&mut p, w.owner).assert_err(3007);
}

#[test]
fn init_v2_vault_bad_state_bytes() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    let orig = p.get(&ids::VAULT).unwrap().data;
    p.patch(ids::VAULT, |d| d[137] = 2); // paused bool > 1
    p.run(&[init_v2(w.owner)]).assert_err(3003);
    p.patch(ids::VAULT, |d| *d = orig.clone());
    p.patch(ids::VAULT, |d| d[104] = 253); // stored bump changed
    p.run(&[init_v2(w.owner)]).assert_err(2006);
    p.patch(ids::VAULT, |d| *d = orig.clone());
    p.patch(ids::VAULT, |d| d.extend_from_slice(&[9; 16])); // longer data is accepted
    p.ok(&[init_v2(w.owner)]);
}

#[test]
fn init_v2_prefunded_dust() {
    for dust in [1u64, 1_000_000, rent_min(VaultV2State::SPACE), 3 * SOL] {
        let mut p = Pair::new();
        let w = p.init_vault(100, 100, 1_000);
        p.fund_vault(w.owner, 50 * SOL);
        p.fund(ids::V2_STATE, dust);
        let d = p.run(&[init_v2(w.owner)]);
        d.assert_ok().assert_cpi_same();
        cu(&format!("initialize_v2 prefunded {dust}"), &d);
        assert_eq!(p.lamports(&ids::V2_STATE), dust.max(rent_min(VaultV2State::SPACE)));
        assert_eq!(v2(&p).bump, 255);
    }
}

#[test]
fn init_v2_prefunded_with_data_or_wrong_owner() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    // system-owned with data: Allocate fails
    p.set_data(ids::V2_STATE, ids::SYSTEM, vec![0; 10]);
    p.run(&[init_v2(w.owner)]).assert_failed().assert_cpi_same();
    // owned by another program: Allocate/Assign fail
    p.set_data(ids::V2_STATE, key("other-prog"), vec![0; 191]);
    p.run(&[init_v2(w.owner)]).assert_failed();
    // already program-owned (random bytes): plain init -> Allocate fails
    p.set_program_account(ids::V2_STATE, vec![7; 191]);
    p.run(&[init_v2(w.owner)]).assert_failed();
}

#[test]
fn init_v2_payer_is_v2_state() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    // payer == v2_state, pre-funded -> 4101
    p.fund(ids::V2_STATE, 5 * SOL);
    let i = ix::InitializeV2 { owner: ids::V2_STATE, ..Default::default() }.ix();
    p.run(&[i.clone()]).assert_err(4101);
    // not pre-funded -> CreateAccount(from == to) fails in the System program
    let mut p = Pair::new();
    let w2 = p.init_vault(100, 100, 1_000);
    p.fund_vault(w2.owner, 50 * SOL);
    p.run(&[i]).assert_failed();
    let _ = w;
}

#[test]
fn init_v2_args_and_short_accounts() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    for n in [0, 1, 2, 3] {
        let mut i = init_v2(w.owner);
        i.accounts.truncate(n);
        assert_short(&p.run(&[i]));
    }
    let mut i = init_v2(w.owner);
    i.data.extend_from_slice(&[0xff; 5]); // trailing bytes ignored
    p.ok(&[i]);
}

#[test]
fn init_v2_extra_remaining_accounts_ignored() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    let mut i = init_v2(w.owner);
    i.accounts.push(AccountMeta::new(key("extra"), false));
    i.accounts.push(AccountMeta::new(ids::VAULT, false));
    p.ok(&[i]);
}

#[test]
fn diff_init_v2_noncanonical_vault_pda() {
    // DIFF (D2 in STATUS.md, not in the accepted list): a program-owned Vault at PDA(["kaboom_vault"], b)
    // with a non-canonical stored bump b passes Anchor's `seeds, bump = vault.bump` check but the port
    // compares against the canonical PDA (2006). Pre-state is unreachable on mainnet (only the program can
    // create program-owned accounts at that address, and it only uses the canonical bump).
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    let (nc, b) = noncanonical(b"kaboom_vault", 254);
    let mut acc = p.get(&ids::VAULT).unwrap();
    acc.data[104] = b;
    p.set_account(nc, acc);
    p.run(&[ix::InitializeV2 { owner: w.owner, vault: nc, ..Default::default() }.ix()]).assert_same();
}

#[test]
fn init_v2_after_ownership_handover() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.fund_vault(w.owner, 50 * SOL);
    let new_owner = p.user("new-owner");
    p.ok(&[ix::ProposeOwner { owner: w.owner, ..Default::default() }.ix(new_owner)]);
    // proposed but not accepted: old owner still owns
    p.run(&[init_v2(new_owner)]).assert_err(6007);
    p.ok(&[ix::AcceptOwnership { new_owner, ..Default::default() }.ix()]);
    p.run(&[init_v2(w.owner)]).assert_err(6007);
    p.ok(&[init_v2(new_owner)]);
}

// ═══ update_v2_config ════════════════════════════════════════════════════════

#[test]
fn cfg_all_none_happy() {
    let (mut p, w) = world();
    let before = p.get(&ids::V2_STATE).unwrap().data;
    let d = p.run(&[cfg_none(w.owner)]);
    d.assert_ok();
    cu("update_v2_config (all None)", &d);
    assert_eq!(d.anchor.events.len(), 1);
    assert_eq!(p.get(&ids::V2_STATE).unwrap().data, before);
}

#[test]
fn cfg_all_some_happy() {
    let (mut p, w) = world();
    let val = key("validator");
    let d = p.run(&[ix::UpdateV2Config { owner: w.owner, ..Default::default() }
        .ix(Some(4000), Some(2000), Some(500), Some(1000), Some(123), Some(true), Some(val), Some(700))]);
    d.assert_ok();
    cu("update_v2_config (all Some)", &d);
    let s = v2(&p);
    assert_eq!((s.min_house_share_bps, s.max_user_position_bps, s.min_health_bps, s.withdraw_cooldown_slots, s.min_lp_deposit), (4000, 2000, 500, 1000, 123));
    assert_eq!((s.vrf_mode_enabled, s.vrf_validator, s.vrf_max_payout_bps), (true, val, 700));
    // turn off again: kill switch (default pubkey) and false
    p.ok(&[ix::UpdateV2Config { owner: w.owner, ..Default::default() }
        .ix(None, None, None, None, None, Some(false), Some(Address::default()), Some(0))]);
    let s = v2(&p);
    assert_eq!((s.vrf_mode_enabled, s.vrf_validator, s.vrf_max_payout_bps), (false, Address::default(), 0));
}

#[test]
fn cfg_boundaries() {
    let (mut p, w) = world();
    // (field, ok values, 6010 values)
    let cases: &[(usize, &[u64], &[u64])] = &[
        (0, &[0, 10_000], &[10_001, 65_535]),
        (1, &[0, 10_000], &[10_001, 65_535]),
        (2, &[100, 10_000], &[0, 99, 10_001, 65_535]),
        (3, &[150, u64::MAX], &[0, 149]),
        (4, &[0, u64::MAX, 10_000_000], &[]),
        (7, &[0, 10_000], &[10_001, 65_535]),
    ];
    for (f, oks, bads) in cases {
        for v in *bads {
            p.run(&[cfg_one(w.owner, *f, *v)]).assert_err(6010);
        }
        for v in *oks {
            p.ok(&[cfg_one(w.owner, *f, *v)]);
        }
    }
}

#[test]
fn cfg_partial_write_reverts() {
    let (mut p, w) = world();
    let before = p.get(&ids::V2_STATE).unwrap().data;
    // valid vrf fields (written first in source order) + invalid min_health -> 6010, nothing written
    p.run(&[ix::UpdateV2Config { owner: w.owner, ..Default::default() }
        .ix(Some(1), Some(1), Some(99), None, None, Some(true), Some(key("v")), Some(1))]).assert_err(6010);
    assert_eq!(p.get(&ids::V2_STATE).unwrap().data, before);
    // two invalid fields: still 6010
    p.run(&[ix::UpdateV2Config { owner: w.owner, ..Default::default() }
        .ix(Some(10_001), None, None, Some(1), None, None, None, Some(10_001))]).assert_err(6010);
}

#[test]
fn cfg_malformed_args_102() {
    let (mut p, w) = world();
    let base = cfg_none(w.owner);
    let with = |data: Vec<u8>| { let mut i = base.clone(); i.data = data; i };
    let disc = ix::UpdateV2Config::DISC.to_vec();
    // only the discriminator
    p.run(&[with(disc.clone())]).assert_err(102);
    // 7 None tags (one short)
    p.run(&[with([disc.clone(), vec![0; 7]].concat())]).assert_err(102);
    // bad Option tag in each position
    for at in 0..8 {
        let mut a = vec![0u8; 8];
        a[at] = 2;
        p.run(&[with([disc.clone(), a].concat())]).assert_err(102);
    }
    // Some(bool = 2) for vrf_mode_enabled
    p.run(&[with([disc.clone(), vec![0, 0, 0, 0, 0, 1, 2, 0, 0]].concat())]).assert_err(102);
    // Some(u16) truncated
    p.run(&[with([disc.clone(), vec![1, 5]].concat())]).assert_err(102);
    // all Some, truncated by one byte
    let full = ix::UpdateV2Config { owner: w.owner, ..Default::default() }
        .ix(Some(1), Some(1), Some(100), Some(150), Some(1), Some(true), Some(key("v")), Some(1));
    assert_eq!(full.data.len(), 73);
    let mut t = full.clone();
    t.data.pop();
    p.run(&[t]).assert_err(102);
    // trailing bytes ignored
    let mut t = full.clone();
    t.data.extend_from_slice(&[0xee; 9]);
    p.ok(&[t]);
    let mut t = base.clone();
    t.data.extend_from_slice(&[0xee; 3]);
    p.ok(&[t]);
}

#[test]
fn cfg_auth_and_flags() {
    let (mut p, w) = world();
    let bob = p.user("bob");
    p.run(&[cfg_none(bob)]).assert_err(6007);
    p.run(&[cfg_none(w.house)]).assert_err(6007);
    let mut i = cfg_none(w.owner);
    i.accounts[2].is_signer = false;
    p.run(&[i]).assert_err(3010);
    let mut i = cfg_none(w.owner);
    i.accounts[1].is_writable = false;
    p.run(&[i]).assert_err(2000);
    let mut i = cfg_none(w.owner);
    i.accounts[2].is_writable = true;
    i.accounts[0].is_writable = true;
    p.ok(&[i]);
    // args are parsed before accounts: bad data + non-owner -> 102
    let mut i = cfg_none(bob);
    i.data[8] = 9;
    p.run(&[i]).assert_err(102);
}

#[test]
fn cfg_account_substitutions() {
    let (mut p, w) = world();
    let b = |vault: Address, v2_state: Address| ix::UpdateV2Config { vault, v2_state, owner: w.owner }
        .ix(None, None, None, None, None, None, None, None);
    // swapped / same account twice
    p.run(&[b(ids::V2_STATE, ids::V2_STATE)]).assert_err(3002);
    p.run(&[b(ids::VAULT, ids::VAULT)]).assert_err(3002);
    p.run(&[b(ids::V2_STATE, ids::VAULT)]).assert_err(3002);
    // v2 uninitialised / wrong owner / clone at another key / len<8 / short
    p.run(&[b(ids::VAULT, key("nothing"))]).assert_err(3012);
    let real = p.get(&ids::V2_STATE).unwrap();
    let k = key("fake-v2-1");
    p.set_account(k, Account { owner: key("other-prog"), ..real.clone() });
    p.run(&[b(ids::VAULT, k)]).assert_err(3007);
    let k = key("fake-v2-2");
    p.set_account(k, real.clone());
    p.run(&[b(ids::VAULT, k)]).assert_err(2006);
    let k = key("fake-v2-3");
    p.set_program_account(k, vec![0; 5]);
    p.run(&[b(ids::VAULT, k)]).assert_err(3001);
    let k = key("fake-v2-4");
    p.set_program_account(k, real.data[..100].to_vec());
    p.run(&[b(ids::VAULT, k)]).assert_err(3003);
    // vault clone at another key
    let k = key("fake-vault");
    p.set_account(k, p.get(&ids::VAULT).unwrap());
    p.run(&[b(k, ids::V2_STATE)]).assert_err(2006);
}

#[test]
fn cfg_bad_state_bytes() {
    let (mut p, w) = world();
    let orig = p.get(&ids::V2_STATE).unwrap().data;
    p.patch(ids::V2_STATE, |d| d[127] = 2); // vrf_mode_enabled bool > 1
    p.run(&[cfg_none(w.owner)]).assert_err(3003);
    p.patch(ids::V2_STATE, |d| *d = orig.clone());
    p.patch(ids::V2_STATE, |d| d[8] = 254); // stored bump
    p.run(&[cfg_none(w.owner)]).assert_err(2006);
    p.patch(ids::V2_STATE, |d| *d = orig.clone());
    p.patch(ids::VAULT, |d| d[137] = 7); // vault.paused > 1
    p.run(&[cfg_none(w.owner)]).assert_err(3003);
}

#[test]
fn cfg_short_accounts() {
    let (mut p, w) = world();
    for n in [0, 1, 2] {
        let mut i = cfg_none(w.owner);
        i.accounts.truncate(n);
        assert_short(&p.run(&[i]));
    }
}

#[test]
fn diff_cfg_noncanonical_vault_pda() {
    // DIFF (D2): Anchor accepts a program-owned Vault at a non-canonical PDA (stored bump b); the port
    // returns 2006. Unreachable pre-state on mainnet. Anchor: ok; port: 2006.
    let (mut p, w) = world();
    let (nc, b) = noncanonical(b"kaboom_vault", 254);
    let mut acc = p.get(&ids::VAULT).unwrap();
    acc.data[104] = b;
    p.set_account(nc, acc);
    p.run(&[ix::UpdateV2Config { vault: nc, owner: w.owner, ..Default::default() }
        .ix(None, None, None, None, None, None, None, None)]).assert_same();
}

#[test]
fn diff_cfg_noncanonical_v2_pda() {
    // DIFF (D2): same as above for VaultV2State at PDA(["kaboom_v2_state"], b != 255).
    let (mut p, w) = world();
    let (nc, b) = noncanonical(b"kaboom_v2_state", 255);
    let mut acc = p.get(&ids::V2_STATE).unwrap();
    acc.data[8] = b;
    p.set_account(nc, acc);
    p.run(&[ix::UpdateV2Config { v2_state: nc, owner: w.owner, ..Default::default() }
        .ix(None, None, None, None, None, None, None, None)]).assert_same();
}

#[test]
fn cfg_ownership_handover() {
    let (mut p, w) = world();
    let new_owner = p.user("new-owner");
    p.ok(&[ix::ProposeOwner { owner: w.owner, ..Default::default() }.ix(new_owner)]);
    p.run(&[cfg_none(new_owner)]).assert_err(6007);
    p.ok(&[cfg_none(w.owner)]);
    p.ok(&[ix::AcceptOwnership { new_owner, ..Default::default() }.ix()]);
    p.run(&[cfg_none(w.owner)]).assert_err(6007);
    p.ok(&[cfg_one(new_owner, 3, 150)]);
    assert_eq!(v2(&p).withdraw_cooldown_slots, 150);
}

// ═══ lp_deposit ══════════════════════════════════════════════════════════════

#[test]
fn dep_first_and_second_happy() {
    let (mut p, _w) = world();
    let u = p.user("lp");
    let d = p.run(&[dep(u, SOL)]);
    d.assert_ok().assert_cpi_same();
    cu("lp_deposit (first, creates position)", &d);
    let ps = pos(&p, &u);
    assert_eq!((ps.user, ps.units, ps.pending_units, ps.created_slot, ps.bump), (u, SOL as u128, 0, START_SLOT, lp_bump(&u)));
    assert_eq!(p.lamports(&pda::lp(&u)), rent_min(LpPosition::SPACE));
    p.warp(START_SLOT + 10);
    let d = p.run(&[dep(u, 2 * SOL)]);
    d.assert_ok().assert_cpi_same();
    cu("lp_deposit (existing position)", &d);
    let ps = pos(&p, &u);
    assert_eq!(ps.created_slot, START_SLOT); // not re-stamped
    assert_eq!(v2(&p).total_units, 53 * SOL as u128);
    assert_eq!(vault_assets(&p), 53 * SOL);
}

#[test]
fn dep_prefunded_position_dust() {
    for dust in [1u64, 1_000, rent_min(LpPosition::SPACE) - 1, rent_min(LpPosition::SPACE), 5 * SOL] {
        let (mut p, _w) = world();
        let u = p.user("lp");
        p.fund(pda::lp(&u), dust);
        let d = p.run(&[dep(u, SOL)]);
        d.assert_ok().assert_cpi_same();
        cu(&format!("lp_deposit prefunded {dust}"), &d);
        assert_eq!(p.lamports(&pda::lp(&u)), dust.max(rent_min(LpPosition::SPACE)));
        assert_eq!(pos(&p, &u).user, u);
    }
}

#[test]
fn dep_prefunded_with_data_fails() {
    let (mut p, _w) = world();
    let u = p.user("lp");
    p.set_data(pda::lp(&u), ids::SYSTEM, vec![0; 16]);
    p.run(&[dep(u, SOL)]).assert_failed().assert_cpi_same();
}

#[test]
fn dep_min_deposit_boundary() {
    let (mut p, w) = world();
    let u = p.user("lp");
    p.run(&[dep(u, 10_000_000 - 1)]).assert_err(6031);
    p.run(&[dep(u, 0)]).assert_err(6031);
    p.ok(&[dep(u, 10_000_000)]);
    // min 0: amount 0 mints 0 units -> 6008
    p.ok(&[cfg_one(w.owner, 4, 0)]);
    p.run(&[dep(u, 0)]).assert_err(6008);
    p.ok(&[dep(u, 1)]);
    // min u64::MAX
    p.ok(&[cfg_one(w.owner, 4, u64::MAX)]);
    p.run(&[dep(u, u64::MAX - 1)]).assert_err(6031);
}

#[test]
fn dep_dust_rounds_to_zero_units_6008() {
    // share price > 1: 1 lamport mints floor(1 * T / A) = 0 units
    let (mut p, w) = world();
    p.ok(&[cfg_one(w.owner, 4, 0)]);
    p.fund_vault(w.house, 50 * SOL); // A = 100 SOL, T = 50e9
    let u = p.user("lp");
    p.run(&[dep(u, 1)]).assert_err(6008);
    p.ok(&[dep(u, 2)]);
    assert_eq!(pos(&p, &u).units, 1);
}

#[test]
fn dep_paused_6012() {
    let (mut p, w) = world();
    let u = p.user("lp");
    p.ok(&[ix::UpdateVault { owner: w.owner, ..Default::default() }.ix(None, None, None, None, Some(true), None, None)]);
    p.run(&[dep(u, SOL)]).assert_err(6012);
    // paused is checked before the min-deposit check
    p.run(&[dep(u, 1)]).assert_err(6012);
}

#[test]
fn dep_position_cap_boundary() {
    // A = T = 50e9, cap = floor((A+x)/10) at health 10000 -> max x = 5_555_555_555
    let (mut p, _w) = world();
    let u = p.user("lp");
    p.run(&[dep(u, 5_555_555_556)]).assert_err(6032);
    p.ok(&[dep(u, 5_555_555_555)]);
    p.run(&[dep(u, 1_000_000_000)]).assert_err(6032);
}

#[test]
fn dep_cap_scaled_by_health() {
    let (mut p, _w) = world();
    set_v2(&mut p, |s| s.total_outstanding_max_payout = 25 * SOL);
    let u = p.user("lp");
    p.run(&[dep(u, 3 * SOL)]).assert_err(6032);
    p.ok(&[dep(u, SOL)]);
}

#[test]
fn dep_house_floor_boundary() {
    let (mut p, w) = world();
    p.ok(&[cfg_one(w.owner, 1, 0)]); // cap off
    let u = p.user("lp");
    p.fund(u, 100 * SOL);
    p.run(&[dep(u, 49 * SOL + 1)]).assert_err(6033);
    p.ok(&[dep(u, 49 * SOL)]);
    p.run(&[dep(u, 1_000_000_000)]).assert_err(6033);
    // floor off
    p.ok(&[cfg_one(w.owner, 0, 0)]);
    p.ok(&[dep(u, SOL)]);
}

#[test]
fn dep_health_floor_6034() {
    let (mut p, w) = world();
    p.ok(&[cfg_one(w.owner, 1, 0)]); // cap off
    set_v2(&mut p, |s| s.total_outstanding_max_payout = 46 * SOL);
    let u = p.user("lp");
    p.run(&[dep(u, SOL)]).assert_err(6034);
    p.ok(&[dep(u, 2 * SOL)]);
    // obligations above assets: health 0
    set_v2(&mut p, |s| s.total_outstanding_max_payout = 500 * SOL);
    p.run(&[dep(u, SOL)]).assert_err(6034);
}

#[test]
fn dep_pending_units_count_in_health_and_cap() {
    let (mut p, w) = world();
    let u = p.user("lp");
    p.ok(&[dep(u, 5 * SOL)]);
    p.ok(&[req(u, 5 * SOL as u128)]);
    // position cap counts units + pending_units: another 1 SOL takes the position over the cap
    p.run(&[dep(u, SOL)]).assert_err(6032);
    p.ok(&[cfg_one(w.owner, 1, 0)]);
    p.ok(&[cfg_one(w.owner, 2, 10_000)]); // min health 100% now breached by the pending value
    p.run(&[dep(u, SOL)]).assert_err(6034);
}

#[test]
fn dep_insufficient_user_funds() {
    let (mut p, _w) = world();
    let u = key("poor");
    p.fund(u, rent_min(LpPosition::SPACE) + 50_000_000);
    p.run(&[dep(u, 60_000_000)]).assert_failed().assert_cpi_same();
    p.ok(&[dep(u, 50_000_000)]);
    let u = p.user("lp");
    p.run(&[dep(u, u64::MAX)]).assert_failed();
}

#[test]
fn dep_math_overflows_6008() {
    // amount * total_units overflows u128
    let (mut p, _w) = world();
    set_v2(&mut p, |s| s.total_units = u128::MAX);
    let u = p.user("lp");
    p.run(&[dep(u, SOL)]).assert_err(6008);
    // total_units_after overflows: A = 1 lamport, T > MAX/2, amount 1 -> minted = T
    let (mut p, w) = world();
    p.ok(&[cfg_one(w.owner, 4, 0)]);
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) + 1);
    set_v2(&mut p, |s| s.total_units = u128::MAX / 2 + 1);
    let u = p.user("lp");
    p.run(&[dep(u, 1)]).assert_err(6008);
    // position.units overflows
    let (mut p, _w, u) = lp_world();
    set_pos(&mut p, &u, |s| s.units = u128::MAX);
    p.run(&[dep(u, SOL)]).assert_err(6008);
    // position.units + pending_units overflows
    let (mut p, _w, u) = lp_world();
    set_pos(&mut p, &u, |s| s.pending_units = u128::MAX - 2 * SOL as u128 + 1);
    p.run(&[dep(u, SOL)]).assert_err(6008);
    // user_units_total underflows (seed > total)
    let (mut p, _w) = world();
    set_v2(&mut p, |s| s.seed_units = s.total_units + SOL as u128);
    let u = p.user("lp");
    p.run(&[dep(u, SOL)]).assert_err(6008);
}

#[test]
fn dep_zero_assets_live_units_6008() {
    let (mut p, _w) = world();
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE));
    let u = p.user("lp");
    p.run(&[dep(u, SOL)]).assert_err(6008);
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) - 100); // below rent: still 0 assets
    p.run(&[dep(u, SOL)]).assert_err(6008);
}

#[test]
fn dep_first_unit_mint_total_zero() {
    let (mut p, w) = world();
    p.ok(&[cfg_one(w.owner, 0, 0)]);
    p.ok(&[cfg_one(w.owner, 1, 0)]);
    set_v2(&mut p, |s| { s.total_units = 0; s.seed_units = 0; s.house_units = 0; });
    let u = p.user("lp");
    let d = p.run(&[dep(u, SOL)]);
    d.assert_ok();
    assert_eq!(pos(&p, &u).units, SOL as u128); // 1:1 when total_units == 0
}

#[test]
fn dep_reinit_guard_existing_zero_user() {
    // a program-owned position at the right PDA with user == default gets user/bump/created_slot stamped
    let (mut p, _w) = world();
    let u = p.user("lp");
    p.set_program_account(pda::lp(&u), LpPosition { user: Address::default(), units: 7, pending_units: 0, pending_unlock_slot: 0, created_slot: 0, bump: 0, _reserved: [3; 32] }.encode());
    p.ok(&[dep(u, SOL)]);
    let ps = pos(&p, &u);
    assert_eq!((ps.user, ps.bump, ps.created_slot, ps.units, ps._reserved), (u, lp_bump(&u), START_SLOT, SOL as u128 + 7, [3; 32]));
    // existing position whose user is someone else: no user constraint in lp_deposit, user kept
    let (mut p, _w) = world();
    let u = p.user("lp");
    let other = key("other");
    p.set_program_account(pda::lp(&u), position_bytes(other, 0, 0, 0));
    p.ok(&[dep(u, SOL)]);
    assert_eq!(pos(&p, &u).user, other);
}

#[test]
fn dep_position_substitutions() {
    let (mut p, _w, a) = lp_world();
    let b = p.user("bob");
    let with_pos = |user: Address, position: Address| ix::LpDeposit { position, user, ..Default::default() }.ix(SOL);
    // someone else's position
    p.run(&[with_pos(b, pda::lp(&a))]).assert_err(2006);
    // v2 / vault in the position slot (same account twice)
    p.run(&[with_pos(b, ids::V2_STATE)]).assert_err(2006);
    p.run(&[with_pos(b, ids::VAULT)]).assert_err(2006);
    // random non-PDA
    p.run(&[with_pos(b, key("rand"))]).assert_err(2006);
    // position == user (payer is the account itself)
    p.run(&[with_pos(b, b)]).assert_err(2006);
    let real = p.get(&pda::lp(&a)).unwrap();
    let k = pda::lp(&b);
    // right PDA, other program
    p.set_account(k, Account { owner: key("other-prog"), ..real.clone() });
    p.run(&[dep(b, SOL)]).assert_err(3007);
    // right PDA, len < 8
    p.set_program_account(k, vec![0; 4]);
    p.run(&[dep(b, SOL)]).assert_err(3001);
    // right PDA, wrong disc
    p.set_program_account(k, v2(&p).encode());
    p.run(&[dep(b, SOL)]).assert_err(3002);
    // right disc, short body
    p.set_program_account(k, position_bytes(b, 0, 0, 0)[..100].to_vec());
    p.run(&[dep(b, SOL)]).assert_err(3003);
    // right disc, too long -> 2019
    let mut long = position_bytes(b, 0, 0, 0);
    long.extend_from_slice(&[0; 10]);
    p.set_program_account(k, long);
    p.run(&[dep(b, SOL)]).assert_err(2019);
    // right data, below rent -> 2005
    p.set_account(k, Account { lamports: rent_min(LpPosition::SPACE) - 1, data: position_bytes(b, 0, 0, 0), owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
    p.run(&[dep(b, SOL)]).assert_err(2005);
    // right data, exactly rent -> ok
    p.set_account(k, Account { lamports: rent_min(LpPosition::SPACE), data: position_bytes(b, 0, 0, 0), owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
    p.ok(&[dep(b, SOL)]);
}

#[test]
fn dep_vault_v2_substitutions() {
    let (mut p, _w) = world();
    let u = p.user("lp");
    let b = |vault: Address, v2_state: Address| ix::LpDeposit { vault, v2_state, position: pda::lp(&u), user: u, ..Default::default() }.ix(SOL);
    p.run(&[b(ids::V2_STATE, ids::V2_STATE)]).assert_err(3002);
    p.run(&[b(ids::VAULT, ids::VAULT)]).assert_err(3002);
    p.run(&[b(ids::V2_STATE, ids::VAULT)]).assert_err(3002);
    p.run(&[b(key("nothing"), ids::V2_STATE)]).assert_err(3012);
    let k = key("fake-vault");
    p.set_account(k, p.get(&ids::VAULT).unwrap());
    p.run(&[b(k, ids::V2_STATE)]).assert_err(2006);
    let k = key("fake-v2");
    p.set_account(k, p.get(&ids::V2_STATE).unwrap());
    p.run(&[b(ids::VAULT, k)]).assert_err(2006);
    let k = key("foreign-vault");
    p.set_account(k, Account { owner: key("other-prog"), ..p.get(&ids::VAULT).unwrap() });
    p.run(&[b(k, ids::V2_STATE)]).assert_err(3007);
    // system program substitution
    p.run(&[ix::LpDeposit { position: pda::lp(&u), user: u, system_program: key("x"), ..Default::default() }.ix(SOL)]).assert_err(3008);
    p.run(&[ix::LpDeposit { position: pda::lp(&u), user: u, system_program: ids::VAULT, ..Default::default() }.ix(SOL)]).assert_err(3008);
}

#[test]
fn dep_flags() {
    let (mut p, _w, u) = lp_world();
    let mut i = dep(u, SOL);
    i.accounts[3].is_signer = false;
    p.run(&[i]).assert_err(3010);
    for slot in [0, 1, 2] {
        let mut i = dep(u, SOL);
        i.accounts[slot].is_writable = false;
        p.run(&[i]).assert_err(2000);
    }
    // existing position, user readonly -> 2000 before the transfer
    let mut i = dep(u, SOL);
    i.accounts[3].is_writable = false;
    p.run(&[i]).assert_err(2000);
    // new position, user readonly -> CreateAccount privilege error
    let n = p.user("new");
    let mut i = dep(n, SOL);
    i.accounts[3].is_writable = false;
    p.run(&[i]).assert_failed();
    // new position, position readonly -> CreateAccount privilege error
    let mut i = dep(n, SOL);
    i.accounts[2].is_writable = false;
    p.run(&[i]).assert_failed();
}

#[test]
fn dep_user_is_vault_alias() {
    // user slot = vault (signer flag forged): the System program refuses a debit from a data account
    let (mut p, _w) = world();
    p.run(&[ix::LpDeposit { position: pda::lp(&ids::VAULT), user: ids::VAULT, ..Default::default() }.ix(SOL)]).assert_failed();
    // same with an existing position for user = vault
    p.set_program_account(pda::lp(&ids::VAULT), position_bytes(ids::VAULT, 0, 0, 0));
    p.run(&[ix::LpDeposit { position: pda::lp(&ids::VAULT), user: ids::VAULT, ..Default::default() }.ix(SOL)]).assert_failed();
}

#[test]
fn dep_user_not_system_owned() {
    let (mut p, _w) = world();
    let u = key("prog-owned-user");
    p.set_account(u, Account { lamports: 10 * SOL, data: vec![], owner: key("other-prog"), executable: false, rent_epoch: 0 });
    p.run(&[dep(u, SOL)]).assert_failed();
}

#[test]
fn dep_args_and_short_accounts() {
    let (mut p, _w, u) = lp_world();
    let mut i = dep(u, SOL);
    i.data.truncate(15);
    p.run(&[i]).assert_err(102);
    let mut i = dep(u, SOL);
    i.data.truncate(8);
    p.run(&[i]).assert_err(102);
    let mut i = dep(u, SOL);
    i.data.extend_from_slice(&[1, 2, 3]);
    p.ok(&[i]);
    for n in [0, 1, 2, 3, 4] {
        let mut i = dep(u, SOL);
        i.accounts.truncate(n);
        assert_short(&p.run(&[i]));
    }
    let mut i = dep(u, SOL);
    i.accounts.push(AccountMeta::new(key("extra"), false));
    p.ok(&[i]);
}

#[test]
fn dep_many_in_one_tx() {
    let (mut p, _w) = world();
    let u = p.user("lp");
    let v = p.user("lp2");
    let d = p.run(&[dep(u, SOL), dep(v, SOL), dep(u, 20_000_000)]);
    d.assert_ok().assert_cpi_same();
    assert_eq!(d.anchor.events.len(), 3);
}

// ═══ request_withdraw ════════════════════════════════════════════════════════

#[test]
fn req_happy_and_boundaries() {
    let (mut p, _w, u) = lp_world();
    let d = p.run(&[req(u, 1)]);
    d.assert_ok();
    cu("request_withdraw", &d);
    let ps = pos(&p, &u);
    assert_eq!((ps.units, ps.pending_units, ps.pending_unlock_slot), (SOL as u128 - 1, 1, START_SLOT + COOLDOWN));
    assert_eq!(v2(&p).total_pending_units, 1);
    p.run(&[req(u, 1)]).assert_err(6035);
    p.ok(&[cancel(u)]);
    // all units
    p.ok(&[req(u, SOL as u128)]);
    assert_eq!(pos(&p, &u).units, 0);
}

#[test]
fn req_errors() {
    let (mut p, _w, u) = lp_world();
    p.run(&[req(u, 0)]).assert_err(6009);
    p.run(&[req(u, SOL as u128 + 1)]).assert_err(6038);
    p.run(&[req(u, u128::MAX)]).assert_err(6038);
    // pending check comes first
    p.ok(&[req(u, 10)]);
    p.run(&[req(u, 0)]).assert_err(6035);
}

#[test]
fn req_total_pending_overflow_6008() {
    let (mut p, _w, u) = lp_world();
    set_v2(&mut p, |s| s.total_pending_units = u128::MAX);
    p.run(&[req(u, 1)]).assert_err(6008);
}

#[test]
fn req_cooldown_saturates() {
    let (mut p, w, u) = lp_world();
    p.ok(&[cfg_one(w.owner, 3, u64::MAX)]);
    p.ok(&[req(u, 5)]);
    assert_eq!(pos(&p, &u).pending_unlock_slot, u64::MAX);
    p.warp(START_SLOT + 10_000_000);
    p.run(&[complete(u)]).assert_err(6037);
}

#[test]
fn req_allowed_while_paused() {
    let (mut p, w, u) = lp_world();
    p.ok(&[ix::UpdateVault { owner: w.owner, ..Default::default() }.ix(None, None, None, None, Some(true), None, None)]);
    p.ok(&[req(u, 5)]);
    p.ok(&[cancel(u)]);
    p.ok(&[req(u, 5)]);
    p.warp(START_SLOT + COOLDOWN);
    p.ok(&[complete(u)]);
}

/// Shared UserLpAction substitution / flag checks for request (args), cancel and complete.
/// `complete`: complete_withdraw no longer needs the user's signature on the port (F4).
fn user_lp_action_attacks(mk: fn(Address, Address, Address, Address) -> Instruction, complete: bool) {
    let (mut p, _w, a) = pending_world();
    let b = p.user("bob");
    p.ok(&[dep(b, SOL)]);
    let (pa, pb) = (pda::lp(&a), pda::lp(&b));
    let (vv, ss) = (ids::VAULT, ids::V2_STATE);
    // someone else's position
    p.run(&[mk(vv, ss, pa, b)]).assert_err(2006);
    // uninitialised position
    let c = p.user("carol");
    p.run(&[mk(vv, ss, pda::lp(&c), c)]).assert_err(3012);
    // vault / v2 / position swaps (same account twice)
    p.run(&[mk(ss, ss, pa, a)]).assert_err(3002);
    p.run(&[mk(vv, vv, pa, a)]).assert_err(3002);
    p.run(&[mk(vv, ss, ss, a)]).assert_err(3002);
    p.run(&[mk(vv, ss, vv, a)]).assert_err(3002);
    p.run(&[mk(pa, ss, pa, a)]).assert_err(3002);
    p.run(&[mk(vv, pa, pa, a)]).assert_err(3002);
    // position == user slot
    p.run(&[mk(vv, ss, a, a)]).assert_err(3007);
    // fake vault / v2 clones
    let fv = key("fake-vault");
    p.set_account(fv, p.get(&vv).unwrap());
    p.run(&[mk(fv, ss, pa, a)]).assert_err(2006);
    let fs = key("fake-v2");
    p.set_account(fs, p.get(&ss).unwrap());
    p.run(&[mk(vv, fs, pa, a)]).assert_err(2006);
    // position clone at a non-PDA key
    let fp = key("fake-pos");
    p.set_account(fp, p.get(&pa).unwrap());
    p.run(&[mk(vv, ss, fp, a)]).assert_err(2006);
    // position at c's PDA with c's bump but user = a -> 6007 (signed by c)
    p.set_program_account(pda::lp(&c), position_bytes(a, SOL as u128, 5, 0));
    let mut bytes = p.get(&pda::lp(&c)).unwrap().data;
    bytes[88] = lp_bump(&c);
    p.patch(pda::lp(&c), |d| *d = bytes);
    p.run(&[mk(vv, ss, pda::lp(&c), c)]).assert_err(6007);
    // and the reverse: a signs with c's position whose user = a -> seeds fail first
    p.run(&[mk(vv, ss, pda::lp(&c), a)]).assert_err(2006);
    // other program / bad disc / short at the right PDA
    let real = p.get(&pb).unwrap();
    p.set_account(pb, Account { owner: key("other-prog"), ..real.clone() });
    p.run(&[mk(vv, ss, pb, b)]).assert_err(3007);
    p.set_program_account(pb, vec![0; 3]);
    p.run(&[mk(vv, ss, pb, b)]).assert_err(3001);
    p.set_program_account(pb, v2(&p).encode()[..121].to_vec());
    p.run(&[mk(vv, ss, pb, b)]).assert_err(3002);
    p.set_program_account(pb, real.data[..60].to_vec());
    p.run(&[mk(vv, ss, pb, b)]).assert_err(3003);
    // stored bump wrong
    let mut d = real.data.clone();
    d[88] = d[88].wrapping_sub(1);
    p.set_account(pb, Account { data: d, ..real.clone() });
    p.run(&[mk(vv, ss, pb, b)]).assert_err(2006);
    // longer position data is accepted by Account<T> (no space constraint here)
    let mut d = real.data.clone();
    d.extend_from_slice(&[0xab; 7]);
    p.set_account(pb, Account { data: d, ..real.clone() });
    p.run(&[mk(vv, ss, pb, b)]).assert_same();
    p.set_account(pb, real.clone());
    // flags
    let mut i = mk(vv, ss, pa, a);
    i.accounts[3].is_signer = false;
    if complete {
        // INTENDED: F4. Anchor needs the user's signature (3010); the port proceeds to the cooldown check.
        let d = p.run(&[i]);
        assert_eq!((d.anchor.code(), d.port.code()), (Some(3010), Some(6037)), "{}", d.report());
    } else {
        p.run(&[i]).assert_err(3010);
    }
    for slot in [0, 1, 2, 3] {
        let mut i = mk(vv, ss, pa, a);
        i.accounts[slot].is_writable = false;
        p.run(&[i]).assert_err(2000);
    }
    // short account lists
    for n in [0, 1, 2, 3] {
        let mut i = mk(vv, ss, pa, a);
        i.accounts.truncate(n);
        assert_short(&p.run(&[i]));
    }
    // extra remaining accounts are ignored (outcome must just match)
    let mut i = mk(vv, ss, pa, a);
    i.accounts.push(AccountMeta::new(pb, false));
    p.run(&[i]).assert_same();
}

#[test]
fn req_account_attacks() {
    user_lp_action_attacks(|vault, v2_state, position, user| ix::RequestWithdraw { vault, v2_state, position, user }.ix(1), false);
}

#[test]
fn req_args() {
    let (mut p, _w, u) = lp_world();
    let mut i = req(u, 5);
    i.data.truncate(23);
    p.run(&[i]).assert_err(102);
    let mut i = req(u, 5);
    i.data.truncate(8);
    p.run(&[i]).assert_err(102);
    let mut i = req(u, 5);
    i.data.extend_from_slice(&[9; 4]);
    p.ok(&[i]);
}

// ═══ cancel_withdraw ═════════════════════════════════════════════════════════

#[test]
fn cancel_happy() {
    let (mut p, _w, u) = pending_world();
    let before = pos(&p, &u);
    let d = p.run(&[cancel(u)]);
    d.assert_ok();
    cu("cancel_withdraw", &d);
    let ps = pos(&p, &u);
    assert_eq!((ps.units, ps.pending_units, ps.pending_unlock_slot), (before.units + before.pending_units, 0, 0));
    assert_eq!(v2(&p).total_pending_units, 0);
    p.run(&[cancel(u)]).assert_err(6036);
}

#[test]
fn cancel_errors() {
    let (mut p, _w, u) = lp_world();
    p.run(&[cancel(u)]).assert_err(6036);
    // units + pending overflow
    let (mut p, _w, u) = pending_world();
    set_pos(&mut p, &u, |s| s.units = u128::MAX);
    p.run(&[cancel(u)]).assert_err(6008);
    // total_pending underflow
    let (mut p, _w, u) = pending_world();
    set_v2(&mut p, |s| s.total_pending_units = 0);
    p.run(&[cancel(u)]).assert_err(6008);
    // trailing data ignored
    let (mut p, _w, u) = pending_world();
    let mut i = cancel(u);
    i.data.extend_from_slice(&[1; 30]);
    p.ok(&[i]);
}

#[test]
fn cancel_account_attacks() {
    user_lp_action_attacks(|vault, v2_state, position, user| ix::CancelWithdraw { vault, v2_state, position, user }.ix(), false);
}

// ═══ complete_withdraw ═══════════════════════════════════════════════════════

#[test]
fn complete_happy_and_cooldown_boundary() {
    let (mut p, _w, u) = pending_world();
    let unlock = pos(&p, &u).pending_unlock_slot;
    p.warp(unlock - 1);
    p.run(&[complete(u)]).assert_err(6037);
    p.warp(unlock);
    let (ul, vl) = (p.lamports(&u), p.lamports(&ids::VAULT));
    let d = p.run(&[complete(u)]);
    d.assert_ok();
    cu("complete_withdraw", &d);
    let half = SOL / 2;
    assert_eq!(p.lamports(&u) - ul, half); // fee payer is p.payer
    assert_eq!(vl - p.lamports(&ids::VAULT), half);
    let ps = pos(&p, &u);
    assert_eq!((ps.pending_units, ps.pending_unlock_slot), (0, 0));
    p.run(&[complete(u)]).assert_err(6036);
}

#[test]
fn complete_errors() {
    let (mut p, _w, u) = lp_world();
    p.run(&[complete(u)]).assert_err(6036);
    // 6039: pending > total_units -> assets_out > assets_pre
    let (mut p, _w, u) = lp_world();
    let t = v2(&p).total_units;
    set_pos(&mut p, &u, |s| { s.pending_units = 2 * t; s.pending_unlock_slot = 0; });
    p.run(&[complete(u)]).assert_err(6039);
    // 6008: units * assets overflows u128
    set_pos(&mut p, &u, |s| s.pending_units = u128::MAX);
    p.run(&[complete(u)]).assert_err(6008);
    // 6008: units_to_assets result > u64
    set_v2(&mut p, |s| s.total_units = 1);
    set_pos(&mut p, &u, |s| s.pending_units = 1u128 << 70);
    p.run(&[complete(u)]).assert_err(6008);
    // 6008: total_pending underflow
    let (mut p, _w, u) = pending_world();
    p.warp(START_SLOT + COOLDOWN);
    set_v2(&mut p, |s| s.total_pending_units = 0);
    p.run(&[complete(u)]).assert_err(6008);
    // 6008: total_units underflow with zero assets (assets_out = 0 passes 6039)
    let (mut p, _w, u) = lp_world();
    let t = v2(&p).total_units;
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE));
    set_pos(&mut p, &u, |s| { s.pending_units = t + 1; s.pending_unlock_slot = 0; });
    set_v2(&mut p, |s| s.total_pending_units = t + 1);
    p.run(&[complete(u)]).assert_err(6008);
}

#[test]
fn complete_zero_assets_burns_without_transfer() {
    let (mut p, _w, u) = pending_world();
    p.warp(START_SLOT + COOLDOWN);
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE));
    let ul = p.lamports(&u);
    let d = p.run(&[complete(u)]);
    d.assert_ok();
    assert_eq!(p.lamports(&u), ul);
    assert_eq!(pos(&p, &u).pending_units, 0);
    // vault below rent: assets saturate to 0 too
    let (mut p, _w, u) = pending_world();
    p.warp(START_SLOT + COOLDOWN);
    set_lamports(&mut p, ids::VAULT, rent_min(Vault::SPACE) / 2);
    p.ok(&[complete(u)]);
}

#[test]
fn complete_ignores_paused_and_obligations() {
    let (mut p, w, u) = pending_world();
    p.ok(&[ix::UpdateVault { owner: w.owner, ..Default::default() }.ix(None, None, None, None, Some(true), None, None)]);
    set_v2(&mut p, |s| s.total_outstanding_max_payout = 50 * SOL);
    p.warp(START_SLOT + COOLDOWN);
    p.ok(&[complete(u)]);
}

#[test]
fn complete_user_is_vault_alias() {
    // a (faked) position for user = vault: debit and credit hit the same account -> net zero
    let (mut p, _w) = world();
    let units = SOL as u128;
    // INTENDED: F4. Unlock START_SLOT, not 0: at unlock 0 the port's claim window has long lapsed (6056).
    p.set_program_account(pda::lp(&ids::VAULT), position_bytes(ids::VAULT, 0, units, START_SLOT));
    set_v2(&mut p, |s| s.total_pending_units = units);
    let vl = p.lamports(&ids::VAULT);
    let i = ix::CompleteWithdraw { position: pda::lp(&ids::VAULT), user: ids::VAULT, ..Default::default() }.ix();
    p.run(&[i]).assert_ok();
    assert_eq!(p.lamports(&ids::VAULT), vl);
}

#[test]
fn complete_account_attacks() {
    user_lp_action_attacks(|vault, v2_state, position, user| ix::CompleteWithdraw { vault, v2_state, position, user }.ix(), true);
}

#[test]
fn complete_account_attacks_after_cooldown() {
    // same attacks once the pending withdraw is claimable (the handler would move lamports)
    let (mut p, _w, a) = pending_world();
    p.warp(START_SLOT + COOLDOWN);
    let b = p.user("bob");
    p.run(&[ix::CompleteWithdraw { position: pda::lp(&a), user: b, ..Default::default() }.ix()]).assert_err(2006);
    let fv = key("fake-vault");
    p.set_account(fv, p.get(&ids::VAULT).unwrap());
    p.run(&[ix::CompleteWithdraw { vault: fv, position: pda::lp(&a), user: a, ..Default::default() }.ix()]).assert_err(2006);
    let mut i = complete(a);
    i.accounts[0].is_writable = false;
    p.run(&[i]).assert_err(2000);
    let mut i = complete(a);
    i.accounts[3].is_writable = false;
    p.run(&[i]).assert_err(2000);
    let mut i = complete(a);
    i.data.extend_from_slice(&[0; 8]);
    p.ok(&[i]);
}

// ═══ close_lp_position ═══════════════════════════════════════════════════════

/// lp_world, then the whole position withdrawn (units 0, pending 0).
fn empty_world() -> (Pair, World, Address) {
    let (mut p, w, u) = lp_world();
    p.ok(&[req(u, SOL as u128)]);
    p.warp(START_SLOT + COOLDOWN);
    p.ok(&[complete(u)]);
    (p, w, u)
}

#[test]
fn close_happy() {
    let (mut p, _w, u) = empty_world();
    let ul = p.lamports(&u);
    let d = p.run(&[close(u)]);
    d.assert_ok();
    cu("close_lp_position", &d);
    assert_eq!(p.lamports(&u) - ul, rent_min(LpPosition::SPACE));
    assert!(p.get(&pda::lp(&u)).is_none_or(|a| a.lamports == 0 && a.data.is_empty() && a.owner == ids::SYSTEM));
    // closing again: uninitialised
    p.run(&[close(u)]).assert_err(3012);
}

#[test]
fn close_returns_donation() {
    let (mut p, _w, u) = empty_world();
    set_lamports(&mut p, pda::lp(&u), rent_min(LpPosition::SPACE) + 3 * SOL);
    let ul = p.lamports(&u);
    p.ok(&[close(u)]);
    assert_eq!(p.lamports(&u) - ul, rent_min(LpPosition::SPACE) + 3 * SOL);
}

#[test]
fn close_not_empty_6040() {
    let (mut p, _w, u) = lp_world();
    p.run(&[close(u)]).assert_err(6040);
    p.ok(&[req(u, SOL as u128)]); // units 0, pending > 0
    p.run(&[close(u)]).assert_err(6040);
    p.ok(&[cancel(u)]);
    p.ok(&[req(u, SOL as u128 - 1)]); // units 1, pending > 0
    p.run(&[close(u)]).assert_err(6040);
}

#[test]
fn close_account_attacks() {
    let (mut p, _w, a) = empty_world();
    let b = p.user("bob");
    let c = |position: Address, user: Address| ix::CloseLpPosition { position, user }.ix();
    // someone else's position
    p.run(&[c(pda::lp(&a), b)]).assert_err(2006);
    // uninitialised
    p.run(&[c(pda::lp(&b), b)]).assert_err(3012);
    // same account twice
    p.run(&[c(a, a)]).assert_err(3007);
    p.run(&[c(ids::VAULT, a)]).assert_err(3002);
    p.run(&[c(ids::V2_STATE, a)]).assert_err(3002);
    // clone at a non-PDA key
    let fp = key("fake-pos");
    p.set_account(fp, p.get(&pda::lp(&a)).unwrap());
    p.run(&[c(fp, a)]).assert_err(2006);
    // user mismatch at the right PDA (6007)
    p.set_program_account(pda::lp(&b), position_bytes(a, 0, 0, 0));
    let bb = lp_bump(&b);
    p.patch(pda::lp(&b), |d| d[88] = bb);
    p.run(&[c(pda::lp(&b), b)]).assert_err(6007);
    // wrong owner / disc / len / bump
    let real = p.get(&pda::lp(&a)).unwrap();
    let k = pda::lp(&a);
    p.set_account(k, Account { owner: key("other-prog"), ..real.clone() });
    p.run(&[c(k, a)]).assert_err(3007);
    p.set_program_account(k, vec![1; 6]);
    p.run(&[c(k, a)]).assert_err(3001);
    p.set_program_account(k, v2(&p).encode()[..121].to_vec());
    p.run(&[c(k, a)]).assert_err(3002);
    p.set_program_account(k, real.data[..90].to_vec());
    p.run(&[c(k, a)]).assert_err(3003);
    let mut d = real.data.clone();
    d[88] ^= 0x01;
    p.set_account(k, Account { data: d, ..real.clone() });
    p.run(&[c(k, a)]).assert_err(2006);
    p.set_account(k, real.clone());
    // flags
    let mut i = close(a);
    i.accounts[1].is_signer = false;
    p.run(&[i]).assert_err(3010);
    let mut i = close(a);
    i.accounts[0].is_writable = false;
    p.run(&[i]).assert_err(2000);
    let mut i = close(a);
    i.accounts[1].is_writable = false;
    p.run(&[i]).assert_err(2000);
    // short accounts
    for n in [0, 1] {
        let mut i = close(a);
        i.accounts.truncate(n);
        assert_short(&p.run(&[i]));
    }
    // trailing data + extra accounts ignored
    let mut i = close(a);
    i.data.extend_from_slice(&[5; 2]);
    i.accounts.push(AccountMeta::new(ids::VAULT, false));
    p.ok(&[i]);
}

#[test]
fn close_long_data_position() {
    // Account<LpPosition> accepts trailing data; close returns everything and empties the account
    let (mut p, _w, a) = empty_world();
    let k = pda::lp(&a);
    let mut acc = p.get(&k).unwrap();
    acc.data.extend_from_slice(&[0xcd; 40]);
    acc.lamports = rent_min(acc.data.len());
    p.set_account(k, acc);
    p.ok(&[close(a)]);
}

// ═══ multi-step flows ════════════════════════════════════════════════════════

#[test]
fn flow_full_lp_cycle_and_reopen() {
    let (mut p, w) = world();
    let u = p.user("lp");
    let u0 = p.lamports(&u);
    p.ok(&[dep(u, 2 * SOL)]);
    p.ok(&[req(u, SOL as u128)]);
    p.warp(START_SLOT + 100);
    p.ok(&[cancel(u)]);
    p.ok(&[cfg_one(w.owner, 3, 150)]); // shorter cooldown
    p.ok(&[req(u, 2 * SOL as u128)]);
    let unlock = pos(&p, &u).pending_unlock_slot;
    assert_eq!(unlock, START_SLOT + 100 + 150);
    p.warp(unlock - 1);
    p.run(&[complete(u)]).assert_err(6037);
    p.warp(unlock);
    p.ok(&[complete(u)]);
    p.ok(&[close(u)]);
    assert_eq!(p.lamports(&u), u0); // fees paid by p.payer: full round trip
    // reopen: position re-created and re-stamped
    p.warp(unlock + 5);
    p.ok(&[dep(u, SOL)]).assert_cpi_same();
    let ps = pos(&p, &u);
    assert_eq!((ps.user, ps.created_slot, ps.units), (u, unlock + 5, SOL as u128));
}

#[test]
fn flow_close_and_redeposit_same_tx() {
    let (mut p, _w, u) = empty_world();
    let d = p.run(&[close(u), dep(u, SOL)]);
    d.assert_ok().assert_cpi_same();
    assert_eq!(pos(&p, &u).units, SOL as u128);
    // complete + close + deposit in one tx
    p.ok(&[req(u, SOL as u128)]);
    p.warp(p.slot() + COOLDOWN);
    p.ok(&[complete(u), close(u), dep(u, SOL)]);
}

#[test]
fn flow_two_lps_with_donation_and_house_deposit() {
    let (mut p, w) = world();
    let (a, b) = (p.user("lp-a"), p.user("lp-b"));
    p.ok(&[dep(a, 3 * SOL)]);
    p.fund_vault(w.house, 10 * SOL); // donation raises the share price
    p.ok(&[dep(b, 3 * SOL)]); // b gets fewer units than a
    assert!(pos(&p, &b).units < pos(&p, &a).units);
    p.ok(&[ix::HouseDeposit { owner: w.owner, ..Default::default() }.ix(2 * SOL)]);
    let (ua, ub) = (pos(&p, &a).units, pos(&p, &b).units);
    p.ok(&[req(a, ua), req(b, ub)]);
    p.warp(START_SLOT + COOLDOWN);
    let (la, lb) = (p.lamports(&a), p.lamports(&b));
    p.ok(&[complete(a)]);
    p.ok(&[complete(b)]);
    let (ga, gb) = (p.lamports(&a) - la, p.lamports(&b) - lb);
    assert!(ga > 3 * SOL && gb <= 3 * SOL + 1, "a gained {ga}, b got {gb}");
    p.ok(&[close(a), close(b)]);
    let s = v2(&p);
    assert_eq!((s.total_pending_units, s.total_units - s.seed_units - s.house_units - s.house_pending_units), (0, 0));
}

#[test]
fn flow_game_loss_raises_share_price() {
    // a legacy game lost by the player adds the bet to vault assets; the LP withdraws more than deposited
    let (mut p, w, u) = lp_world();
    let player = p.user("player");
    let (layout, salt) = (0b0000_0000_0000_0100u16, [9u8; 32]); // one mine on tile 2
    let game = p.start_game(player, 1, 10_000_000, layout, salt);
    p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(2, true)]);
    p.ok(&[ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: w.treasury, ..Default::default() }.ix(layout, salt)]);
    // outstanding released: deposit + withdraw path sees the new assets
    p.ok(&[req(u, SOL as u128)]);
    p.warp(START_SLOT + COOLDOWN);
    let l = p.lamports(&u);
    p.run(&[complete(u)]).assert_ok();
    println!("flow_game_loss: LP withdrew {} for 1 SOL", p.lamports(&u) - l);
}

#[test]
fn flow_ownership_handover_then_admin_and_lp() {
    let (mut p, w, u) = lp_world();
    let n = p.user("new-owner");
    p.ok(&[ix::ProposeOwner { owner: w.owner, ..Default::default() }.ix(n)]);
    p.ok(&[ix::AcceptOwnership { new_owner: n, ..Default::default() }.ix()]);
    p.run(&[cfg_one(w.owner, 4, 0)]).assert_err(6007);
    p.ok(&[cfg_one(n, 4, 0)]);
    p.ok(&[ix::UpdateVault { owner: n, ..Default::default() }.ix(None, None, None, None, Some(true), None, None)]);
    p.run(&[dep(u, SOL)]).assert_err(6012);
    p.ok(&[ix::UpdateVault { owner: n, ..Default::default() }.ix(None, None, None, None, Some(false), None, None)]);
    p.ok(&[dep(u, SOL)]);
}
