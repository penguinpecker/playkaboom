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
const CAP = 4_500;
const SLOT = 1_000_000;
const delegated = (age: number) => ({
  player: game,
  game,
  claim: { startSlot: BigInt(SLOT - age) } as VrfClaimAccount,
});
const g = (status: VrfGameAccount["status"], pending = false) => ({ status, pending }) as VrfGameAccount;
const force = (sigs: Sig[] | "rpc-error", status: VrfGameAccount["status"], age: number, pending = false) =>
  shouldForce(conn(sigs), delegated(age), g(status, pending), SLOT);

test("pass a: WON/LOST settles once the claim hits the cap, even while the game looks busy", async () => {
  assert.equal(await settleDue(conn([FRESH]), game, CAP), true);
  assert.equal(await settleDue(conn("rpc-error"), game, CAP), true);
  // Under the cap the player's 60 s grace still holds.
  assert.equal(await settleDue(conn([FRESH]), game, CAP - 1), false);
  assert.equal(await settleDue(conn([OLD]), game, CAP - 1), true);
  assert.equal(await settleDue(conn("rpc-error"), game, CAP - 1), false);
});

test("pass a: a failed tx is not activity", async () => {
  assert.equal(await settleDue(conn([FRESH_FAIL, OLD]), game, 10), true);
  // Every scanned tx failed: the last good one is older than the oldest scanned.
  assert.equal(await settleDue(conn([FRESH_FAIL, FRESH_FAIL]), game, 10), false);
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
