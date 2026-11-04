/**
 * Public read APIs (L7 / M1): malformed input is a 400 before any RPC call,
 * not a 500 carrying the RPC's raw error text, and a non-pubkey is a 400.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { NextRequest } from "next/server";
import { GET as verifyQuery } from "@/app/api/verify/route";
import { GET as verifyPath } from "@/app/api/verify/[signature]/route";
import { GET as gameState } from "@/app/api/game/[player]/route";
import { isTxSignature } from "./verify-vrf";

// 64 base58 chars passed the old /api/verify/<sig> regex but decode to ~47 bytes.
const BAD_SIGS = ["garbage123", "2".repeat(64), bs58.encode(randomBytes(63)), "0OIl".repeat(22)];

test("isTxSignature accepts exactly 64 base58-decoded bytes", () => {
  assert.equal(isTxSignature(bs58.encode(randomBytes(64))), true);
  for (const s of [...BAD_SIGS, bs58.encode(randomBytes(65)), ""]) assert.equal(isTxSignature(s), false, s);
});

test("both verify routes answer a malformed signature with 400", async () => {
  for (const sig of BAD_SIGS) {
    const q = await verifyQuery(new NextRequest(`http://localhost/api/verify?sig=${encodeURIComponent(sig)}`));
    assert.equal(q.status, 400, `?sig=${sig}`);
    assert.equal((await q.json()).error, "Invalid signature format");
    const p = await verifyPath(new NextRequest("http://localhost/api/verify/x"), {
      params: Promise.resolve({ signature: sig }),
    });
    assert.equal(p.status, 400, `/${sig}`);
  }
});

test("/api/game/<x> answers a non-pubkey with 400", async () => {
  const res = await gameState(new NextRequest("http://localhost/api/game/notapubkey"), {
    params: Promise.resolve({ player: "notapubkey" }),
  });
  assert.equal(res.status, 400);
});
