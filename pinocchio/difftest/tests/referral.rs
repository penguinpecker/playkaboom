//! Referral group (spec/referral.md): set_referrer, claim_referral, repair_referral.
//! Every test runs the same tx on the Anchor reference and on kaboom-p and asserts zero DIFF POLICY
//! disagreements. Tests named `diff_*` reproduce a real disagreement and are kept failing on purpose.
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const RA_SPACE: usize = accounts::ReferralAccount::SPACE; // 103
const PS_SPACE: usize = accounts::PlayerStats::SPACE; // 203

fn cu(tag: &str, d: &Diff) {
    let (a, p) = d.cu();
    println!("CU {tag}: anchor {a} port {p}");
}

// ---- local builders / state helpers ----

fn sr(player: Address, referrer: Address) -> Instruction {
    ix::SetReferrer { player_stats: pda::stats(&player), referrer, referral_account: pda::referral(&referrer), player, ..Default::default() }.ix()
}
fn claim(referrer: Address) -> Instruction {
    ix::ClaimReferral { referral_account: pda::referral(&referrer), referrer }.ix()
}
fn repair(owner: Address, referrer: Address) -> Instruction {
    ix::RepairReferral { referrer, referral_account: pda::referral(&referrer), owner, ..Default::default() }.ix()
}
fn ra(referrer: Address, accrued: u64) -> accounts::ReferralAccount {
    let bump = pda::find(&[b"kaboom_referral", referrer.as_ref()], &PROGRAM_ID).1;
    accounts::ReferralAccount {
        referrer, bump, version: 1, tier: 0, accrued_lamports: accrued, total_earned: accrued,
        referred_count: 1, referred_volume: 0, _reserved: [0; 32],
    }
}
fn stats(player: Address) -> accounts::PlayerStats {
    let bump = pda::find(&[b"kaboom_stats", player.as_ref()], &PROGRAM_ID).1;
    accounts::PlayerStats {
        player, bump, version: 1, games_played: 0, games_won: 0, total_wagered: 0, total_payouts: 0,
        biggest_win: 0, biggest_multiplier_bps: 0, current_streak: 0, best_streak: 0, last_played: 0,
        referrer: None, _reserved: [0; 64],
    }
}
/// Program-owned account with exactly `lamports`.
fn put(p: &mut Pair, k: Address, owner: Address, data: Vec<u8>, lamports: u64) {
    p.set_account(k, Account { lamports, data, owner, executable: false, rent_epoch: 0 });
}
/// Referral account at the canonical PDA with rent + `extra` lamports.
fn put_ra(p: &mut Pair, r: &accounts::ReferralAccount, extra: u64) -> Address {
    let k = pda::referral(&r.referrer);
    put(p, k, PROGRAM_ID, r.encode(), rent_min(RA_SPACE) + extra);
    k
}
fn read_ra(p: &Pair, referrer: &Address) -> accounts::ReferralAccount { p.read(&pda::referral(referrer), accounts::ReferralAccount::decode) }
fn read_ps(p: &Pair, player: &Address) -> accounts::PlayerStats { p.read(&pda::stats(player), accounts::PlayerStats::decode) }
/// A valid bump for `seeds` other than the canonical one (and its address).
fn noncanonical(seeds: &[&[u8]]) -> (Address, u8) {
    let canon = pda::find(seeds, &PROGRAM_ID).1;
    for b in (0..canon).rev() {
        let mut s: Vec<&[u8]> = seeds.to_vec();
        let bb = [b];
        s.push(&bb);
        if let Ok(a) = Address::create_program_address(&s, &PROGRAM_ID) { return (a, b); }
    }
    panic!("no non-canonical bump");
}

// =====================================================================================
// set_referrer
// =====================================================================================

#[test]
fn sr_happy_fresh_accounts() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let d = p.run(&[sr(player, referrer)]);
    d.assert_ok().assert_cpi_same();
    cu("set_referrer (fresh stats + fresh referral)", &d);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: SetReferrer"]);
    assert_eq!(d.anchor.events.len(), 1);
    assert_eq!(event_name(&d.anchor.events[0]), "ReferrerSet");
    let s = read_ps(&p, &player);
    assert_eq!((s.player, s.version, s.referrer), (player, 1, Some(referrer)));
    let r = read_ra(&p, &referrer);
    assert_eq!((r.referrer, r.version, r.tier, r.referred_count), (referrer, 1, 0, 1));
    assert_eq!(p.lamports(&pda::stats(&player)), rent_min(PS_SPACE));
    assert_eq!(p.lamports(&pda::referral(&referrer)), rent_min(RA_SPACE));
}

#[test]
fn sr_happy_existing_stats_from_start_game() {
    let mut p = Pair::new();
    p.house_world();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.start_game(player, 1, 10_000_000, 0b100, [7; 32]);
    let before = read_ps(&p, &player);
    let d = p.run(&[sr(player, referrer)]);
    d.assert_ok().assert_cpi_same();
    cu("set_referrer (existing stats, fresh referral)", &d);
    let s = read_ps(&p, &player);
    assert_eq!(s.referrer, Some(referrer));
    assert_eq!((s.games_played, s.total_wagered, s.bump), (before.games_played, before.total_wagered, before.bump));
}

#[test]
fn sr_happy_second_player_existing_referral() {
    let mut p = Pair::new();
    let referrer = key("referrer");
    let (a, b) = (p.user("pa"), p.user("pb"));
    p.ok(&[sr(a, referrer)]);
    let d = p.run(&[sr(b, referrer)]);
    d.assert_ok().assert_cpi_same();
    cu("set_referrer (fresh stats, existing referral)", &d);
    assert_eq!(read_ra(&p, &referrer).referred_count, 2);
}

#[test]
fn sr_happy_both_existing() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.set_program_account(pda::stats(&player), stats(player).encode());
    put_ra(&mut p, &ra(referrer, 0), 0);
    let d = p.run(&[sr(player, referrer)]);
    d.assert_ok();
    assert!(d.anchor.cpis.is_empty());
    cu("set_referrer (both existing)", &d);
}

