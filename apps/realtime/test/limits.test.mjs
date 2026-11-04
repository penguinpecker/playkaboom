// Smoke test for the relay's memory/connection limits (audit A3/A4).
// Spawns src/index.ts against a fake Alchemy upstream and checks the limits
// from outside, the way an attacker would hit them.
//
//   node --test apps/realtime/test/limits.test.mjs
//
// Optional: RELAY_TEST_DATABASE_URL=postgres://.../<scratch db> also checks
// feed backpressure through a real LISTEN/NOTIFY. Without it the relay gets a
// dead DATABASE_URL, which it tolerates (it just keeps reconnecting).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const ORIGIN = "http://localhost:3000"; // in the relay's default ALLOWED_ORIGINS
const DB = process.env.RELAY_TEST_DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake upstream: answers subscribes with fresh ids, confirms unsubscribes,
// finalises signature subs at once, and floods ~24 MB after slotSubscribe.
let nextSub = 100;
const fake = new WebSocketServer({ port: 0 });
fake.on("connection", (ws) =>
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    const reply = (result) => ws.send(JSON.stringify({ jsonrpc: "2.0", result, id: m.id }));
    if (m.method.endsWith("Unsubscribe")) return reply(true);
    if (!m.method.endsWith("Subscribe")) return reply(1);
    const sub = nextSub++;
    reply(sub);
    const note = (method, result) =>
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: { result, subscription: sub } }));
    if (m.method === "signatureSubscribe")
      note("signatureNotification", { context: { slot: 1 }, value: { err: null } });
    if (m.method === "slotSubscribe") {
      const pad = "x".repeat(60_000);
      for (let i = 0; i < 400; i++) note("slotNotification", { slot: i, pad });
    }
  }),
);

let relay;
let port;

async function health() {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(r.status, 200);
  return r.json();
}

function connect(path, ip) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { origin: ORIGIN, "x-forwarded-for": ip },
  });
  const inbox = [];
  const waiters = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  });
  ws.next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)));
  ws.closed = new Promise((r) => ws.once("close", (code) => r(code)));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  }).finally(() => ws.on("error", () => {}));
}

