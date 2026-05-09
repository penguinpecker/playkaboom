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
 */
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

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

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        clients: clients.size,
        upstream: upstreamConnected,
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
  // Origin gate so unrelated sites can't piggyback on our broadcast
  // and burn through our connection quota. The feed itself is public.
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
});

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
  channel = supabase
    .channel("playkaboom-relay")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "games" },
      (payload) => {
        broadcast(
          JSON.stringify({
            type: "game_settled",
            data: payload.new,
            ts: Date.now(),
          }),
        );
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "games" },
      (payload) => {
        broadcast(
          JSON.stringify({
            type: "game_updated",
            data: payload.new,
            ts: Date.now(),
          }),
        );
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "lp_actions" },
      (payload) => {
        broadcast(
          JSON.stringify({
            type: "lp_action",
            data: payload.new,
            ts: Date.now(),
          }),
        );
      },
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        upstreamConnected = true;
        console.log("[upstream] subscribed to postgres_changes");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        upstreamConnected = false;
        console.warn("[upstream] status:", status, err?.message ?? "");
      }
    });
}

startUpstream();

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
  if (channel) {
    void supabase.removeChannel(channel);
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