#[test]
fn sr_two_in_one_tx_same_referrer() {
    let mut p = Pair::new();
    let referrer = key("referrer");
    let (a, b) = (p.user("pa"), p.user("pb"));
    p.run(&[sr(a, referrer), sr(b, referrer)]).assert_ok().assert_cpi_same();
    assert_eq!(read_ra(&p, &referrer).referred_count, 2);
}

#[test]
fn sr_already_set_same_referrer() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.ok(&[sr(player, referrer)]);
    p.run(&[sr(player, referrer)]).assert_err(6021);
}

#[test]
fn sr_already_set_other_referrer() {
    let mut p = Pair::new();
    let (player, r1, r2) = (p.user("player"), key("r1"), key("r2"));
    p.ok(&[sr(player, r1)]);
    p.run(&[sr(player, r2)]).assert_err(6021);
    assert!(p.get(&pda::referral(&r2)).is_none());
}

#[test]
fn sr_self_referral() {
    let mut p = Pair::new();
    let player = p.user("player");
    p.run(&[sr(player, player)]).assert_err(6020);
    assert!(p.get(&pda::stats(&player)).is_none());
}

#[test]
fn sr_wrong_stats_pda_other_player() {
    let mut p = Pair::new();
    let (player, other, referrer) = (p.user("player"), p.user("other"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[0].pubkey = pda::stats(&other);
    p.run(&[i]).assert_err(2006);
}

#[test]
fn sr_wrong_stats_pda_random_key() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[0].pubkey = key("random");
    p.run(&[i]).assert_err(2006);
}

#[test]
fn sr_wrong_stats_pda_noncanonical_bump() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let (nc, b) = noncanonical(&[b"kaboom_stats", player.as_ref()]);
    let mut s = stats(player);
    s.bump = b;
    p.set_program_account(nc, s.encode());
    let mut i = sr(player, referrer);
    i.accounts[0].pubkey = nc;
    p.run(&[i]).assert_err(2006);
}

#[test]
fn sr_wrong_referral_pda_other_referrer() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[2].pubkey = pda::referral(&key("other-ref"));
    p.run(&[i]).assert_err(2006);
}

#[test]
fn sr_wrong_referral_pda_noncanonical_existing() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let (nc, b) = noncanonical(&[b"kaboom_referral", referrer.as_ref()]);
    let mut r = ra(referrer, 0);
    r.bump = b;
    p.set_program_account(nc, r.encode());
    let mut i = sr(player, referrer);
    i.accounts[2].pubkey = nc;
    p.run(&[i]).assert_err(2006);
}

#[test]
fn sr_same_account_twice_stats_in_referral_slot() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[2].pubkey = pda::stats(&player);
    p.run(&[i]).assert_failed();
}

#[test]
fn sr_same_account_twice_existing_stats_in_referral_slot() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.set_program_account(pda::stats(&player), stats(player).encode());
    let mut i = sr(player, referrer);
    i.accounts[2].pubkey = pda::stats(&player);
    p.run(&[i]).assert_err(2006);
}

#[test]
fn sr_player_in_stats_slot() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[0].pubkey = player;
    p.run(&[i]).assert_err(2006);
}

#[test]
fn sr_referrer_is_stats_pda() {
    // referrer is unchecked: any key is accepted, even the player's own stats PDA.
    let mut p = Pair::new();
    let player = p.user("player");
    let r = pda::stats(&player);
    p.run(&[sr(player, r)]).assert_ok().assert_cpi_same();
}

#[test]
fn sr_referrer_is_program_or_sysvar() {
    let mut p = Pair::new();
    let (a, b, c) = (p.user("pa"), p.user("pb"), p.user("pc"));
    p.run(&[sr(a, ids::SYSTEM)]).assert_ok();
    p.run(&[sr(b, PROGRAM_ID)]).assert_ok();
    p.run(&[sr(c, ids::SLOT_HASHES)]).assert_ok();
}

#[test]
fn sr_referrer_existing_funded_writable() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), p.user("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[1].is_writable = true;
    i.accounts[1].is_signer = true;
    p.run(&[i]).assert_ok();
}

#[test]
fn sr_player_not_signer() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[3].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn sr_player_not_writable_fresh() {
    // fresh: the create_account CPI from a read-only payer fails first
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[3].is_writable = false;
    p.run(&[i]).assert_failed();
}

#[test]
fn sr_player_not_writable_existing() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.set_program_account(pda::stats(&player), stats(player).encode());
    put_ra(&mut p, &ra(referrer, 0), 0);
    let mut i = sr(player, referrer);
    i.accounts[3].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn sr_stats_not_writable_fresh() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[0].is_writable = false;
    p.run(&[i]).assert_failed();
}

#[test]
fn sr_stats_not_writable_existing() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.set_program_account(pda::stats(&player), stats(player).encode());
    let mut i = sr(player, referrer);
    i.accounts[0].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn sr_referral_not_writable_fresh() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[2].is_writable = false;
    p.run(&[i]).assert_failed();
}

#[test]
fn sr_referral_not_writable_existing() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    put_ra(&mut p, &ra(referrer, 0), 0);
    let mut i = sr(player, referrer);
    i.accounts[2].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn sr_system_program_wrong_key() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[4].pubkey = key("not-system");
    p.run(&[i]).assert_err(3008);
}

#[test]
fn sr_system_program_other_executable() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[4].pubkey = ids::DLP; // executable, not the system program
    p.run(&[i]).assert_err(3008);
}

#[test]
fn sr_system_program_is_kaboom() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.accounts[4].pubkey = PROGRAM_ID;
    p.run(&[i]).assert_err(3008);
}

#[test]
fn sr_short_account_list() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    for n in 0..5 {
        let mut i = sr(player, referrer);
        i.accounts.truncate(n);
        p.run(&[i]).assert_failed();
    }
}

#[test]
fn sr_extra_data_and_remaining_accounts_ignored() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.data.extend_from_slice(&[9; 40]);
    i.accounts.push(AccountMeta::new(key("junk"), false));
    i.accounts.push(AccountMeta::new(pda::referral(&key("x")), false));
    p.run(&[i]).assert_ok();
}

