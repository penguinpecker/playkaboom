/**
 * Live-feed WebSocket relay for playkaboom.gg.
 *
 * LISTENs on the Postgres `kaboom_events` channel (one connection for the
 * whole relay; a trigger on public.games sends each INSERT/UPDATE, see
 * db/migrations/20261104000001_pg_notify_relay.sql) and fans out each event
 * over WebSocket to every connected browser client. 1000 viewers on the
 * relay = 1 database connection.
 *
 * The web client also polls /api/activity/global every 60s as a safety net,
 * so a Railway redeploy / brief drop doesn't make the feed stale (NOTIFY has
 * no replay: events sent while the relay is disconnected are not resent).
 *
 * Required env:
 *   DATABASE_URL          Railway Postgres URL (private network URL; add
 *                         ?sslmode=no-verify for the public TCP proxy)
 *   PORT                  Set automatically by Railway. Defaults 8080.
 *   ALLOWED_ORIGINS       Comma-separated list. Defaults to prod
 *                         playkaboom.gg origins.
 *
 * Optional env:
 *   CRON_TICK_URL         If set, the relay polls this URL on a 60s
 *                         interval and forwards CRON_TICK_AUTH as the
 *                         Authorization header. Point it at the kaboom-web
 *                         /api/cron/tick route: the ONE house scheduler
 *                         (indexer, VRF settle/force/refund, legacy expire,
 *                         LP auto-complete, vault health, invariants).
 *                         Railway containers run 24/7 so cadence is reliable.
 *   CRON_TICK_AUTH        Bearer token for the CRON_TICK_URL request: the
 *                         web's CRON_TICK_SECRET.
 *   ALCHEMY_WS_URL        Full Alchemy Solana mainnet WS URL incl. API key.
 *                         When set with INGEST_URL +
 *                         INGEST_AUTH, the relay also runs an Alchemy
 *                         logsSubscribe push path that replaces the deleted
 *                         Helius enhanced-webhook. See ./alchemy-logs.ts.
 *   KABOOM_PROGRAM_ID     On-chain program ID for the logsSubscribe filter
 *                         (defaults to the relaunch program Ednka8...).
 *   INGEST_URL            POST endpoint that ingests one signature at a
 *                         time (the playkaboom.gg /api/ingest route).
 *   INGEST_AUTH           Bearer token for INGEST_URL — same value as
 *                         CRON_TICK_AUTH works; the route accepts either
 *                         CRON_SECRET or HELIUS_WEBHOOK_AUTH.
 */
import http from "node:http";
import { WebSocket as UpstreamWS, WebSocketServer, type WebSocket } from "ws";
import pg from "pg";
import { startAlchemyLogsSubscriber } from "./alchemy-logs.js";

const PORT = Number(process.env.PORT ?? 8080);
const DATABASE_URL = process.env.DATABASE_URL;
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ??
  "https://playkaboom.gg,https://www.playkaboom.gg,http://localhost:3000"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!DATABASE_URL) {
  console.error("[fatal] DATABASE_URL is not set");
  process.exit(1);
}

const clients = new Set<WebSocket>();
let upstreamConnected = false;
const alchemyLogs = startAlchemyLogsSubscriber();

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        clients: clients.size,
        rpc_proxy_clients: rpcProxyActive.size,
        upstream: upstreamConnected,
        alchemy_logs: alchemyLogs?.isConnected() ?? null,
        uptime_s: Math.round(process.uptime()),
      }),
    );
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// Two WS surfaces share the same HTTP listener via path-based routing on
// `upgrade`:
//   - `/`            game-settle fanout (this file's original purpose)
//   - `/rpc-ws`      Alchemy WS proxy for browser web3.js Connection
//                    (added 2026-05-21 — keeps the paid Alchemy key in
//                    Railway env so it never enters the browser bundle)
// Both use `noServer: true` so we can branch in the upgrade handler.
// maxPayload: ws defaults to 100 MiB and buffers a whole message before any
// handler sees it, so a size check inside a handler is already too late.
// '/' clients never send data frames; /rpc-ws matches RPC_MAX_FRAME_BYTES.
const wssRelay = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
const wssProxy = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

