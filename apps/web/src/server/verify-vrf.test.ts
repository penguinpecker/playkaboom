/**
 * Public VRF verifier (A10): only a successful tx made of one top-level Kaboom
 * settle_vrf (plus compute-budget ixs) counts, and the player/game/claim come
 * from that instruction's accounts. Log text and extra ixs are not evidence.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { NextRequest } from "next/server";
import {
  buildSettleVrf,
  deriveVaultPda,
  deriveVrfClaimPda,
  deriveVrfGamePda,
  ixDiscriminator,
} from "@playkaboom/sdk";
import { GET as verifyQuery } from "@/app/api/verify/route";
import { getConnection } from "./connection";
import { programId } from "./env";
import { settleVrfAccounts, verifyVrfSettle } from "./verify-vrf";

const pid = programId();
const payer = Keypair.generate().publicKey;
const player = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TyNoE9SUcvEYZjFLx3t8bx");

const settleIx = () => buildSettleVrf({ ctx: { programId: pid }, player, payer, treasury });
const computeIxs = () => [
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
];

function txOf(ixs: TransactionInstruction[], err: unknown = null) {
  const t = new Transaction();
  t.add(...ixs);
  t.feePayer = payer;
  t.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return {
    slot: 1,
    meta: { err, preBalances: [] as number[], postBalances: [] as number[] },
    transaction: { signatures: [] as string[], message: t.compileMessage() },
  };
}

test("house-shaped settle (compute budget + settle_vrf) yields the ix's accounts", () => {
  const got = settleVrfAccounts(txOf([...computeIxs(), settleIx()]), pid);
  assert.ok(got);
  assert.ok(got.player.equals(player));
  assert.ok(got.treasury?.equals(treasury));
  assert.equal(got.refund, false);
  assert.ok(got.claim.equals(deriveVrfClaimPda(pid, player)[0]));
  assert.ok(got.game.equals(deriveVrfGamePda(pid, player)[0]));
});

test("rejects failed txs, spoofed logs, extra ixs, wrong program or discriminator", () => {
  const memo = new TransactionInstruction({
    programId: MEMO,
    keys: [],
    data: Buffer.from("Program log: Instruction: SettleVrf"),
  });
  const tune = SystemProgram.transfer({ fromPubkey: payer, toPubkey: treasury, lamports: 1 });
  const wrongProgram = new TransactionInstruction({ ...settleIx(), programId: MEMO });
  const wrongDisc = new TransactionInstruction({ ...settleIx(), data: ixDiscriminator("cash_out_vrf") });
  const cases: [string, ReturnType<typeof txOf>][] = [
    ["meta.err set", txOf([settleIx()], { InstructionError: [0, "Custom"] })],
    ["memo prints the log line", txOf([memo])],
    ["settle + balance-tuning transfer", txOf([settleIx(), tune])],
    ["settle + memo", txOf([...computeIxs(), settleIx(), memo])],
    ["two settles", txOf([settleIx(), settleIx()])],
    ["settle discriminator, other program", txOf([wrongProgram])],
    ["Kaboom program, other discriminator", txOf([wrongDisc])],
  ];
  for (const [name, tx] of cases) assert.equal(settleVrfAccounts(tx, pid), null, name);
});

test("verifyVrfSettle refuses a log-only forgery before any RPC read", async () => {
  const memo = new TransactionInstruction({
    programId: MEMO,
    keys: [],
    data: Buffer.from("Instruction: SettleVrf"),
  });
  assert.equal(await verifyVrfSettle(txOf([memo])), null);
});

// ── real mainnet rounds (QA run 2026-11-05, scratchpad qa-games/games.jsonl) ──
//
// __fixtures__/verify-vrf-mainnet.json holds every JSON-RPC answer the verifier
// needed for these closes, recorded from mainnet: { "[method, params]": result }.
// Replayed through web3's own request hook, so no test here touches the network.
const RPC: Record<string, unknown> = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "verify-vrf-mainnet.json"), "utf8"),
);
function replay<C extends Connection>(conn: C): C {
  (conn as unknown as { _rpcRequest: unknown })._rpcRequest = async (method: string, args: unknown[]) => {
    const key = JSON.stringify([method, args]);
    if (!(key in RPC)) throw new Error(`no recorded RPC answer for ${key}`);
    return { jsonrpc: "2.0", id: "fixture", result: RPC[key] };
  };
  return conn;
}
const fixtureConn = replay(new Connection("http://fixtures.invalid", "confirmed"));
const settleTx = async (sig: string) =>
  (await fixtureConn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!;

// Truth per round = the claim and the state MagicBlock committed (games.jsonl).
const ROUNDS = [
  { name: "plain-001", sig: "Ut9TxEZoP2hQ52HTtQtDGe2muGZzYAKs7S5oYtRyRd65Wf3L5KmGHDxnqcW92v58PDrydUMBdgDGZBszSVxiG8z", outcome: "lost", mines: 1, reveals: 5, payout: "0" },
  { name: "referred-003", sig: "4Bw2z5kgfqwmVSCzHKNEmxh6spi86nC7JXGR7dGved6Kvq9wYgKM13RcyDxEdZAB1GsS9yghfw8Yv7u8uf3s1x7C", outcome: "lost", mines: 2, reveals: 2, payout: "0" },
  { name: "referred-004", sig: "dmDf7XoVE3B284AE7nUJPkxsBTXfoWxmawFGyyiimxKgAcbLmk8mWkfQKD9s8anLv3VkeCFik3WhuQYrL2DRcD8", outcome: "lost", mines: 2, reveals: 4, payout: "0" },
  { name: "referred-001", sig: "2b3KnDniFSwwYGcH6B42gH9TfhFuXb9pWy5PSn2qGvcC56zLGdnejevTuDYXFqrU4vShDveGSsYdELAEHgbpmuue", outcome: "won", mines: 1, reveals: 2, payout: "1119900" },
  { name: "referred-005", sig: "4aeFpHkFpvTTiQfQadcASK7DbxQReZ8rk8TWRBDpKurLEZMRPL6FSCBvkWGKtY18GPbZXsj4wgAuxXUT2FFST8jg", outcome: "won", mines: 1, reveals: 2, payout: "1119900" },
  // VOID round the house cron refunded (refund_stalled_vrf): the bet comes back.
  { name: "referred-002", sig: "5BTwo7DHjXCC1yW8PGHZgbgUxjJ5DdxTDzb6JNEcQKLqRHBx6sHLzp4xkKuazTAxNtboe63YdZYkyuf6xddmJDJJ", outcome: "expired", mines: 1, reveals: 0, payout: "1000000" },
];

test("real rounds: bet, mines and reveals come from the start tx and MagicBlock's commit, losses included", async () => {
  for (const r of ROUNDS) {
    const v = await verifyVrfSettle(await settleTx(r.sig), fixtureConn);
    assert.ok(v, r.name);
    assert.equal(v.verified, true, r.name);
    assert.equal(v.outcome, r.outcome, r.name);
    assert.equal(v.betLamports, "1000000", r.name);
    assert.equal(v.mineCount, r.mines, r.name);
    assert.equal(v.safeReveals, r.reveals, r.name);
    assert.equal(v.payoutLamports, r.payout, r.name);
  }
});

test("a capped treasury cut does not move the bet (it is read, never back-solved from the cut)", async () => {
  const tx = await settleTx(ROUNDS[0]!.sig);
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const t = keys.findIndex((k) => k.equals(settleVrfAccounts(tx, programId())!.treasury!));
  const vault = keys.findIndex((k) => k.equals(deriveVaultPda(programId())[0]));
  const post = [...tx.meta!.postBalances];
  post[t]! -= 3_000; // vault short: the program pays the treasury less...
  post[vault]! += 3_000; // ...and the vault keeps it
  const v = await verifyVrfSettle({ ...tx, meta: { ...tx.meta!, postBalances: post } }, fixtureConn);
  assert.equal(v?.verified, true);
  assert.equal(v?.treasuryCutLamports, "7000");
  assert.equal(v?.betLamports, "1000000");
});

test("/api/verify answers a lost round with its real counts; the page copy and refund 400 are unchanged", async () => {
  process.env.SOLANA_RPC ??= "http://fixtures.invalid";
  replay(getConnection());
  const get = async (sig: string) => {
    const res = await verifyQuery(new NextRequest(`http://localhost/api/verify?sig=${sig}`));
    return { status: res.status, body: await res.json() };
  };
  const lost = await get(ROUNDS[0]!.sig);
  assert.equal(lost.status, 200);
  assert.equal(lost.body.game.outcome, "lost");
  assert.equal(lost.body.game.mine_count, 1);
  assert.equal(lost.body.game.safe_reveals, 5);
  // Owner rule (11-05): no copy changes, so the printed first line is the published one.
  assert.match(lost.body.game.howThisIsVerified[0], /^bet = treasury_cut x 1e8 \/ \(house_edge_bps \d+ x treasury_split_bps \d+\)$/);
  // A refund still renders as before (400) until the owner approves its page.
  const refund = await get(ROUNDS[5]!.sig);
  assert.equal(refund.status, 400);
});

test("an unreadable commit tx leaves reveals unknown, never a wrong replay or a thrown verify", async () => {
  const conn = replay(new Connection("http://fixtures.invalid", "confirmed"));
  const recorded = (conn as unknown as { _rpcRequest: (m: string, a: unknown[]) => Promise<unknown> })._rpcRequest;
  (conn as unknown as { _rpcRequest: unknown })._rpcRequest = async (method: string, args: unknown[]) =>
    method === "getTransaction" && String(args[0]).startsWith("2FS2Vv6p") // plain-001's MagicBlock commit
      ? { jsonrpc: "2.0", id: "fixture", error: { code: -32015, message: "Transaction version (1) is not supported" } }
      : recorded(method, args);
  const v = await verifyVrfSettle(await settleTx(ROUNDS[0]!.sig), conn);
  assert.equal(v?.verified, true);
  assert.equal(v?.outcome, "lost");
  assert.equal(v?.mineCount, 1);
  assert.equal(v?.safeReveals, null);
});
