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
import { WebSocketServer, type WebSocket } from "ws";
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
  const handler = (eventName: "game_inserted" | "game_updated") =>
    (payload: { new?: unknown; old?: unknown }) => {
      broadcast(
        JSON.stringify({
          // Legacy clients keyed on type==="game_settled" still receive
          // both events. Newer code can branch on insert vs update.
          type: "game_settled",
          event: eventName,
          data: payload.new ?? payload.old,
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
    const res = await fetch(CRON_TICK_URL, { method: "GET", headers });
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
  if (channel) {
    void supabase.removeChannel(channel);
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