#[test]
fn sr_short_discriminator() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    for n in [0usize, 1, 7] {
        let mut i = sr(player, referrer);
        i.data.truncate(n);
        p.run(&[i]).assert_failed();
    }
}

#[test]
fn sr_unknown_discriminator() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut i = sr(player, referrer);
    i.data[7] ^= 0xff;
    p.run(&[i]).assert_err(101);
}

#[test]
fn sr_player_cannot_pay_rent() {
    let mut p = Pair::new();
    let referrer = key("referrer");
    let player = key("poor");
    p.fund(player, rent_min(PS_SPACE) + 10); // enough for stats, not for the referral account
    p.run(&[sr(player, referrer)]).assert_failed();
}

#[test]
fn sr_player_is_fee_payer() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.run_as(player, &[sr(player, referrer)]).assert_ok().assert_cpi_same();
}

// ---- pre-funded (dust) PDAs: transfer top-up + allocate + assign ----

#[test]
fn sr_dust_stats_pda() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.fund(pda::stats(&player), 1);
    let d = p.run(&[sr(player, referrer)]);
    d.assert_ok().assert_cpi_same();
    cu("set_referrer (dust stats PDA)", &d);
    assert_eq!(p.lamports(&pda::stats(&player)), rent_min(PS_SPACE));
}

#[test]
fn sr_dust_referral_pda() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.fund(pda::referral(&referrer), 1);
    let d = p.run(&[sr(player, referrer)]);
    d.assert_ok().assert_cpi_same();
    cu("set_referrer (dust referral PDA)", &d);
    assert_eq!(p.lamports(&pda::referral(&referrer)), rent_min(RA_SPACE));
}

#[test]
fn sr_dust_both_pdas() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.fund(pda::stats(&player), 777);
    p.fund(pda::referral(&referrer), 999);
    p.run(&[sr(player, referrer)]).assert_ok().assert_cpi_same();
}

#[test]
fn sr_prefunded_above_rent() {
    // required = 0 -> no Transfer CPI, only allocate + assign; surplus stays.
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.fund(pda::stats(&player), rent_min(PS_SPACE) + 12345);
    p.fund(pda::referral(&referrer), rent_min(RA_SPACE));
    p.run(&[sr(player, referrer)]).assert_ok().assert_cpi_same();
    assert_eq!(p.lamports(&pda::stats(&player)), rent_min(PS_SPACE) + 12345);
}

#[test]
fn sr_prefunded_system_owned_with_data() {
    // System-owned but already allocated: Allocate fails inside the system program.
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    put(&mut p, pda::stats(&player), ids::SYSTEM, vec![0; PS_SPACE], rent_min(PS_SPACE));
    p.run(&[sr(player, referrer)]).assert_failed();
}

#[test]
fn sr_prefunded_system_owned_wrong_size_data() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    put(&mut p, pda::referral(&referrer), ids::SYSTEM, vec![0; 10], rent_min(10));
    p.run(&[sr(player, referrer)]).assert_failed();
}

// ---- existing account substitution / corruption: player_stats ----

#[test]
fn sr_stats_wrong_owner() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.set_data(pda::stats(&player), key("other-program"), stats(player).encode());
    p.run(&[sr(player, referrer)]).assert_err(3007);
}

#[test]
fn sr_stats_wrong_discriminator() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    b[0] ^= 1;
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_err(3002);
}

#[test]
fn sr_stats_holds_referral_account_bytes() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = ra(referrer, 0).encode();
    b.resize(PS_SPACE, 0);
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_err(3002);
}

#[test]
fn sr_stats_data_shorter_than_disc() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.set_program_account(pda::stats(&player), vec![169, 146, 242]);
    p.run(&[sr(player, referrer)]).assert_err(3001);
}

#[test]
fn sr_stats_empty_program_owned() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.set_program_account(pda::stats(&player), vec![]);
    p.run(&[sr(player, referrer)]).assert_err(3001);
}

#[test]
fn sr_stats_bad_option_tag() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    b[106] = 2;
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_err(3003);
}

#[test]
fn sr_stats_tag_some_already() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut s = stats(player);
    s.referrer = Some(key("prev"));
    p.set_program_account(pda::stats(&player), s.encode());
    p.run(&[sr(player, referrer)]).assert_err(6021);
}

#[test]
fn sr_stats_too_short_for_borsh() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    b.truncate(170);
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_err(3003);
}

#[test]
fn sr_stats_wrong_space_short() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    b.truncate(180);
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_err(2019);
}

#[test]
fn sr_stats_wrong_space_long() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    b.resize(250, 0);
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_err(2019);
}

#[test]
fn sr_stats_tag_some_short_data() {
    // tag = 1 with only 180 bytes: Borsh needs 203 -> 3003
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    b[106] = 1;
    b.truncate(180);
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_err(3003);
}

#[test]
fn sr_stats_below_rent() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    put(&mut p, pda::stats(&player), PROGRAM_ID, stats(player).encode(), rent_min(PS_SPACE) - 1);
    p.run(&[sr(player, referrer)]).assert_err(2005);
}

#[test]
fn sr_stats_player_field_default_keeps_counters() {
    // player == default -> player/bump/version written; other counters kept.
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut s = stats(Address::new_from_array([0; 32]));
    s.bump = 0;
    s.version = 0;
    s.games_played = 5;
    s.total_wagered = 123;
    p.set_program_account(pda::stats(&player), s.encode());
    p.run(&[sr(player, referrer)]).assert_ok();
    let s = read_ps(&p, &player);
    assert_eq!((s.player, s.version, s.games_played), (player, 1, 5));
}

#[test]
fn sr_stats_player_field_foreign_kept() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut s = stats(key("someone-else"));
    s.bump = 7;
    s.version = 9;
    p.set_program_account(pda::stats(&player), s.encode());
    p.run(&[sr(player, referrer)]).assert_ok();
    let s = read_ps(&p, &player);
    assert_eq!((s.player, s.bump, s.version), (key("someone-else"), 7, 9));
}