const RPC_PROXY_PATH = "/rpc-ws";

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl) — feed is public anyway
  if (ALLOWED_ORIGINS.includes("*")) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

/**
 * Concurrency cap for the PAID-KEY proxy.
 *
 * Origin is trivially forgeable, so the allow-list bounds nothing on its own —
 * the cap is what actually limits cost. Each accepted /rpc-ws client opens its
 * OWN upstream Alchemy socket, so without this a single script could open
 * unbounded upstream connections on the operator's paid key.
 */
const MAX_RPC_PROXY_CLIENTS = 150;

/**
 * Memory caps. This process is also the only house cron driver, so a client
 * must never be able to grow its heap until it dies:
 *   - a socket whose unsent output passes MAX_CLIENT_BUFFERED_BYTES has
 *     stopped reading; it is closed instead of buffered for;
 *   - connection counts are capped globally and per IP. The IP is the first
 *     X-Forwarded-For hop (Railway's edge sets it), else the socket address.
 */
const MAX_CLIENT_BUFFERED_BYTES = 1024 * 1024;
const MAX_RELAY_CLIENTS = 2000;
const MAX_RELAY_PER_IP = 20;
const MAX_RPC_PROXY_PER_IP = 5;
const relayPerIp = new Map<string, number>();
const rpcProxyPerIp = new Map<string, number>();

function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** Count `ws` against `ip` until it closes. */
function countPerIp(counts: Map<string, number>, ip: string, ws: WebSocket): void {
  counts.set(ip, (counts.get(ip) ?? 0) + 1);
  ws.once("close", () => {
    const n = (counts.get(ip) ?? 1) - 1;
    if (n > 0) counts.set(ip, n);
    else counts.delete(ip);
  });
}

/**
 * What a browser may ask the upstream for through this socket.
 *
 * Mirrors the HTTP proxy's list (apps/web/src/app/api/rpc/[cluster]/route.ts)
 * plus the subscription methods that are the entire reason a WS proxy exists,
 * and MINUS sendTransaction: writes go through the HTTP proxy, which has its
 * own per-IP limit. Anything not named here is refused, so an outsider cannot
 * turn this endpoint into free general-purpose access to a paid RPC key.
 */
const WS_ALLOWED_METHODS = new Set<string>([
  "accountSubscribe",
  "accountUnsubscribe",
  "signatureSubscribe",
  "signatureUnsubscribe",
  "logsSubscribe",
  "logsUnsubscribe",
  "programSubscribe",
  "programUnsubscribe",
  "slotSubscribe",
  "slotUnsubscribe",
  "rootSubscribe",
  "rootUnsubscribe",
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getBlockHeight",
  "getSlot",
  "getLatestBlockhash",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getMinimumBalanceForRentExemption",
  "getEpochInfo",
  "getVersion",
  "getHealth",
]);

/** Per-connection budget: steady rate, short burst, and hard frame limits. */
const RPC_PER_SEC = 12;
const RPC_BURST = 40;
const RPC_MAX_FRAME_BYTES = 64 * 1024;
const RPC_MAX_BATCH = 10;
const RPC_MAX_PENDING = 50;
/** Live upstream subscriptions per connection; each one is a notification stream. */
const RPC_MAX_SUBSCRIPTIONS = 32;

