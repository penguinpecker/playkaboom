/**
 * SOL/USD (site check F6): the browser reads our own /api/price/sol route,
 * never Pyth Hermes (keyless Hermes answers 401 with no CORS header). A failed
 * read returns null and the next poll tries again. Runs without the
 * react-server condition because the hook module imports @tanstack/react-query.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPythSolUsd } from "./use-pyth";

const urls: string[] = [];
let reply: () => Response = () => new Response("", { status: 500 });
globalThis.fetch = (async (url: string) => {
  urls.push(url);
  return reply();
}) as typeof fetch;

test("reads the same-origin route; failures return null and keep polling", async () => {
  reply = () => Response.json({ usd: 153.42, publishTime: 7 });
  assert.deepEqual(await fetchPythSolUsd(), { usd: 153.42, confidence: 0, publishTime: 7 });

  reply = () => new Response("", { status: 503 });
  assert.equal(await fetchPythSolUsd(), null);
  reply = () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await fetchPythSolUsd(), null);
  reply = () => Response.json({ error: "price unavailable" });
  assert.equal(await fetchPythSolUsd(), null);

  reply = () => Response.json({ usd: 150, publishTime: 8 });
  assert.equal((await fetchPythSolUsd())?.usd, 150); // still polling after failures
  assert.deepEqual(new Set(urls), new Set(["/api/price/sol"]));
});