/// DIFF (unreachable state): port keeps bytes 139..203, Anchor shifts _reserved there.
#[test]
fn diff_sr_stats_reserved_tail_nonzero() {
    // _reserved (Borsh 107..171 when tag 0) non-zero: Anchor re-serializes the whole struct with
    // tag = 1, so the 64 reserved bytes move to 139..203. Not reachable through instructions.
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    for (i, x) in b[107..171].iter_mut().enumerate() { *x = i as u8 + 1; }
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_ok();
}

/// DIFF (unreachable state): port keeps 171..203, Anchor zeroes them.
#[test]
fn diff_sr_stats_trailing_bytes_after_reserved() {
    // tag 0: Borsh reads 171 bytes; 171..203 non-zero is outside the struct. Anchor re-serialize writes
    // tag=1 + 32B referrer + 64B reserved over 106..203.
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    for x in b[171..203].iter_mut() { *x = 0xAB; }
    p.set_program_account(pda::stats(&player), b);
    p.run(&[sr(player, referrer)]).assert_ok();
}

// ---- existing account substitution / corruption: referral_account ----

#[test]
fn sr_referral_wrong_owner() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.set_data(pda::referral(&referrer), key("other-program"), ra(referrer, 0).encode());
    p.run(&[sr(player, referrer)]).assert_err(3007);
}

#[test]
fn sr_referral_wrong_discriminator() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = ra(referrer, 0).encode();
    b[3] ^= 1;
    p.set_program_account(pda::referral(&referrer), b);
    p.run(&[sr(player, referrer)]).assert_err(3002);
}

#[test]
fn sr_referral_holds_stats_bytes() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = stats(player).encode();
    b.truncate(RA_SPACE);
    p.set_program_account(pda::referral(&referrer), b);
    p.run(&[sr(player, referrer)]).assert_err(3002);
}

#[test]
fn sr_referral_too_short() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = ra(referrer, 0).encode();
    b.truncate(100);
    p.set_program_account(pda::referral(&referrer), b);
    p.run(&[sr(player, referrer)]).assert_err(3003);
}

#[test]
fn sr_referral_too_long() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut b = ra(referrer, 0).encode();
    b.resize(120, 0);
    p.set_program_account(pda::referral(&referrer), b);
    p.run(&[sr(player, referrer)]).assert_err(2019);
}

#[test]
fn sr_referral_below_rent() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, ra(referrer, 0).encode(), rent_min(RA_SPACE) - 1);
    p.run(&[sr(player, referrer)]).assert_err(2005);
}

#[test]
fn sr_referral_legacy_default_referrer() {
    // legacy-bugged account (referrer == default): referrer/bump/tier/version rewritten, money fields kept.
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut r = ra(Address::new_from_array([0; 32]), 5_000);
    r.bump = 3;
    r.tier = 2;
    r.version = 0;
    r.referred_count = 4;
    r.referred_volume = 77;
    p.set_program_account(pda::referral(&referrer), r.encode());
    p.run(&[sr(player, referrer)]).assert_ok();
    let r = read_ra(&p, &referrer);
    assert_eq!((r.referrer, r.tier, r.version, r.referred_count, r.accrued_lamports, r.referred_volume), (referrer, 0, 1, 5, 5_000, 77));
}

#[test]
fn sr_referral_foreign_referrer_field() {
    // Account at PDA(referrer) whose data names someone else: kept, count still bumps.
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut r = ra(key("someone"), 0);
    r.tier = 1;
    p.set_program_account(pda::referral(&referrer), r.encode());
    p.run(&[sr(player, referrer)]).assert_ok();
    assert_eq!(read_ra(&p, &referrer).referrer, key("someone"));
}

#[test]
fn sr_referred_count_saturates() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut r = ra(referrer, 0);
    r.referred_count = u32::MAX;
    put_ra(&mut p, &r, 0);
    p.run(&[sr(player, referrer)]).assert_ok();
    assert_eq!(read_ra(&p, &referrer).referred_count, u32::MAX);
}

#[test]
fn sr_referral_reserved_nonzero_kept() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    let mut r = ra(referrer, 0);
    r._reserved = [0x5A; 32];
    put_ra(&mut p, &r, 0);
    p.run(&[sr(player, referrer)]).assert_ok();
}

#[test]
fn sr_slot_in_event() {
    let mut p = Pair::new();
    let (player, referrer) = (p.user("player"), key("referrer"));
    p.warp(START_SLOT + 123_456);
    let d = p.run(&[sr(player, referrer)]);
    d.assert_ok();
    let e = &d.anchor.events[0];
    assert_eq!(e.len(), 80);
    assert_eq!(u64::from_le_bytes(e[72..80].try_into().unwrap()), START_SLOT + 123_456);
}

// =====================================================================================
// claim_referral
// =====================================================================================

#[test]
fn cr_happy_full_payout() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000_000), 1_000_000);
    let before = p.lamports(&referrer);
    let d = p.run(&[claim(referrer)]);
    d.assert_ok();
    cu("claim_referral (full payout)", &d);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: ClaimReferral"]);
    assert_eq!(event_name(&d.anchor.events[0]), "ReferralClaimed");
    assert_eq!(p.lamports(&referrer), before + 1_000_000);
    assert_eq!(p.lamports(&pda::referral(&referrer)), rent_min(RA_SPACE));
    let r = read_ra(&p, &referrer);
    assert_eq!((r.accrued_lamports, r.total_earned), (0, 1_000_000));
}

#[test]
fn cr_partial_payout_capped_by_surplus() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000_000), 400_000);
    let d = p.run(&[claim(referrer)]);
    d.assert_ok();
    cu("claim_referral (partial)", &d);
    assert_eq!(read_ra(&p, &referrer).accrued_lamports, 600_000);
}

#[test]
fn cr_surplus_above_accrued_not_claimable() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 10), 5 * SOL);
    p.run(&[claim(referrer)]).assert_ok();
    assert_eq!(p.lamports(&pda::referral(&referrer)), rent_min(RA_SPACE) + 5 * SOL - 10);
}