httpServer.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin as string | undefined;
  const pathnameEarly = (req.url ?? "/").split("?")[0];
  const isProxyPath = pathnameEarly === RPC_PROXY_PATH;

  // The public feed at "/" is genuinely public — curl with no Origin is fine.
  // /rpc-ws is NOT: it fronts a paid key, so a MISSING Origin must be refused
  // rather than treated as trusted (isAllowedOrigin returns true for absent).
  if (!isAllowedOrigin(origin) || (isProxyPath && !origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  const perIp = isProxyPath ? rpcProxyPerIp : relayPerIp;
  if (
    (isProxyPath
      ? rpcProxyActive.size >= MAX_RPC_PROXY_CLIENTS
      : clients.size >= MAX_RELAY_CLIENTS) ||
    (perIp.get(ip) ?? 0) >= (isProxyPath ? MAX_RPC_PROXY_PER_IP : MAX_RELAY_PER_IP)
  ) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  // Strip query/fragment so /rpc-ws?cluster=mainnet would also match.
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname === RPC_PROXY_PATH) {
    wssProxy.handleUpgrade(req, socket, head, (ws) => {
      countPerIp(perIp, ip, ws);
      handleRpcProxyConnection(ws);
    });
    return;
  }
  // Default: relay broadcast (existing behaviour).
  wssRelay.handleUpgrade(req, socket, head, (ws) => {
    countPerIp(perIp, ip, ws);
    handleRelayConnection(ws);
  });
});

function handleRelayConnection(ws: WebSocket): void {
  clients.add(ws);
  const live = ws as WebSocket & { isAlive?: boolean };
  live.isAlive = true;
  ws.on("pong", () => {
    live.isAlive = true;
  });
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  ws.send(
    JSON.stringify({
      type: "hello",
      clients: clients.size,
      upstream: upstreamConnected,
      ts: Date.now(),
    }),
  );
}

// ── /rpc-ws → Alchemy WS proxy ───────────────────────────────────────────
//
// Browser web3.js Connection opens this WS for signatureSubscribe +
// accountSubscribe. We open a matching upstream WS to Alchemy (URL +
// API key from ALCHEMY_WS_URL env, same value alchemy-logs.ts uses) and
// pipe messages bidirectionally. Each browser → its own upstream, no
// multiplexing — simpler protocol fidelity, and Solana subscription
// state is per-connection so de-muxing would be invasive. Resource
// budget at expected concurrency (≤100 simultaneous players) sits well
// inside Alchemy paid-tier WS limits.
//
// Failure modes handled:
//   - Upstream fails to open                  → close client immediately
//   - Client closes mid-flight                → close upstream
//   - Upstream closes                         → close client
//   - Either side throws                      → close both
//   - Messages arrive on client BEFORE
//     upstream's `open` fires                 → buffer + flush on open
const rpcProxyActive = new Set<WebSocket>();

