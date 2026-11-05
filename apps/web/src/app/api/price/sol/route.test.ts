/**
 * /api/price/sol (site check F6): falls back from Jupiter to Coinbase, and
 * serves every caller from one upstream fetch per 30 s.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const hosts: string[] = [];
let jupiterUp = true;
globalThis.fetch = (async (url: string) => {
  const host = new URL(url).host;
  hosts.push(host);
  if (host === "lite-api.jup.ag") {
    return jupiterUp
      ? Response.json({ So11111111111111111111111111111111111111112: { usdPrice: 96.04 } })
      : new Response("", { status: 500 });
  }
  return Response.json({ data: { amount: "96.06", base: "SOL", currency: "USD" } });
}) as typeof fetch;

test("cached for 30 s, Coinbase when Jupiter fails", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { GET } = await import("./route");

  const a = await (await GET()).json();
  const b = await (await GET()).json();
  assert.deepEqual(a, { usd: 96.04, publishTime: 1000 });
  assert.deepEqual(b, a);
  assert.deepEqual(hosts, ["lite-api.jup.ag"]); // second call served from cache

  jupiterUp = false;
  t.mock.timers.tick(30_000);
  const c = await GET();
  assert.equal(c.status, 200);
  assert.equal((await c.json()).usd, 96.06);
  assert.deepEqual(hosts, ["lite-api.jup.ag", "lite-api.jup.ag", "api.coinbase.com"]);
});
