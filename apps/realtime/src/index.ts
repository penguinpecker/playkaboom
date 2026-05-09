/**
 * Live-feed WebSocket relay for playkaboom.gg.
 *
 * Subscribes to Postgres NOTIFY channels emitted by triggers on
 * public.games + public.lp_actions, and broadcasts each payload to
 * every connected browser client. Primary push path for the /logs
 * and /vault live feeds; the web client also subscribes to Supabase
 * Realtime as a fallback and polls at 60s as a last-resort safety net.
 *
 * Required env:
 *   DATABASE_URL       Postgres connection string (Supabase pooler 6543
 *                      or direct 5432 — direct preferred for LISTEN).
 *   PORT               Set automatically by Railway. Defaults to 8080.
 *   ALLOWED_ORIGINS    Comma-separated list. Defaults to the prod
 *                      playkaboom.gg origins.
 */
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import pg from "pg";

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

const PG_LISTEN_CHANNELS = ["game_settled", "lp_action"] as const;

const clients = new Set<WebSocket>();

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        clients: clients.size,
        pg: pgConnected,
        uptime_s: Math.round(process.uptime()),
      }),
    );
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({
  server: httpServer,
  // Origin gate so other sites can't piggyback the public broadcast.
  // The feed itself is public; this only blocks unrelated origins from
  // freeloading our connection quota.
  verifyClient: ({ origin }, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
      cb(true);
      return;
    }
    cb(false, 403, "origin not allowed");
  },
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  ws.send(
    JSON.stringify({
      type: "hello",
      clients: clients.size,
      ts: Date.now(),
    }),
  );
});

// WebSocket heartbeat — terminate clients that disappear without a
// proper close (mobile-tab kill, network drop). Browsers reply to
// pings automatically; clients that don't reply within 60s get
// reaped so we don't slowly accumulate dead sockets.
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

wss.on("connection", (ws) => {
  const live = ws as WebSocket & { isAlive?: boolean };
  live.isAlive = true;
  ws.on("pong", () => {
    live.isAlive = true;
  });
});

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

let pgClient: pg.Client | null = null;
let pgConnected = false;
let pgRetryDelay = 1_000;
const PG_RETRY_MAX = 30_000;

async function startPg() {
  pgClient = new pg.Client({
    connectionString: DATABASE_URL,
    // Supabase requires SSL; pooler uses self-signed so don't strictly verify.
    ssl: { rejectUnauthorized: false },
    keepAlive: true,
  });
  pgClient.on("notification", (msg) => {
    if (!msg.payload) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(msg.payload);
    } catch {
      console.warn("[pg] non-JSON payload on", msg.channel);
      return;
    }
    broadcast(
      JSON.stringify({
        type: msg.channel,
        data: parsed,
        ts: Date.now(),
      }),
    );
  });
  pgClient.on("error", (e) => {
    console.error("[pg] error", e.message);
  });
  pgClient.on("end", () => {
    console.warn("[pg] connection ended — reconnecting");
    pgConnected = false;
    pgClient = null;
    setTimeout(() => {
      void startPg().catch((e) => console.error("[pg] reconnect failed", e));
    }, pgRetryDelay);
    pgRetryDelay = Math.min(pgRetryDelay * 2, PG_RETRY_MAX);
  });
  try {
    await pgClient.connect();
    for (const ch of PG_LISTEN_CHANNELS) {
      await pgClient.query(`LISTEN ${ch}`);
    }
    pgConnected = true;
    pgRetryDelay = 1_000;
    console.log(`[pg] LISTEN ${PG_LISTEN_CHANNELS.join(", ")}`);
  } catch (e) {
    pgConnected = false;
    console.error("[pg] connect failed", (e as Error).message);
    setTimeout(() => {
      void startPg().catch((err) => console.error("[pg] retry failed", err));
    }, pgRetryDelay);
    pgRetryDelay = Math.min(pgRetryDelay * 2, PG_RETRY_MAX);
  }
}

void startPg();

httpServer.listen(PORT, () => {
  console.log(`[realtime] listening on :${PORT}`);
});

const shutdown = (sig: string) => {
  console.log(`[realtime] ${sig} — shutting down`);
  clearInterval(heartbeat);
  for (const ws of clients) {
    try {
      ws.close(1001, "server shutdown");
    } catch {
      /* noop */
    }
  }
  pgClient?.end().catch(() => undefined);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