function handleRpcProxyConnection(client: WebSocket): void {
  // An unhandled 'error' (e.g. an oversize frame on an early-return path below)
  // would throw and take the whole process, cron driver included, down.
  client.on("error", () => {});
  const alchemyUrl = process.env.ALCHEMY_WS_URL;
  if (!alchemyUrl) {
    client.send(JSON.stringify({ error: "rpc proxy not configured" }));
    client.close(1011, "ALCHEMY_WS_URL not set");
    return;
  }

  let upstream: UpstreamWS;
  try {
    upstream = new UpstreamWS(alchemyUrl);
  } catch (err) {
    client.close(1011, `upstream open failed: ${(err as Error).message}`);
    return;
  }

  rpcProxyActive.add(client);
  const pending: Array<Buffer> = [];
  let upstreamOpen = false;
  let closed = false;

  const closeBoth = (code = 1000, reason = ""): void => {
    if (closed) return;
    closed = true;
    // 1005/1006 report a close that had no close frame; ws throws if asked to
    // send them, which left the other socket (and its subscriptions) open.
    if (code === 1005 || code === 1006) code = 1000;
    rpcProxyActive.delete(client);
    try {
      if (client.readyState === client.OPEN) client.close(code, reason);
      else client.terminate();
    } catch {
      /* ignore */
    }
    try {
      if (upstream.readyState === upstream.OPEN) upstream.close(code, reason);
      else upstream.terminate();
    } catch {
      /* ignore */
    }
  };

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const m of pending) upstream.send(m);
    pending.length = 0;
  });
  // Subscription accounting. A subscription counts from the moment its request
  // is forwarded until upstream confirms the unsubscribe, or (signature subs)
  // sends the final notification, after which the server drops it on its own.
  // Matching responses to requests needs every in-flight id to be unique on
  // this connection, so a repeated in-flight id is refused.
  const inflight = new Map<string, { method: string; unsubId?: unknown }>();
  const subs = new Set<unknown>(); // live upstream subscription ids
  let pendingSubs = 0;
  const idKey = (id: unknown): string | null =>
    typeof id === "number" || typeof id === "string" ? JSON.stringify(id) : null;
  const noteUpstream = (data: unknown): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    for (const m of (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      id?: unknown;
      result?: unknown;
      error?: unknown;
      method?: unknown;
      params?: { subscription?: unknown; result?: { value?: unknown } };
    } | null>) {
      if (m?.method === "signatureNotification") {
        if (m.params?.result?.value !== "receivedSignature") subs.delete(m.params?.subscription);
        continue;
      }
      const key = idKey(m?.id);
      const call = key === null ? undefined : inflight.get(key);
      if (!m || !call) continue;
      inflight.delete(key as string);
      if (call.method.endsWith("Unsubscribe")) {
        if (m.result === true) subs.delete(call.unsubId);
      } else if (call.method.endsWith("Subscribe")) {
        pendingSubs--;
        if (m.error === undefined && m.result !== undefined) subs.add(m.result);
      }
    }
  };

  // A client that stops reading makes every send pile up in this process.
  const backedUp = (): boolean => {
    if (client.bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES) return false;
    closeBoth(1013, "client too slow");
    return true;
  };

  upstream.on("message", (data, isBinary) => {
    if (client.readyState !== client.OPEN) return;
    if (backedUp()) return;
    noteUpstream(data);
    try {
      client.send(data, { binary: isBinary });
    } catch {
      closeBoth(1011, "client send error");
    }
  });
  upstream.on("close", (code, reason) => closeBoth(code, reason?.toString() ?? ""));
  upstream.on("error", () => closeBoth(1011, "upstream error"));

  // Token bucket, refilled continuously. Bounds how fast ONE client can burn
  // upstream credits; the connection cap bounds how many clients there are.
  let tokens = RPC_BURST;
  let lastRefill = Date.now();

  const rpcError = (id: unknown, code: number, message: string): void => {
    if (client.readyState !== client.OPEN) return;
    if (backedUp()) return;
    try {
      client.send(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
    } catch {
      /* client is gone; the close handlers will clean up */
    }
  };

  client.on("message", (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

    // Everything below is the gate that used to be missing: this socket fronts
    // a PAID upstream key, so a frame is forwarded only if it is a small,
    // well-formed JSON-RPC call naming an allowlisted method, and only if this
    // connection is within its rate budget. Binary frames are never RPC.
    if (isBinary || buf.length > RPC_MAX_FRAME_BYTES) {
      rpcError(null, -32600, "Invalid request");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      rpcError(null, -32700, "Parse error");
      return;
    }

    const calls = Array.isArray(parsed) ? parsed : [parsed];
    if (calls.length === 0 || calls.length > RPC_MAX_BATCH) {
      rpcError(null, -32600, "Invalid request");
      return;
    }
    const batchKeys = new Set<string>();
    let newSubs = 0;
    for (const call of calls) {
      const method = (call as { method?: unknown })?.method;
      const id = (call as { id?: unknown })?.id;
      if (typeof method !== "string" || !WS_ALLOWED_METHODS.has(method)) {
        // Same posture as the HTTP proxy: an unknown or write method is
        // refused outright rather than forwarded and paid for.
        rpcError(id, -32601, "Method not allowed");
        return;
      }
      const key = idKey(id);
      const isSub = method.endsWith("Subscribe");
      // A subscribe needs a matchable id so its result can be counted.
      if (key === null ? isSub : inflight.has(key) || batchKeys.has(key)) {
        rpcError(id, -32600, "Invalid request");
        return;
      }
      if (key !== null) batchKeys.add(key);
      if (isSub && subs.size + pendingSubs + ++newSubs > RPC_MAX_SUBSCRIPTIONS) {
        rpcError(id, -32005, "Too many subscriptions");
        return;
      }
    }
    if (inflight.size + batchKeys.size > RPC_MAX_PENDING) {
      rpcError((calls[0] as { id?: unknown })?.id, -32005, "Too many pending requests");
      return;
    }

    const now = Date.now();
    tokens = Math.min(RPC_BURST, tokens + ((now - lastRefill) / 1000) * RPC_PER_SEC);
    lastRefill = now;
    if (tokens < calls.length) {
      rpcError((calls[0] as { id?: unknown })?.id, -32005, "Rate limit exceeded");
      return;
    }
    tokens -= calls.length;

    for (const call of calls as Array<{ id?: unknown; method: string; params?: unknown }>) {
      const key = idKey(call.id);
      if (key === null) continue;
      if (call.method.endsWith("Subscribe")) pendingSubs++;
      const unsubId = call.method.endsWith("Unsubscribe") && Array.isArray(call.params)
        ? call.params[0]
        : undefined;
      inflight.set(key, { method: call.method, unsubId });
    }

    if (!upstreamOpen) {
      if (pending.length >= RPC_MAX_PENDING) {
        closeBoth(1013, "too many buffered requests");
        return;
      }
      pending.push(buf);
      return;
    }
    try {
      upstream.send(buf, { binary: false });
    } catch {
      closeBoth(1011, "upstream send error");
    }
  });
  client.on("close", (code, reason) => closeBoth(code, reason?.toString() ?? ""));
  client.on("error", () => closeBoth(1011, "client error"));
}

