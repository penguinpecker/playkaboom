/**
 * Public VRF verifier (A10): only a successful tx made of one top-level Kaboom
 * settle_vrf (plus compute-budget ixs) counts, and the player/game/claim come
 * from that instruction's accounts. Log text and extra ixs are not evidence.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { buildSettleVrf, deriveVrfClaimPda, deriveVrfGamePda, ixDiscriminator } from "@playkaboom/sdk";
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
    transaction: { message: t.compileMessage() },
  };
}

test("house-shaped settle (compute budget + settle_vrf) yields the ix's accounts", () => {
  const got = settleVrfAccounts(txOf([...computeIxs(), settleIx()]), pid);
  assert.ok(got);
  assert.ok(got.player.equals(player));
  assert.ok(got.treasury.equals(treasury));
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
