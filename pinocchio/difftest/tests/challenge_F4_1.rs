//! Challenge F4-1: the batched keeper pass of FIXES.md 9.3.f ("up to 8 unsigned complete_withdraw per tx")
//! can be poisoned. An LP whose wallet holds 0 lamports and whose pending payout is below the rent-exempt
//! minimum makes its own complete_withdraw fail the runtime rent-state check (0 lamports -> rent-paying), and
//! with it every other completion in the same tx. Positions stay batch-eligible for the whole 9,000-slot
//! window, so one poison position keeps the keeper from completing its batch-mates for the hour, and they
//! lapse (6056). The same trick lets an attacker keep its own large matured request away from the keeper
//! (the 0.03% "keeper up" bound degrades to the 1.37% on-chain bound). On-chain code is sound; this is a
//! keeper-spec issue. Port-only assertions (Anchor rejects unsigned completes with 3010 anyway).
//! FIXED in the keeper spec (FIXES.md 9.3.f): one unsigned completion per tx (or simulate and drop failures);
//! `challenge_f4_control_honest_alone_completes` is that rule. No program change.
use accounts::LpPosition;
use difftest::*;

const SOL: u64 = LAMPORTS_PER_SOL;
const W: u64 = 9_000;

fn dep(user: Address, amount: u64) -> Instruction {
    ix::LpDeposit { position: pda::lp(&user), user, ..Default::default() }.ix(amount)
}
fn req(user: Address, units: u128) -> Instruction {
    ix::RequestWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix(units)
}
fn unsigned_complete(user: Address) -> Instruction {
    let mut i = ix::CompleteWithdraw { position: pda::lp(&user), user, ..Default::default() }.ix();
    i.accounts[3].is_signer = false;
    i
}
fn sys_transfer(from: Address, to: Address, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction { program_id: ids::SYSTEM, accounts: vec![AccountMeta::new(from, true), AccountMeta::new(to, false)], data }
}
fn pos(p: &Pair, u: &Address) -> LpPosition { p.read(&pda::lp(u), LpPosition::decode) }
fn port_pos(p: &Pair, u: &Address) -> LpPosition {
    LpPosition::decode(&p.port.get_account(&pda::lp(u)).unwrap().data).unwrap()
}
fn port_lamports(p: &Pair, k: &Address) -> u64 { p.port.get_account(k).map(|a| a.lamports).unwrap_or(0) }

#[test]
fn challenge_f4_poison_position_blocks_batched_keeper_and_lapses_honest_lp() {
    let mut p = Pair::new();
    let _w = p.house_world();
    let honest = p.user("honest-lp");
    let poison = p.user("poison-lp");
    let keeper = p.user("keeper");
    let sink = key("sink");

    p.ok(&[dep(honest, SOL)]);
    let half = pos(&p, &honest).units / 2;
    p.ok(&[req(honest, half)]);
    // Attacker: min deposit, request 1 unit (payout ~1 lamport), then empty the wallet to 0 lamports.
    p.ok(&[dep(poison, SOL)]);
    p.ok(&[req(poison, 1)]);
    let bal = p.lamports(&poison);
    p.ok(&[sys_transfer(poison, sink, bal)]);
    assert_eq!(p.lamports(&poison), 0);
    let unlock = pos(&p, &honest).pending_unlock_slot;
    assert_eq!(pos(&p, &poison).pending_unlock_slot, unlock);

    // Keeper ticks every ~150 slots across the whole window, batching both eligible positions.
    let mut s = unlock;
    while s <= unlock + W {
        p.warp(s);
        let d = p.run_as(keeper, &[unsigned_complete(honest), unsigned_complete(poison)]);
        assert!(!d.port.ok(), "batch at slot {s} unexpectedly succeeded: {}", d.report());
        s += 150;
    }
    println!("port batch error: {:?}", p.run_as(keeper, &[unsigned_complete(honest), unsigned_complete(poison)]).port);
    assert_eq!(port_pos(&p, &honest).pending_units, half, "honest LP never completed by the keeper");

    // The poison alone also fails; the honest LP alone would have succeeded (shown on a clone of the state below).
    let d = p.run_as(keeper, &[unsigned_complete(poison)]);
    assert!(!d.port.ok());

    // Window over: the honest LP lapsed (6056) and must cancel + re-request (another full cooldown).
    p.warp(unlock + W + 1);
    let d = p.run_as(keeper, &[unsigned_complete(honest)]);
    assert_eq!(d.port.code(), Some(6056));
    assert_eq!(port_pos(&p, &honest).pending_units, half);
    let _ = port_lamports(&p, &honest);
}

#[test]
fn challenge_f4_control_honest_alone_completes() {
    let mut p = Pair::new();
    let _w = p.house_world();
    let honest = p.user("honest-lp");
    let keeper = p.user("keeper");
    p.ok(&[dep(honest, SOL)]);
    let half = pos(&p, &honest).units / 2;
    p.ok(&[req(honest, half)]);
    let unlock = pos(&p, &honest).pending_unlock_slot;
    p.warp(unlock);
    assert!(p.run_as(keeper, &[unsigned_complete(honest)]).port.ok());
    assert_eq!(port_pos(&p, &honest).pending_units, 0);
}
