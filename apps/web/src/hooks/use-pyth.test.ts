/**
 * Pyth SOL/USD (M3): keyless Hermes answers 401 with no CORS header, which a
 * browser surfaces as a thrown fetch. After one refusal the fetcher stops
 * calling Hermes, so the 15 s poll no longer logs a console error each time.
 * Runs without the react-server condition because the hook module imports
 * @tanstack/react-query.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let calls = 0;
let reply: () => Response = () => new Response("", { status: 500 });
globalThis.fetch = (async () => {
  calls++;
  return reply();
}) as typeof fetch;
const price = (p: string, expo: number) =>
  Response.json({ parsed: [{ price: { price: p, expo, conf: "5", publish_time: 1 } }] });

// The refusal flag is module state: each test gets its own copy of the module.
function freshFetcher(): typeof import("./use-pyth").fetchPythSolUsd {
  delete require.cache[require.resolve("./use-pyth")];
  return require("./use-pyth").fetchPythSolUsd;
}

test("parses a price, keeps polling on a 5xx, stops for good after a 401", async () => {
  const fetchPythSolUsd = freshFetcher();
  calls = 0;
  reply = () => price("15342", -2);
  assert.equal((await fetchPythSolUsd())?.usd.toFixed(2), "153.42");
  reply = () => new Response("", { status: 503 });
  assert.equal(await fetchPythSolUsd(), null);
  assert.equal(await fetchPythSolUsd(), null);
  assert.equal(calls, 3);

  reply = () => new Response("unauthorized", { status: 401 });
  assert.equal(await fetchPythSolUsd(), null);
  reply = () => price("1", 0);
  assert.equal(await fetchPythSolUsd(), null);
  assert.equal(calls, 4); // nothing sent after the 401
});

test("a CORS-blocked fetch stops polling; an offline one does not", async () => {
  const fetchPythSolUsd = freshFetcher();
  calls = 0;
  reply = () => {
    throw new TypeError("Failed to fetch");
  };
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
  assert.equal(await fetchPythSolUsd(), null);
  if (nav) Object.defineProperty(globalThis, "navigator", nav);
  else delete (globalThis as { navigator?: unknown }).navigator;
  reply = () => price("15342", -2);
  assert.equal((await fetchPythSolUsd())?.usd.toFixed(2), "153.42"); // still polling after the offline blip

  reply = () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await fetchPythSolUsd(), null);
  reply = () => price("15342", -2);
  assert.equal(await fetchPythSolUsd(), null);
  assert.equal(calls, 3); // nothing sent after the CORS failure
});
