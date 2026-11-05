/**
 * VRF cron gates (audit A1): the idle signal (newest tx listing the game) is
 * spoofable, so every status has an absolute claim-age cap, and failed txs
 * never count as activity.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type Connection } from "@solana/web3.js";
import type { VrfClaimAccount, VrfGameAccount } from "@playkaboom/sdk";
import { settleDue, shouldForce } from "./vrf-passes";
import { FALLBACK_MS_PER_SLOT, msPerSlot } from "../connection";

type Sig = { err: unknown; blockTime: number | null };
const now = () => Math.floor(Date.now() / 1000);
const FRESH: Sig = { err: null, blockTime: now() }; // a successful tx right now
const OLD: Sig = { err: null, blockTime: now() - 3600 };
const FRESH_FAIL: Sig = { err: { InstructionError: [0, "Custom"] }, blockTime: now() };

const conn = (sigs: Sig[] | "rpc-error") =>
  ({
    getSignaturesForAddress: async () => {
      if (sigs === "rpc-error") throw new Error("rpc down");
      return sigs;
    },
  }) as unknown as Connection;

const game = Keypair.generate().publicKey;
const MS = 400; // slot time for the original cases: the 30 min cap is then 4,500 slots
const CAP = 4_500;
const SLOT = 1_000_000;
const delegated = (age: number) => ({
  player: game,
  game,
  claim: { startSlot: BigInt(SLOT - age) } as VrfClaimAccount,
});
const g = (status: VrfGameAccount["status"], pending = false) => ({ status, pending }) as VrfGameAccount;
const force = (sigs: Sig[] | "rpc-error", status: VrfGameAccount["status"], age: number, pending = false, ms = MS) =>
  shouldForce(conn(sigs), delegated(age), g(status, pending), SLOT, ms);
const due = (sigs: Sig[] | "rpc-error", age: number, ms = MS) => settleDue(conn(sigs), game, age, ms);

test("pass a: WON/LOST settles once the claim hits the cap, even while the game looks busy", async () => {
  assert.equal(await due([FRESH], CAP), true);
  assert.equal(await due("rpc-error", CAP), true);
  // Under the cap the player's 60 s grace still holds.
  assert.equal(await due([FRESH], CAP - 1), false);
  assert.equal(await due([OLD], CAP - 1), true);
  assert.equal(await due("rpc-error", CAP - 1), false);
});

test("pass a: a failed tx is not activity", async () => {
  assert.equal(await due([FRESH_FAIL, OLD], 10), true);
  // Every scanned tx failed: the last good one is older than the oldest scanned.
  assert.equal(await due([FRESH_FAIL, FRESH_FAIL], 10), false);
});

test("pass b: terminal ER games are forced at the cap whatever the idle signal says", async () => {
  for (const s of ["Won", "Lost", "Void"] as const) {
    assert.equal(await force([FRESH], s, CAP), true, s);
    assert.equal(await force("rpc-error", s, CAP), true, s);
    assert.equal(await force([FRESH], s, CAP - 1), false, s);
    assert.equal(await force([OLD], s, CAP - 1), true, s);
    assert.equal(await force("rpc-error", s, CAP - 1), false, s);
  }
  assert.equal(await force([FRESH_FAIL, OLD], "Won", 10), true);
});

test("pass b: PLAYING keeps its rules (pending never forced, cap, 300 s idle)", async () => {
  assert.equal(await force([OLD], "Playing", CAP, true), false);
  assert.equal(await force([FRESH], "Playing", CAP), true);
  assert.equal(await force([FRESH], "Playing", CAP - 1), false);
  assert.equal(await force([OLD], "Playing", CAP - 1), true);
  // No ER tx yet: idle since the start (300 s = 750 slots).
  assert.equal(await force([], "Playing", 749), false);
  assert.equal(await force([], "Playing", 750), true);
});

test("windows keep their wall-clock length at the measured slot time (214 ms, not 400)", async () => {
  // 30 min cap = 8,412 slots at 214 ms; at 400 ms it fired at 4,500 slots (~16 min real).
  assert.equal(await due([FRESH], 4_500, 214), false);
  assert.equal(await due([FRESH], 8_411, 214), false);
  assert.equal(await due([FRESH], 8_412, 214), true);
  assert.equal(await force([FRESH], "Won", 8_411, false, 214), false);
  assert.equal(await force([FRESH], "Won", 8_412, false, 214), true);
  // Never-touched PLAYING game: 300 s idle = 1,402 slots, not 750 (~161 s real).
  assert.equal(await force([], "Playing", 750, false, 214), false);
  assert.equal(await force([], "Playing", 1_401, false, 214), false);
  assert.equal(await force([], "Playing", 1_402, false, 214), true);
});

test("msPerSlot measures from performance samples, caches, and falls back low", async () => {
  const down = { getRecentPerformanceSamples: async () => { throw new Error("rpc down"); } };
  assert.equal(await msPerSlot(down), FALLBACK_MS_PER_SLOT); // nothing measured yet
  const samples = [
    { numSlots: 280, samplePeriodSecs: 60, numTransactions: 0, slot: 1 },
    { numSlots: 281, samplePeriodSecs: 60, numTransactions: 0, slot: 2 },
  ];
  const up = { getRecentPerformanceSamples: async () => samples };
  assert.equal(await msPerSlot(up), 120_000 / 561); // ~213.9 ms
  assert.equal(await msPerSlot(down), 120_000 / 561); // RPC failure keeps the measurement
});