#[test]
fn cr_zero_payout_at_rent() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000), 0);
    let d = p.run(&[claim(referrer)]);
    d.assert_ok();
    cu("claim_referral (payout 0)", &d);
    assert_eq!(read_ra(&p, &referrer).accrued_lamports, 1_000);
}

#[test]
fn cr_zero_payout_below_rent() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, ra(referrer, 1_000).encode(), rent_min(RA_SPACE) / 2);
    p.run(&[claim(referrer)]).assert_ok();
}

#[test]
fn cr_nothing_to_claim() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 0), SOL);
    p.run(&[claim(referrer)]).assert_err(6023);
}

#[test]
fn cr_claim_twice() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 500), 500);
    p.ok(&[claim(referrer)]);
    p.run(&[claim(referrer)]).assert_err(6023);
}

#[test]
fn cr_claim_twice_one_tx() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 500), 500);
    p.run(&[claim(referrer), claim(referrer)]).assert_err(6023);
}

#[test]
fn cr_accrued_max_payout_withdrawable() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, u64::MAX), 3 * SOL);
    p.run(&[claim(referrer)]).assert_ok();
    assert_eq!(read_ra(&p, &referrer).accrued_lamports, u64::MAX - 3 * SOL);
}

#[test]
fn cr_credit_overflow() {
    let mut p = Pair::new();
    let referrer = key("rich");
    p.fund(referrer, u64::MAX - 5);
    put_ra(&mut p, &ra(referrer, 100), 100);
    p.run(&[claim(referrer)]).assert_failed();
}

#[test]
fn cr_someone_elses_account() {
    // attacker signs and passes the victim's referral PDA: seeds bind it to the signer -> 2006
    let mut p = Pair::new();
    let (victim, attacker) = (p.user("victim"), p.user("attacker"));
    put_ra(&mut p, &ra(victim, 1_000), 1_000);
    let mut i = claim(attacker);
    i.accounts[0].pubkey = pda::referral(&victim);
    p.run(&[i]).assert_err(2006);
}

#[test]
fn cr_data_names_other_referrer() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let mut r = ra(referrer, 1_000);
    r.referrer = key("someone");
    put_ra(&mut p, &r, 1_000);
    // put_ra used r.referrer for the address: rebuild at the signer's PDA with the signer's bump
    let k = pda::referral(&referrer);
    r.bump = pda::find(&[b"kaboom_referral", referrer.as_ref()], &PROGRAM_ID).1;
    put(&mut p, k, PROGRAM_ID, r.encode(), rent_min(RA_SPACE) + 1_000);
    p.run(&[claim(referrer)]).assert_err(6007);
}

#[test]
fn cr_legacy_default_referrer_field() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let mut r = ra(referrer, 1_000);
    r.referrer = Address::new_from_array([0; 32]);
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, r.encode(), rent_min(RA_SPACE) + 1_000);
    p.run(&[claim(referrer)]).assert_err(6007);
}

#[test]
fn cr_wrong_stored_bump() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let mut r = ra(referrer, 1_000);
    r.bump = r.bump.wrapping_sub(1);
    put_ra(&mut p, &r, 1_000);
    p.run(&[claim(referrer)]).assert_err(2006);
}

#[test]
fn cr_noncanonical_bump_account_accepted() {
    // Anchor checks with the STORED bump: an account at a valid non-canonical PDA that stores that bump passes.
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let (nc, b) = noncanonical(&[b"kaboom_referral", referrer.as_ref()]);
    let mut r = ra(referrer, 1_000);
    r.bump = b;
    put(&mut p, nc, PROGRAM_ID, r.encode(), rent_min(RA_SPACE) + 1_000);
    let mut i = claim(referrer);
    i.accounts[0].pubkey = nc;
    p.run(&[i]).assert_ok();
}

#[test]
fn cr_bump_255_offcurve_check() {
    // every bump value 0..=255 in the stored-bump slot behaves the same on both sides
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    for b in [0u8, 1, 128, 200, 254, 255] {
        let mut r = ra(referrer, 1_000);
        r.bump = b;
        put_ra(&mut p, &r, 1_000);
        p.run(&[claim(referrer)]).assert_same();
    }
}

#[test]
fn cr_referrer_not_signer() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000), 1_000);
    let mut i = claim(referrer);
    i.accounts[1].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn cr_referrer_not_writable() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000), 1_000);
    let mut i = claim(referrer);
    i.accounts[1].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn cr_referral_not_writable() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000), 1_000);
    let mut i = claim(referrer);
    i.accounts[0].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn cr_referral_missing() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    p.run(&[claim(referrer)]).assert_err(3012);
}

#[test]
fn cr_referral_system_owned_funded() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    p.fund(pda::referral(&referrer), SOL);
    p.run(&[claim(referrer)]).assert_err(3007);
}

#[test]
fn cr_referral_wrong_owner() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let k = pda::referral(&referrer);
    put(&mut p, k, key("other-program"), ra(referrer, 1_000).encode(), rent_min(RA_SPACE) + 1_000);
    p.run(&[claim(referrer)]).assert_err(3007);
}

#[test]
fn cr_referral_wrong_disc() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let mut b = ra(referrer, 1_000).encode();
    b[0] = 0;
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, b, rent_min(RA_SPACE) + 1_000);
    p.run(&[claim(referrer)]).assert_err(3002);
}

#[test]
fn cr_stats_account_substituted() {
    // the signer's PlayerStats (program-owned, other disc) passed as the referral account
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    p.set_program_account(pda::stats(&referrer), stats(referrer).encode());
    let mut i = claim(referrer);
    i.accounts[0].pubkey = pda::stats(&referrer);
    p.run(&[i]).assert_err(3002);
}

#[test]
fn cr_referral_short_disc() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, vec![237, 162, 80], rent_min(3));
    p.run(&[claim(referrer)]).assert_err(3001);
}

#[test]
fn cr_referral_short_data() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let mut b = ra(referrer, 1_000).encode();
    b.truncate(102);
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, b, rent_min(102) + 1_000);
    p.run(&[claim(referrer)]).assert_err(3003);
}