// Reap dead sockets that disappeared without a clean close (mobile-tab
// kill / network drop). Browsers auto-respond to pings; clients that
// don't reply within 60s are terminated to avoid slow accumulation.
const HEARTBEAT_MS = 30_000;
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    const live = ws as WebSocket & { isAlive?: boolean };
    if (live.isAlive === false) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    live.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
      clients.delete(ws);
    }
  }
}, HEARTBEAT_MS);

const broadcast = (payload: string) => {
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try {
        // A viewer that stopped reading is closed, not buffered for.
        if (ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) ws.close(1013, "client too slow");
        else ws.send(payload);
      } catch {
        clients.delete(ws);
      }
    }
  }
};

// ── Upstream: Postgres LISTEN kaboom_events ──────────────────────────
//
// SCOPE: both INSERT (cashout/loss row created with sentinel fairness
// fields) and UPDATE (server settle sets mine_count / settle_signature)
// must be relayed — otherwise clients see a row stuck on "settle pending"
// even after settle landed.
//
// The trigger payload is {table, op, row} where `row` is already the
// 12-column allowlist below; the fairness pre-image (mine_layout, salt,
// commitment) is never in it. We still project through pickSafeCols so a
// future trigger change cannot widen what the public relay broadcasts.
const NOTIFY_CHANNEL = "kaboom_events";
let upstream: pg.Client | null = null;
let upstreamBackoffMs = 1_000;
let upstreamPing: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

