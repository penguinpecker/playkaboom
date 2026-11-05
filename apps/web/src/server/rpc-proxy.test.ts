/**
 * /api/rpc/<cluster> (A5): batches are capped at 10 calls and every call in a
 * batch is charged to the per-IP limiter (30 / 10 s), so one request can't buy
 * thousands of upstream calls on the paid key. Upstream fetch is stubbed.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/rpc/[cluster]/route";

// The route reads env and fetch per request, so setting them here is in time.
delete process.env.UPSTASH_REDIS_REST_URL; // exercise the in-process limiter
process.env.SOLANA_MAINNET_RPC = "http://upstream.invalid";
let upstreamCalls = 0;
globalThis.fetch = (async () => {
  upstreamCalls++;
  return new Response("[]", { status: 200 });
}) as typeof fetch;

const call = { jsonrpc: "2.0", id: 1, method: "getSlot" };
function post(ip: string, body: unknown) {
  const req = new NextRequest("http://localhost/api/rpc/mainnet", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ cluster: "mainnet" }) });
}

test("rejects an empty or >10-call batch without going upstream", async () => {
  upstreamCalls = 0;
  for (const body of [[], Array(11).fill(call)]) {
    const res = await post("10.0.0.1", body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32600);
  }
  assert.equal(upstreamCalls, 0);
});

test("/api/rpc/devnet is 404 unless this is a devnet deploy (N9)", async () => {
  process.env.SOLANA_RPC = "http://upstream.invalid"; // a mainnet URL on a mainnet deploy
  const devnet = () =>
    POST(
      new NextRequest("http://localhost/api/rpc/devnet", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" },
        body: JSON.stringify(call),
      }),
      { params: Promise.resolve({ cluster: "devnet" }) },
    );
  upstreamCalls = 0;
  for (const c of [undefined, "mainnet-beta", "testnet"]) {
    if (c === undefined) delete process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
    else process.env.NEXT_PUBLIC_SOLANA_CLUSTER = c;
    assert.equal((await devnet()).status, 404);
  }
  assert.equal(upstreamCalls, 0);
  process.env.NEXT_PUBLIC_SOLANA_CLUSTER = "devnet";
  assert.equal((await devnet()).status, 200);
  assert.equal(upstreamCalls, 1);
  delete process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
  delete process.env.SOLANA_RPC;
});

test("each call in a batch is charged to the limiter", async () => {
  upstreamCalls = 0;
  for (let i = 0; i < 30; i++) assert.equal((await post("10.0.0.2", Array(10).fill(call))).status, 200);
  assert.equal((await post("10.0.0.2", call)).status, 429); // the RPC budget (300) is spent
  assert.equal(upstreamCalls, 30);

  // A batch that would overrun the budget is refused whole, not forwarded.
  for (let i = 0; i < 295; i++) await post("10.0.0.3", call);
  upstreamCalls = 0;
  assert.equal((await post("10.0.0.3", Array(10).fill(call))).status, 429);
  assert.equal(upstreamCalls, 0);
});