#[test]
fn cr_referral_long_data_rent_drop() {
    // 150-byte account: payout uses rent(103), leaving it below rent(150) -> runtime rent-state error
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let mut b = ra(referrer, 10 * SOL).encode();
    b.resize(150, 0);
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, b, rent_min(150) + 1_000);
    p.run(&[claim(referrer)]).assert_failed();
}

#[test]
fn cr_referral_long_data_small_payout() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let mut b = ra(referrer, 500).encode();
    b.resize(150, 0);
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, b, rent_min(150) + 1_000);
    p.run(&[claim(referrer)]).assert_ok();
}

#[test]
fn cr_same_account_twice() {
    // referral PDA in both slots (signer flag forced; sigverify off)
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    let k = put_ra(&mut p, &ra(referrer, 1_000), 1_000);
    let i = ix::ClaimReferral { referral_account: k, referrer: k }.ix();
    p.run(&[i]).assert_err(2006);
}

#[test]
fn cr_referrer_is_pda_signer_of_itself() {
    // account at PDA(R) where R = the referral PDA of someone, signer = R (sigverify off)
    let mut p = Pair::new();
    let base = p.user("base");
    let r = put_ra(&mut p, &ra(base, 1_000), 1_000);
    let k2 = put_ra(&mut p, &ra(r, 2_000), 2_000);
    let i = ix::ClaimReferral { referral_account: k2, referrer: r }.ix();
    // Both runtimes refuse to credit... or not: r is program-owned, crediting is allowed.
    p.run(&[i]).assert_same();
}

#[test]
fn cr_short_account_list() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000), 1_000);
    for n in 0..2 {
        let mut i = claim(referrer);
        i.accounts.truncate(n);
        p.run(&[i]).assert_failed();
    }
}

#[test]
fn cr_extra_data_and_accounts_ignored() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000), 1_000);
    let mut i = claim(referrer);
    i.data.push(1);
    i.accounts.push(AccountMeta::new(key("junk"), false));
    p.run(&[i]).assert_ok();
}

#[test]
fn cr_referrer_fee_payer() {
    let mut p = Pair::new();
    let referrer = p.user("referrer");
    put_ra(&mut p, &ra(referrer, 1_000), 1_000);
    p.run_as(referrer, &[claim(referrer)]).assert_ok();
}

#[test]
fn cr_referrer_nonexistent_signer() {
    // unfunded signer key: credit creates it (system-owned, payout lamports); below rent -> runtime may reject
    let mut p = Pair::new();
    let referrer = key("ghost");
    put_ra(&mut p, &ra(referrer, 1_000), 1_000);
    p.run(&[claim(referrer)]).assert_same();
    let mut p = Pair::new();
    put_ra(&mut p, &ra(referrer, 2 * SOL), 2 * SOL);
    p.run(&[claim(referrer)]).assert_ok();
}

// =====================================================================================
// repair_referral
// =====================================================================================

fn legacy(referrer: Address) -> accounts::ReferralAccount {
    let mut r = ra(referrer, 9_000);
    r.referrer = Address::new_from_array([0; 32]);
    r
}
fn put_legacy(p: &mut Pair, referrer: Address) -> Address {
    let k = pda::referral(&referrer);
    put(p, k, PROGRAM_ID, legacy(referrer).encode(), rent_min(RA_SPACE) + 9_000);
    k
}

#[test]
fn rr_happy_repairs_legacy() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    let d = p.run(&[repair(w.owner, referrer)]);
    d.assert_ok();
    cu("repair_referral (repair)", &d);
    assert_eq!(d.anchor.ix_lines, ["Program log: Instruction: RepairReferral"]);
    assert_eq!(event_name(&d.anchor.events[0]), "ReferralRepaired");
    let r = read_ra(&p, &referrer);
    assert_eq!((r.referrer, r.accrued_lamports), (referrer, 9_000));
    // and now the referrer can claim
    p.fund(referrer, SOL);
    p.run(&[claim(referrer)]).assert_ok();
}

#[test]
fn rr_already_correct_noop() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_ra(&mut p, &ra(referrer, 1), 0);
    let d = p.run(&[repair(w.owner, referrer)]);
    d.assert_ok();
    cu("repair_referral (no-op)", &d);
    assert!(d.anchor.events.is_empty());
}

#[test]
fn rr_other_referrer_in_data() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    let mut r = ra(referrer, 0);
    r.referrer = key("someone");
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, r.encode(), rent_min(RA_SPACE));
    p.run(&[repair(w.owner, referrer)]).assert_err(6007);
}

#[test]
fn rr_non_owner() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    p.run(&[repair(w.house, referrer)]).assert_err(6007);
    p.run(&[repair(key("rando"), referrer)]).assert_err(6007);
}

#[test]
fn rr_owner_not_signer() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    let mut i = repair(w.owner, referrer);
    i.accounts[3].is_signer = false;
    p.run(&[i]).assert_err(3010);
}

#[test]
fn rr_referral_not_writable() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    let mut i = repair(w.owner, referrer);
    i.accounts[2].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn rr_referral_not_writable_noop_path() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_ra(&mut p, &ra(referrer, 0), 0);
    let mut i = repair(w.owner, referrer);
    i.accounts[2].is_writable = false;
    p.run(&[i]).assert_err(2000);
}

#[test]
fn rr_vault_writable_ok() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    let mut i = repair(w.owner, referrer);
    i.accounts[0].is_writable = true;
    p.run(&[i]).assert_ok();
}

#[test]
fn rr_vault_missing() {
    let mut p = Pair::new();
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    p.run(&[repair(key("owner"), referrer)]).assert_err(3012);
}

#[test]
fn rr_vault_wrong_owner() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    let v = p.get(&ids::VAULT).unwrap();
    p.set_account(ids::VAULT, Account { owner: key("other-program"), ..v });
    p.run(&[repair(w.owner, referrer)]).assert_err(3007);
}