function startUpstream() {
  type GameRow = {
    signature?: string | null;
    game?: string | null;
    player?: string | null;
    bet?: number | string | null;
    outcome?: string | null;
    payout?: number | string | null;
    multiplier_bps?: number | null;
    safe_reveals?: number | null;
    mine_count?: number | null;
    settled_at?: string | null;
    settle_signature?: string | null;
    slot?: number | null;
  };
  const pickSafeCols = (row: unknown): GameRow | null => {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    return {
      signature: (r.signature as string | null) ?? null,
      game: (r.game as string | null) ?? null,
      player: (r.player as string | null) ?? null,
      bet: (r.bet as number | string | null) ?? null,
      outcome: (r.outcome as string | null) ?? null,
      payout: (r.payout as number | string | null) ?? null,
      multiplier_bps: (r.multiplier_bps as number | null) ?? null,
      safe_reveals: (r.safe_reveals as number | null) ?? null,
      mine_count: (r.mine_count as number | null) ?? null,
      settled_at: (r.settled_at as string | null) ?? null,
      settle_signature: (r.settle_signature as string | null) ?? null,
      slot: (r.slot as number | null) ?? null,
    };
  };
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    keepAlive: true,
    query_timeout: 10_000, // so the ping below fails instead of hanging
  });
  upstream = client;
  let dead = false;
  const reconnect = (why: string) => {
    if (dead) return;
    dead = true;
    upstreamConnected = false;
    if (upstreamPing) clearInterval(upstreamPing);
    upstreamPing = null;
    client.removeAllListeners();
    client.on("error", () => {}); // late socket errors after end()
    void client.end().catch(() => {});
    if (shuttingDown) return;
    console.warn(`[upstream] ${why}; reconnecting in ${upstreamBackoffMs}ms`);
    setTimeout(startUpstream, upstreamBackoffMs);
    upstreamBackoffMs = Math.min(upstreamBackoffMs * 2, 30_000);
  };
  client.on("error", (err) => reconnect(`error: ${err.message}`));
  client.on("end", () => reconnect("connection ended"));
  client.on("notification", (msg) => {
    if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
    let ev: { table?: string; op?: string; row?: unknown };
    try {
      ev = JSON.parse(msg.payload);
    } catch {
      return;
    }
    if (ev.table !== "games" || (ev.op !== "INSERT" && ev.op !== "UPDATE")) return;
    const data = pickSafeCols(ev.row);
    if (!data) return;
    broadcast(
      JSON.stringify({
        // Legacy clients keyed on type==="game_settled" still receive
        // both events. Newer code can branch on insert vs update.
        type: "game_settled",
        event: ev.op === "INSERT" ? "game_inserted" : "game_updated",
        data,
        ts: Date.now(),
      }),
    );
  });
  client
    .connect()
    .then(() => client.query(`LISTEN ${NOTIFY_CHANNEL}`))
    .then(() => {
      if (dead) return;
      upstreamConnected = true;
      upstreamBackoffMs = 1_000;
      console.log(`[upstream] listening on ${NOTIFY_CHANNEL}`);
      // A half-open TCP connection fires no event; a cheap query does.
      upstreamPing = setInterval(() => {
        client.query("select 1").catch((e: Error) => reconnect(`ping failed: ${e.message}`));
      }, 30_000);
    })
    .catch((err: Error) => reconnect(`connect failed: ${err.message}`));
}

startUpstream();

// ── Cron tickler (optional) ──────────────────────────────────────────
//
// Calls a URL on a 60s schedule with a bearer auth header. Used as a
// reliable replacement for the playkaboom.gg GH-Actions cron, which on
// free tier fires every 1-3h instead of 5min. Railway containers run
// 24/7 so the cadence is dependable without burning a Cron-as-a-Service
// subscription. Skips itself if the previous tick is still in flight
// (avoids stacking calls on slow indexer runs).
const CRON_TICK_URL = process.env.CRON_TICK_URL;
const CRON_TICK_AUTH = process.env.CRON_TICK_AUTH;
const CRON_TICK_INTERVAL_MS = 60_000;
let cronInflight = false;
let cronInterval: ReturnType<typeof setInterval> | null = null;

