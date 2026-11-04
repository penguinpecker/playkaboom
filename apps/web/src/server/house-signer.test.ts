/**
 * House signer: HOUSE_SECRET_KEY parsing (base58 or JSON byte array), boot
 * validation, signing, and that no error message ever carries the input.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { assertHouseSignerConfig, getHouseSigner, parseHouseSecretKey } from "./house-signer";

const kp = Keypair.generate();
const b58 = bs58.encode(kp.secretKey);
const json = JSON.stringify(Array.from(kp.secretKey));

test("base58 and JSON byte array give the same keypair", () => {
  assert.ok(parseHouseSecretKey(b58).publicKey.equals(kp.publicKey));
  assert.ok(parseHouseSecretKey(json).publicKey.equals(kp.publicKey));
  assert.ok(parseHouseSecretKey(`  ${b58}\n`).publicKey.equals(kp.publicKey));
  assert.ok(parseHouseSecretKey(` ${json} `).publicKey.equals(kp.publicKey));
});

test("malformed input throws a message that never contains the input", () => {
  const other = Keypair.generate();
  const mismatched = Uint8Array.from([...kp.secretKey.slice(0, 32), ...other.publicKey.toBytes()]);
  const cases: [string, RegExp][] = [
    [json.slice(0, -1) + ",SECRETMARKER]", /not a valid JSON byte array/],
    ["[1,2,3," + "999".repeat(3) + "]", /array of bytes/],
    [JSON.stringify(Array.from(kp.secretKey.slice(0, 63))), /64 bytes, got 63/],
    [b58.slice(0, 20) + "0OIl", /neither base58 nor/],
    [bs58.encode(kp.secretKey.slice(0, 32)), /64 bytes, got 32/],
    [bs58.encode(mismatched), /public half does not match/],
  ];
  for (const [input, want] of cases) {
    let msg = "";
    try {
      parseHouseSecretKey(input);
    } catch (e) {
      msg = (e as Error).message;
      assert.equal((e as Error).cause, undefined, "no cause chained to the error");
    }
    assert.match(msg, want, input.slice(0, 12));
    assert.ok(!msg.includes("SECRETMARKER"), msg);
    for (let i = 0; i + 8 <= input.length; i += 4) {
      const chunk = input.slice(i, i + 8);
      if (!/^[\[\],\d ]+$/.test(chunk)) assert.ok(!msg.includes(chunk), `message leaks input: ${msg}`);
    }
    assert.ok(!msg.includes(b58.slice(0, 16)));
  }
});

test("getHouseSigner: boot check, pubkey only, valid signature", async () => {
  // A missing key throws and is not cached, so setting it afterwards works.
  delete process.env.HOUSE_SECRET_KEY;
  assert.throws(() => assertHouseSignerConfig(), /HOUSE_SECRET_KEY is not set/);

  process.env.HOUSE_SECRET_KEY = b58;
  assert.ok(assertHouseSignerConfig().equals(kp.publicKey));
  const signer = getHouseSigner();
  assert.deepEqual(Object.keys(signer).sort(), ["publicKey", "signTransaction"]);
  assert.ok(!JSON.stringify(signer).includes(b58.slice(0, 16)));

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: PublicKey.default, lamports: 1 }),
  );
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = bs58.encode(Buffer.alloc(32, 7));
  await signer.signTransaction(tx);
  assert.ok(tx.verifySignatures(), "house signature verifies");
  delete process.env.HOUSE_SECRET_KEY;
});