#[test]
fn rr_vault_wrong_disc() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    p.patch(ids::VAULT, |d| d[0] ^= 1);
    p.run(&[repair(w.owner, referrer)]).assert_err(3002);
}

#[test]
fn rr_vault_paused_bad_bool() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    p.patch(ids::VAULT, |d| d[137] = 2);
    p.run(&[repair(w.owner, referrer)]).assert_err(3003);
}

#[test]
fn rr_vault_paused_true_still_ok() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    p.patch(ids::VAULT, |d| d[137] = 1);
    p.run(&[repair(w.owner, referrer)]).assert_ok();
}

#[test]
fn rr_vault_short_data() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    p.patch(ids::VAULT, |d| d.truncate(427));
    p.run(&[repair(w.owner, referrer)]).assert_err(3003);
}

#[test]
fn rr_vault_wrong_stored_bump() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    p.patch(ids::VAULT, |d| d[104] = 253);
    p.run(&[repair(w.owner, referrer)]).assert_err(2006);
}

#[test]
fn rr_fake_vault_other_address() {
    // attacker-made program-owned account with Vault bytes naming the attacker as owner
    let mut p = Pair::new();
    let _w = p.init_vault(100, 100, 1_000);
    let attacker = p.user("attacker");
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    let mut v = p.read(&ids::VAULT, accounts::Vault::decode);
    v.owner = attacker;
    let fake = key("fake-vault");
    p.set_program_account(fake, v.encode());
    let mut i = repair(attacker, referrer);
    i.accounts[0].pubkey = fake;
    p.run(&[i]).assert_err(2006);
}

#[test]
fn rr_referral_in_vault_slot() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    let k = put_legacy(&mut p, referrer);
    let mut i = repair(w.owner, referrer);
    i.accounts[0].pubkey = k;
    p.run(&[i]).assert_err(3002);
}

#[test]
fn rr_vault_in_referral_slot() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    let mut i = repair(w.owner, referrer);
    i.accounts[2] = AccountMeta::new(ids::VAULT, false);
    p.run(&[i]).assert_err(3002);
}

#[test]
fn rr_referral_wrong_pda() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let (referrer, other) = (key("referrer"), key("other"));
    put_legacy(&mut p, other);
    let mut i = repair(w.owner, referrer);
    i.accounts[2].pubkey = pda::referral(&other);
    p.run(&[i]).assert_err(2006);
}

#[test]
fn rr_referral_wrong_stored_bump() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    let mut r = legacy(referrer);
    r.bump = r.bump.wrapping_sub(1);
    put(&mut p, pda::referral(&referrer), PROGRAM_ID, r.encode(), rent_min(RA_SPACE));
    p.run(&[repair(w.owner, referrer)]).assert_err(2006);
}

#[test]
fn rr_referral_noncanonical_bump_accepted() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    let (nc, b) = noncanonical(&[b"kaboom_referral", referrer.as_ref()]);
    let mut r = legacy(referrer);
    r.bump = b;
    p.set_program_account(nc, r.encode());
    let mut i = repair(w.owner, referrer);
    i.accounts[2].pubkey = nc;
    p.run(&[i]).assert_ok();
}

#[test]
fn rr_referral_missing() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    p.run(&[repair(w.owner, key("referrer"))]).assert_err(3012);
}

#[test]
fn rr_referral_wrong_owner() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    p.set_data(pda::referral(&referrer), key("other-program"), legacy(referrer).encode());
    p.run(&[repair(w.owner, referrer)]).assert_err(3007);
}

#[test]
fn rr_referral_wrong_disc() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    let mut b = legacy(referrer).encode();
    b[7] ^= 0x80;
    p.set_program_account(pda::referral(&referrer), b);
    p.run(&[repair(w.owner, referrer)]).assert_err(3002);
}

#[test]
fn rr_referral_short_data() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    let mut b = legacy(referrer).encode();
    b.truncate(60);
    p.set_program_account(pda::referral(&referrer), b);
    p.run(&[repair(w.owner, referrer)]).assert_err(3003);
}

#[test]
fn rr_referral_long_data_ok() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    let mut b = legacy(referrer).encode();
    b.resize(140, 0xEE);
    p.set_program_account(pda::referral(&referrer), b);
    p.run(&[repair(w.owner, referrer)]).assert_ok();
}

#[test]
fn rr_owner_is_referrer() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    put_legacy(&mut p, w.owner);
    p.run(&[repair(w.owner, w.owner)]).assert_ok();
}

#[test]
fn rr_short_account_list() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    for n in 0..4 {
        let mut i = repair(w.owner, referrer);
        i.accounts.truncate(n);
        p.run(&[i]).assert_failed();
    }
}

#[test]
fn rr_extra_data_and_accounts_ignored() {
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let referrer = key("referrer");
    put_legacy(&mut p, referrer);
    let mut i = repair(w.owner, referrer);
    i.data.extend_from_slice(&[0xFF; 9]);
    i.accounts.push(AccountMeta::new(key("junk"), true));
    p.run(&[i]).assert_ok();
}

#[test]
fn rr_ownership_handover() {
    // propose -> accept: old owner loses repair rights, new owner gains them
    let mut p = Pair::new();
    let w = p.init_vault(100, 100, 1_000);
    let new_owner = p.user("new-owner");
    let (r1, r2) = (key("r1"), key("r2"));
    put_legacy(&mut p, r1);
    put_legacy(&mut p, r2);
    p.ok(&[ix::ProposeOwner { owner: w.owner, ..Default::default() }.ix(new_owner)]);
    // pending only: the old owner still rules
    p.run(&[repair(new_owner, r1)]).assert_err(6007);
    p.ok(&[repair(w.owner, r1)]);
    p.ok(&[ix::AcceptOwnership { new_owner, ..Default::default() }.ix()]);
    p.run(&[repair(w.owner, r2)]).assert_err(6007);
    p.ok(&[repair(new_owner, r2)]);
}

// =====================================================================================
// multi-step: accrual through settle_game, then claim
// =====================================================================================