async function tickCron() {
  if (cronInflight) {
    console.warn("[cron] previous tick still running, skipping");
    return;
  }
  if (!CRON_TICK_URL) return;
  cronInflight = true;
  try {
    const headers: Record<string, string> = {};
    if (CRON_TICK_AUTH) headers["Authorization"] = `Bearer ${CRON_TICK_AUTH}`;
    // CRON_TICK_URL accepts a COMMA-SEPARATED list.
    //
    // This relay is the only thing on the stack that actually runs every 60s.
    // GitHub Actions free-tier cron claims */5 but measured 59-199 MINUTES, and
    // it was the sole driver of the VRF settle worker — so a player who
    // disconnected after a win could wait hours for a payout the fallback
    // worker was supposed to deliver in minutes. Ticking every endpoint from
    // here removes GitHub from the critical path entirely.
    const targets = CRON_TICK_URL.split(",").map((u) => u.trim()).filter(Boolean);
    const results = await Promise.all(
      targets.map(async (url) => {
        try {
          const r = await fetch(url, { method: "GET", headers });
          if (!r.ok) console.warn(`[cron] ${new URL(url).pathname} failed: HTTP ${r.status}`);
          return r;
        } catch (e) {
          console.warn(`[cron] ${url} threw:`, e);
          return null;
        }
      }),
    );
    // Keep the existing body-logging behaviour for the FIRST target (the
    // indexer tick), which is the one whose counters are worth reporting.
    const res = results[0];
    if (!res) return;
    if (!res.ok) {
      console.warn(`[cron] tick failed: HTTP ${res.status}`);
    } else {
      const body = (await res.json().catch(() => null)) as
        | {
            processed?: number;
            skipped?: number;
            errors?: number;
            errorDetails?: { sig: string; message: string }[];
          }
        | null;
      if (body && (body.processed || body.errors)) {
        console.log(
          `[cron] processed=${body.processed ?? 0} skipped=${body.skipped ?? 0} errors=${body.errors ?? 0}`,
        );
      }
      if (body?.errorDetails?.length) {
        for (const d of body.errorDetails) {
          console.warn(`[cron] error sig=${d.sig.slice(0, 16)}… msg=${d.message}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[cron] tick error: ${(e as Error).message}`);
  } finally {
    cronInflight = false;
  }
}

if (CRON_TICK_URL) {
  // 2026-05-11 hardening: refuse to start the tickler if CRON_TICK_URL is
  // set but CRON_TICK_AUTH is not. Otherwise every tick would be a silent
  // 401 against the upstream — looks "working" in Railway logs (200 OK
  // never happens, just warnings) but actually blocks all indexing.
  if (!CRON_TICK_AUTH) {
    console.error(
      "[cron] CRON_TICK_URL is set but CRON_TICK_AUTH is empty — refusing to start tickler. Indexing will fall behind until both are configured.",
    );
  } else {
    console.log(
      `[cron] tickling ${CRON_TICK_URL} every ${CRON_TICK_INTERVAL_MS / 1000}s`,
    );
    // Stagger first tick by 5s so the relay isn't pinging anything before
    // upstream subscription has a chance to settle.
    setTimeout(() => void tickCron(), 5_000);
    cronInterval = setInterval(() => void tickCron(), CRON_TICK_INTERVAL_MS);
  }
}

httpServer.listen(PORT, () => {
  console.log(`[realtime] listening on :${PORT}`);
});

const shutdown = (sig: string) => {
  console.log(`[realtime] ${sig} — shutting down`);
  clearInterval(heartbeat);
  if (cronInterval) clearInterval(cronInterval);
  alchemyLogs?.stop();
  for (const ws of clients) {
    try {
      ws.close(1001, "server shutdown");
    } catch {
      /* noop */
    }
  }
  for (const ws of rpcProxyActive) {
    try {
      ws.close(1001, "server shutdown");
    } catch {
      /* noop */
    }
  }
  shuttingDown = true;
  if (upstreamPing) clearInterval(upstreamPing);
  void upstream?.end().catch(() => {});
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
