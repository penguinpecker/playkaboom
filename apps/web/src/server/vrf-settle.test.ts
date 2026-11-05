/**
 * The VRF settle mirror reads the referral cut from the settle tx's own
 * balance changes (settle_vrf emits no ReferralAccrued event).
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, Transaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { lamportDelta } from "./vrf-settle";

const payer = Keypair.generate().publicKey;
const referral = Keypair.generate().publicKey;
const loaded = Keypair.generate().publicKey;

// A real legacy message, as getTransaction returns for the house's legacy txs.
const message = new Transaction({ feePayer: payer, recentBlockhash: payer.toBase58() })
  .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: referral, lamports: 1 }))
  .compileMessage();
const keys = message.staticAccountKeys;
const tx = (pre: number[], post: number[], loadedWritable = [] as typeof keys) =>
  ({
    slot: 465_480_384,
    blockTime: 1_793_833_658,
    transaction: { message },
    meta: { preBalances: pre, postBalances: post, loadedAddresses: { writable: loadedWritable, readonly: [] } },
  }) as unknown as VersionedTransactionResponse;

test("lamportDelta: the referral PDA's gain in the settle tx (QA referred-001: 5,000)", () => {
  const i = keys.findIndex((k) => k.equals(referral));
  assert.ok(i >= 0);
  const pre = keys.map(() => 1_000_000);
  const post = [...pre];
  post[i] = 1_000_000 + 5_000;
  assert.equal(lamportDelta(tx(pre, post), referral), 5_000n);
  // Capped to zero (vault short): a zero row, as the legacy event wrote.
  assert.equal(lamportDelta(tx(pre, pre), referral), 0n);
});

test("lamportDelta: loaded (lookup table) accounts follow the static keys; absent account is null", () => {
  const pre = [...keys.map(() => 0), 7];
  const post = [...keys.map(() => 0), 9];
  assert.equal(lamportDelta(tx(pre, post, [loaded]), loaded), 2n);
  assert.equal(lamportDelta(tx(pre, post), Keypair.generate().publicKey), null);
});