before(async () => {
  port = await new Promise((r) => {
    const s = net.createServer().listen(0, () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
  relay = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      DATABASE_URL: DB ?? "postgres://127.0.0.1:1/none",
      ALCHEMY_WS_URL: `ws://127.0.0.1:${fake.address().port}`,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await health();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("relay did not start");
});

after(() => {
  relay?.kill("SIGTERM");
  fake.close();
});

test("'/' still sends the same hello", async () => {
  const ws = await connect("/", "10.0.0.1");
  const hello = await ws.next();
  assert.deepEqual(Object.keys(hello), ["type", "clients", "upstream", "ts"]);
  assert.equal(hello.type, "hello");
  ws.close();
});

test("'/' closes a client that sends a frame over 4 KiB; process stays up", async () => {
  const ws = await connect("/", "10.0.0.2");
  await ws.next(); // hello
  ws.send("x".repeat(5 * 1024));
  assert.equal(await ws.closed, 1009);
  const again = await connect("/", "10.0.0.2");
  assert.equal((await again.next()).type, "hello");
  again.close();
});

test("/rpc-ws closes a client that sends a frame over 64 KiB", async () => {
  const ws = await connect("/rpc-ws", "10.0.0.3");
  ws.send("x".repeat(65 * 1024));
  assert.equal(await ws.closed, 1009);
  await health();
});

test("/rpc-ws caps live subscriptions at 32 and frees them on unsubscribe / final signature notification", async () => {
  const ws = await connect("/rpc-ws", "10.0.0.4");
  const call = (id, method, params = ["11111111111111111111111111111111"]) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return ws.next();
  };
  // A repeated in-flight id would let responses be mis-matched, so it is refused.
  const sub = { jsonrpc: "2.0", id: 7, method: "accountSubscribe", params: [] };
  ws.send(JSON.stringify([sub, sub]));
  assert.equal((await ws.next()).error.code, -32600);

  // Signature subs end at their final notification and stop counting.
  assert.equal(typeof (await call(0, "signatureSubscribe")).result, "number");
  assert.equal((await ws.next()).method, "signatureNotification");

  const ids = [];
  for (let i = 1; i <= 32; i++) {
    const r = await call(i, "accountSubscribe");
    assert.equal(typeof r.result, "number", JSON.stringify(r));
    ids.push(r.result);
  }
  const over = await call(33, "accountSubscribe");
  assert.equal(over.error.code, -32005);
  assert.equal(over.id, 33);

  assert.equal((await call(34, "accountUnsubscribe", [ids[0]])).result, true);
  assert.equal(typeof (await call(35, "accountSubscribe")).result, "number");
  ws.close();
});

test("/rpc-ws closes a client that stops reading (1013); process stays up", async () => {
  const proxied = async () => (await health()).rpc_proxy_clients;
  for (let i = 0; i < 100 && (await proxied()) > 0; i++) await sleep(100); // earlier tests' sockets
  assert.equal(await proxied(), 0);
  const ws = await connect("/rpc-ws", "10.0.0.5");
  ws._socket.pause();
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
  for (let i = 0; i < 100 && (await proxied()) > 0; i++) await sleep(100);
  assert.equal(await proxied(), 0, "slow reader was not dropped");
  ws._socket.resume();
  assert.equal(await ws.closed, 1013);
});

test("/rpc-ws closes the upstream when a client drops without a close frame (1006)", async () => {
  for (let i = 0; i < 100 && fake.clients.size > 0; i++) await sleep(100); // earlier tests' upstreams
  assert.equal(fake.clients.size, 0);
  const ws = await connect("/rpc-ws", "10.0.0.6");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "accountSubscribe", params: [] }));
  assert.equal(typeof (await ws.next()).result, "number");
  assert.equal(fake.clients.size, 1);
  ws._socket.destroy();
  for (let i = 0; i < 50 && fake.clients.size > 0; i++) await sleep(100);
  assert.equal(fake.clients.size, 0, "upstream socket (and its subscriptions) leaked");
});

test("per-IP caps: 5 on /rpc-ws, 20 on '/'; first X-Forwarded-For hop is the key", async () => {
  const rpc = [];
  for (let i = 0; i < 5; i++) rpc.push(await connect("/rpc-ws", i ? "10.0.1.1" : "10.0.1.1, 203.0.113.9"));
  await assert.rejects(connect("/rpc-ws", "10.0.1.1"), /503/);
  const other = await connect("/rpc-ws", "10.0.1.2");
  rpc[0].close();
  await rpc[0].closed;
  rpc.push(await connect("/rpc-ws", "10.0.1.1")); // slot freed on close

  const feed = [];
  for (let i = 0; i < 20; i++) feed.push(await connect("/", "10.0.1.3"));
  await assert.rejects(connect("/", "10.0.1.3"), /503/);
  for (const ws of [...rpc, other, ...feed]) ws.close();
});

test("'/' closes a viewer that stops reading (needs RELAY_TEST_DATABASE_URL)", { skip: !DB }, async () => {
  const { default: pg } = await import("pg");
  for (let i = 0; i < 100 && !(await health()).upstream; i++) await sleep(100);
  assert.equal((await health()).upstream, true, "relay never LISTENed");
  const ws = await connect("/", "10.0.2.1");
  await ws.next(); // hello
  ws._socket.pause();
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  // ~3000 broadcasts of ~7 KB each, distinct payloads so NOTIFY does not fold them.
  await db.query(
    `select pg_notify('kaboom_events', json_build_object('table','games','op','INSERT',
       'row', json_build_object('signature', i || repeat('x', 7000)))::text)
     from generate_series(1, 3000) i`,
  );
  await db.end();
  await sleep(2000);
  ws._socket.resume();
  assert.equal(await ws.closed, 1013);
});

test("relay process is still running", async () => {
  assert.equal(relay.exitCode, null);
  await health();
});