fn settle_with_referral(p: &mut Pair, w: &World, player: Address, referral: Option<Address>, layout: u16, salt: [u8; 32]) -> Diff {
    let game = pda::game(&player);
    let mut i = ix::SettleGame { game, player_stats: pda::stats(&player), house_authority: w.house, treasury: w.treasury, ..Default::default() }
        .ix(layout, salt);
    if let Some(r) = referral { i.accounts.push(AccountMeta::new(r, false)); }
    p.run(&[i])
}

#[test]
fn flow_win_accrue_claim() {
    let mut p = Pair::new();
    let w = p.house_world();
    let (player, referrer) = (p.user("player"), p.user("referrer"));
    p.ok(&[sr(player, referrer)]);
    let (layout, salt) = (0b100u16, [7u8; 32]);
    let game = p.start_game(player, 1, 100_000_000, layout, salt);
    p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(5, false)]);
    p.ok(&[ix::CashOut { game, player, ..Default::default() }.ix()]);
    let d = settle_with_referral(&mut p, &w, player, Some(pda::referral(&referrer)), layout, salt);
    d.assert_ok();
    cu("settle_game (win, with referral)", &d);
    let r = read_ra(&p, &referrer);
    assert_eq!(r.accrued_lamports, 100_000_000 * 50 / 10_000);
    let before = p.lamports(&referrer);
    let d = p.run(&[claim(referrer)]);
    d.assert_ok();
    cu("claim_referral (after settle)", &d);
    assert_eq!(p.lamports(&referrer), before + r.accrued_lamports);
    assert_eq!(read_ra(&p, &referrer).accrued_lamports, 0);
    p.run(&[claim(referrer)]).assert_err(6023);
}

#[test]
fn flow_loss_accrue_claim() {
    let mut p = Pair::new();
    let w = p.house_world();
    let (player, referrer) = (p.user("player"), p.user("referrer"));
    p.ok(&[sr(player, referrer)]);
    let (layout, salt) = (0b100u16, [9u8; 32]);
    let game = p.start_game(player, 1, 50_000_000, layout, salt);
    p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(2, true)]);
    let d = settle_with_referral(&mut p, &w, player, Some(pda::referral(&referrer)), layout, salt);
    d.assert_ok();
    cu("settle_game (loss, with referral)", &d);
    assert!(read_ra(&p, &referrer).accrued_lamports > 0);
    p.ok(&[claim(referrer)]);
}

#[test]
fn flow_settle_without_referral_account() {
    let mut p = Pair::new();
    let w = p.house_world();
    let (player, referrer) = (p.user("player"), p.user("referrer"));
    p.ok(&[sr(player, referrer)]);
    let (layout, salt) = (0b100u16, [1u8; 32]);
    let game = p.start_game(player, 1, 10_000_000, layout, salt);
    p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(2, true)]);
    settle_with_referral(&mut p, &w, player, None, layout, salt).assert_ok();
    assert_eq!(read_ra(&p, &referrer).accrued_lamports, 0);
    p.run(&[claim(referrer)]).assert_err(6023);
}

#[test]
fn flow_settle_wrong_referral_account() {
    let mut p = Pair::new();
    let w = p.house_world();
    let (player, referrer, other) = (p.user("player"), p.user("referrer"), p.user("other"));
    p.ok(&[sr(player, referrer)]);
    let p2 = p.user("p2");
    p.ok(&[sr(p2, other)]);
    let (layout, salt) = (0b100u16, [1u8; 32]);
    let game = p.start_game(player, 1, 10_000_000, layout, salt);
    p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(2, true)]);
    settle_with_referral(&mut p, &w, player, Some(pda::referral(&other)), layout, salt).assert_failed();
}

#[test]
fn flow_tier_change_on_settle() {
    let mut p = Pair::new();
    let w = p.house_world();
    let (player, referrer) = (p.user("player"), p.user("referrer"));
    p.ok(&[sr(player, referrer)]);
    // push volume to just below silver so this game crosses it (ReferralTierChanged)
    p.patch(pda::referral(&referrer), |d| d[63..71].copy_from_slice(&(10_000_000_000u64 - 1).to_le_bytes()));
    let (layout, salt) = (0b100u16, [3u8; 32]);
    let game = p.start_game(player, 1, 10_000_000, layout, salt);
    p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(2, true)]);
    let d = settle_with_referral(&mut p, &w, player, Some(pda::referral(&referrer)), layout, salt);
    d.assert_ok();
    assert!(d.anchor.events.iter().any(|e| event_name(e) == "ReferralTierChanged"));
    assert_eq!(read_ra(&p, &referrer).tier, 1);
    p.ok(&[claim(referrer)]);
}

#[test]
fn flow_many_players_accrue_partial_claim_then_rest() {
    let mut p = Pair::new();
    let w = p.house_world();
    let referrer = p.user("referrer");
    for (n, label) in ["p1", "p2", "p3"].iter().enumerate() {
        let player = p.user(label);
        p.ok(&[sr(player, referrer)]);
        let (layout, salt) = (0b100u16, [n as u8; 32]);
        let game = p.start_game(player, 1, 20_000_000, layout, salt);
        p.ok(&[ix::RevealTile { game, house_authority: w.house, ..Default::default() }.ix(2, true)]);
        settle_with_referral(&mut p, &w, player, Some(pda::referral(&referrer)), layout, salt).assert_ok();
    }
    let r = read_ra(&p, &referrer);
    assert_eq!((r.referred_count, r.accrued_lamports), (3, 3 * 20_000_000 * 50 / 10_000));
    // drain part of the surplus out-of-band: the claim is capped, the rest stays accrued
    let k = pda::referral(&referrer);
    let mut a = p.get(&k).unwrap();
    a.lamports -= 100_000;
    p.set_account(k, a);
    p.ok(&[claim(referrer)]);
    assert_eq!(read_ra(&p, &referrer).accrued_lamports, 100_000);
    let mut a = p.get(&k).unwrap();
    a.lamports += 100_000;
    p.set_account(k, a);
    p.ok(&[claim(referrer)]);
    assert_eq!(read_ra(&p, &referrer).accrued_lamports, 0);
}
