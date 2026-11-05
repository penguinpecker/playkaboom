/**
 * Session-gas sweep: the key is forgotten ONLY once its gas is back with the
 * player (g18, 2026-11-05: a failed sweep's key was discarded, 0.002 SOL lost).
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemInstruction, Transaction, type Connection } from "@solana/web3.js";
import {
  addPendingSweep,
  parkReplacedSession,
  pendingSweepKey,
  readPendingSweeps,
  sweepPendingSessions,
  sweepSession,
  type KeyStore,
} from "./client";

// g18's exact preflight error: simulation failed before the program ran.
const G18 =
  "Simulation failed. \nMessage: Transaction simulation failed. \nLogs: \n[]. \n" +
  "Catch the `SendTransactionError` and call `getLogs()` on it for full details.";

/** Fake L1: holds one balance, applies a transfer + its fee like the runtime. */
function fakeL1(balance: number, { fee = 5_000, failSends = 0 } = {}) {
  const sent: { lamports: number; blockhash: string }[] = [];
  const conn = {
    getBalance: async () => balance,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: fee }),
    sendRawTransaction: async (raw: Buffer) => {
      const tx = Transaction.from(raw);
      const lamports = Number(SystemInstruction.decodeTransfer(tx.instructions[0]!).lamports);
      sent.push({ lamports, blockhash: tx.recentBlockhash! });
      if (failSends-- > 0) throw new Error(G18);
      if (lamports + fee > balance) throw new Error("insufficient funds");
      balance -= lamports + fee;
      return `sig${sent.length}`;
    },
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
  };
  const cfg = { l1: conn as unknown as Connection, er: conn as unknown as Connection, programId: PublicKey.default };
  return { cfg, sent, balance: () => balance };
}

const player = Keypair.generate().publicKey;

test("g18: an empty-logs preflight failure is retried on a fresh blockhash; key reported empty only after", async () => {
  const l1 = fakeL1(2_000_000, { failSends: 1 });
  assert.equal(await sweepSession(l1.cfg, Keypair.generate(), player), true);
  assert.equal(l1.sent.length, 2);
  assert.notEqual(l1.sent[0]!.blockhash, l1.sent[1]!.blockhash);
  assert.equal(l1.balance(), 0);
});

test("fee is the cluster's, so the session drains to exactly 0", async () => {
  const l1 = fakeL1(2_000_000, { fee: 10_000 });
  assert.equal(await sweepSession(l1.cfg, Keypair.generate(), player), true);
  assert.equal(l1.sent[0]!.lamports, 1_990_000);
  assert.equal(l1.balance(), 0);
});

test("a sweep that keeps failing reports false (caller must KEEP the key)", async () => {
  const l1 = fakeL1(2_000_000, { failSends: 99 });
  assert.equal(await sweepSession(l1.cfg, Keypair.generate(), player, 2), false);
  assert.equal(l1.balance(), 2_000_000);
});

test("an empty or fee-sized key is reported empty without sending", async () => {
  for (const b of [0, 5_000]) {
    const l1 = fakeL1(b);
    assert.equal(await sweepSession(l1.cfg, Keypair.generate(), player), true);
    assert.equal(l1.sent.length, 0);
  }
});

function memStore() {
  const m = new Map<string, string>();
  const store: KeyStore = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
  return { m, store };
}
const ids = (kps: Keypair[]) => kps.map((k) => k.publicKey.toBase58());

test("failed sweep keeps the key; the next mount's retry sweeps and forgets it", async () => {
  const { m, store } = memStore();
  const key = pendingSweepKey("W");
  const a = Keypair.generate();
  const b = Keypair.generate();
  addPendingSweep(store, key, a);
  addPendingSweep(store, key, b);
  addPendingSweep(store, key, a); // idempotent
  // This visit: a's sweep fails, b's lands.
  await sweepPendingSessions(store, key, async (kp) => kp.publicKey.equals(b.publicKey));
  assert.deepEqual(ids(readPendingSweeps(store, key)), ids([a]));
  // A throwing sweep keeps it too.
  await sweepPendingSessions(store, key, async () => {
    throw new Error("rpc down");
  });
  assert.deepEqual(ids(readPendingSweeps(store, key)), ids([a]));
  // Next mount: it lands, the key is forgotten, the slot is gone.
  await sweepPendingSessions(store, key, async () => true);
  assert.equal(m.has(key), false);
});

test("concurrent callers sweep a key once; a key retired mid-sweep survives", async () => {
  const { store } = memStore();
  const key = pendingSweepKey("W");
  const a = Keypair.generate();
  const c = Keypair.generate();
  addPendingSweep(store, key, a);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const sweep = async () => {
    calls++;
    await gate;
    return true;
  };
  const runs = [sweepPendingSessions(store, key, sweep), sweepPendingSessions(store, key, sweep)];
  addPendingSweep(store, key, c);
  release();
  await Promise.all(runs);
  assert.equal(calls, 1);
  assert.deepEqual(ids(readPendingSweeps(store, key)), ids([c]));
});

test("with storage unavailable the retired key is still swept in-tab", async () => {
  const k = Keypair.generate();
  const swept: string[] = [];
  await sweepPendingSessions(null, pendingSweepKey("W"), async (kp) => (swept.push(kp.publicKey.toBase58()), true), [k]);
  assert.deepEqual(swept, ids([k]));
});

test("a new round's key never overwrites a different key without parking it (start with a failed open-round read)", () => {
  const { store } = memStore();
  const live = "kaboom:vrf-session:W";
  const key = pendingSweepKey("W");
  const old = Keypair.generate();
  const next = Keypair.generate();
  parkReplacedSession(store, live, key, next); // empty slot: nothing to park
  assert.deepEqual(readPendingSweeps(store, key), []);
  store.setItem(live, JSON.stringify(Array.from(old.secretKey)));
  parkReplacedSession(store, live, key, old); // same key re-persisted: the live key is never parked
  assert.deepEqual(readPendingSweeps(store, key), []);
  parkReplacedSession(store, live, key, next);
  assert.deepEqual(ids(readPendingSweeps(store, key)), ids([old]));
});
