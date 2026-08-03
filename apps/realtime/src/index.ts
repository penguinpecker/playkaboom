/**
 * Live-feed WebSocket relay for playkaboom.gg.
 *
 * Subscribes to Supabase Realtime postgres_changes upstream (one
 * connection for the whole relay), and fans out each event over
 * WebSocket to every connected browser client. This decouples viewer
 * count from Supabase's per-client connection quota: 1000 viewers on
 * the relay = 1 upstream Supabase connection.
 *
 * The web client ALSO subscribes to Supabase Realtime directly as a
 * fallback (and polls at 60s as a last-resort safety net), so a
 * Railway redeploy / brief drop doesn't make the feed stale.
 *
 * Required env:
 *   SUPABASE_URL          https://<project>.supabase.co
 *   SUPABASE_ANON_KEY     anon JWT (RLS-enforced; tables already grant
 *                         SELECT to anon)
 *   PORT                  Set automatically by Railway. Defaults 8080.
 *   ALLOWED_ORIGINS       Comma-separated list. Defaults to prod
 *                         playkaboom.gg origins.
 *
 * Optional env:
 *   CRON_TICK_URL         If set, the relay polls this URL on a 60s
 *                         interval and forwards CRON_TICK_AUTH as the
 *                         Authorization header. This is the playkaboom.gg
 *                         /api/cron/index-events tickler — replaces the
 *                         GitHub-Actions cron schedule which fires every
 *                         1-3h on free tier. Railway containers run 24/7
 *                         so cadence is reliable.
 *   CRON_TICK_AUTH        Bearer token for the CRON_TICK_URL request.
 *                         For playkaboom.gg, this is the CRON_SECRET that
 *                         the /api/cron/index-events route validates.
 *   ALCHEMY_WS_URL        Full Alchemy Solana mainnet WS URL incl. API key.
 *                         When set with KABOOM_PROGRAM_ID + INGEST_URL +
 *                         INGEST_AUTH, the relay also runs an Alchemy
 *                         logsSubscribe push path that replaces the deleted
 *                         Helius enhanced-webhook. See ./alchemy-logs.ts.
 *   KABOOM_PROGRAM_ID     On-chain program ID for the logsSubscribe filter.
 *   INGEST_URL            POST endpoint that ingests one signature at a
 *                         time (the playkaboom.gg /api/ingest route).
 *   INGEST_AUTH           Bearer token for INGEST_URL — same value as
 *                         CRON_TICK_AUTH works; the route accepts either
 *                         CRON_SECRET or HELIUS_WEBHOOK_AUTH.
 */
import http from "node:http";
import { WebSocket as UpstreamWS, WebSocketServer, type WebSocket } from "ws";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { startAlchemyLogsSubscriber } from "./alchemy-logs.js";

const PORT = Number(process.env.PORT ?? 8080);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ??
  "https://playkaboom.gg,https://www.playkaboom.gg,http://localhost:3000"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!SUPABASE_URL) {
  console.error("[fatal] SUPABASE_URL is not set");
  process.exit(1);
}
if (!SUPABASE_ANON_KEY) {
  console.error("[fatal] SUPABASE_ANON_KEY is not set");
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
const wssRelay = new WebSocketServer({ noServer: true });
const wssProxy = new WebSocketServer({ noServer: true });

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
  if (isProxyPath && rpcProxyActive.size >= MAX_RPC_PROXY_CLIENTS) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  // Strip query/fragment so /rpc-ws?cluster=mainnet would also match.
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname === RPC_PROXY_PATH) {
    wssProxy.handleUpgrade(req, socket, head, (ws) => {
      handleRpcProxyConnection(ws);
    });
    return;
  }
  // Default: relay broadcast (existing behaviour).
  wssRelay.handleUpgrade(req, socket, head, (ws) => {
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
  upstream.on("message", (data, isBinary) => {
    if (client.readyState !== client.OPEN) return;
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
    for (const call of calls) {
      const method = (call as { method?: unknown })?.method;
      const id = (call as { id?: unknown })?.id;
      if (typeof method !== "string" || !WS_ALLOWED_METHODS.has(method)) {
        // Same posture as the HTTP proxy: an unknown or write method is
        // refused outright rather than forwarded and paid for.
        rpcError(id, -32601, "Method not allowed");
        return;
      }
    }

    const now = Date.now();
    tokens = Math.min(RPC_BURST, tokens + ((now - lastRefill) / 1000) * RPC_PER_SEC);
    lastRefill = now;
    if (tokens < calls.length) {
      rpcError((calls[0] as { id?: unknown })?.id, -32005, "Rate limit exceeded");
      return;
    }
    tokens -= calls.length;

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
        ws.send(payload);
      } catch {
        clients.delete(ws);
      }
    }
  }
};

// ── Upstream: Supabase Realtime postgres_changes ─────────────────────
//
// supabase-js maintains its own WS connection to Supabase, with built-
// in reconnect + heartbeats. We don't need to roll our own retry loop.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 10 } },
});

let channel: RealtimeChannel | null = null;

function startUpstream() {
  // SCOPE: Railway is the live-feed push path. Both INSERT (cashout/loss
  // row created with sentinel fairness fields) and UPDATE (server settle
  // sets mine_layout / mine_count / commitment / salt / settle_signature)
  // must be relayed — otherwise clients see a row stuck on "settle
  // pending" even after settle landed.
  //
  // 2026-05-11 fix: original code only listened on INSERT, so post-cashout
  // UPDATEs from the GameSettled handler never reached the live feed.
  // Players saw their win but the fairness fields stayed empty in real
  // time; only a 60s polling refresh eventually filled them.
  //
  // 2026-05-21 hardening: the games table is published with
  // `replica identity full`, so the postgres_changes payload carries
  // the ENTIRE row — including mine_layout + salt as soon as the
  // server-side GameSettled UPDATE writes them. Forwarding the raw row
  // would broadcast every player's fairness pre-image to anyone listening
  // on the public relay. We project to a closed allowlist of fields that
  // the UI actually consumes; the fairness pre-image is left for the
  // dedicated /verify endpoint (which reads chain-direct).
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
  const handler = (eventName: "game_inserted" | "game_updated") =>
    (payload: { new?: unknown; old?: unknown }) => {
      const data = pickSafeCols(payload.new ?? payload.old);
      if (!data) return;
      broadcast(
        JSON.stringify({
          // Legacy clients keyed on type==="game_settled" still receive
          // both events. Newer code can branch on insert vs update.
          type: "game_settled",
          event: eventName,
          data,
          ts: Date.now(),
        }),
      );
    };

  channel = supabase
    .channel("playkaboom-relay")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "games" },
      handler("game_inserted"),
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "games" },
      handler("game_updated"),
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        upstreamConnected = true;
        console.log("[upstream] subscribed to postgres_changes (INSERT+UPDATE)");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        upstreamConnected = false;
        console.warn("[upstream] status:", status, err?.message ?? "");
      }
    });
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
  if (channel) {
    void supabase.removeChannel(channel);
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
