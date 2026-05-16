import WebSocket from "ws";

/**
 * Alchemy Solana WS subscriber for program logs. Subscribes to
 * `logsSubscribe` with `{ mentions: [programId] }` filter at "confirmed"
 * commitment, then POSTs each signature to an internal ingest endpoint.
 *
 * Replaces the deleted Helius enhanced-webhook push path. Latency from
 * chain finalisation to ingest call: ~1-2s (Alchemy WS notify) + RPC fetch
 * inside the ingest endpoint. The 60s cron poll still runs as a safety net.
 *
 * Required env:
 *   ALCHEMY_WS_URL       Full Alchemy Solana mainnet WS URL incl. API key
 *                        (e.g. wss://solana-mainnet.g.alchemy.com/v2/<key>)
 *   KABOOM_PROGRAM_ID    On-chain program ID to filter logs for
 *   INGEST_URL           Full URL of the POST endpoint that consumes each
 *                        observed signature (e.g.
 *                        https://www.playkaboom.gg/api/ingest)
 *   INGEST_AUTH          Bearer token. Same value CRON_TICK_AUTH uses —
 *                        the /api/ingest endpoint accepts CRON_SECRET or
 *                        HELIUS_WEBHOOK_AUTH.
 *
 * If any of these are unset the subscriber stays silent and the cron-poll
 * fallback handles ingestion alone (degraded but correct).
 */

type SubscriberHandle = {
  isConnected: () => boolean;
  stop: () => void;
};

type LogsNotification = {
  jsonrpc: "2.0";
  method: "logsNotification";
  params: {
    result: {
      context: { slot: number };
      value: {
        signature: string;
        err: unknown;
        logs: string[] | null;
      };
    };
    subscription: number;
  };
};

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const RPC_TIMEOUT_MS = 10_000;
// Best-effort de-dup at the source: an Alchemy WS reconnect can replay the
// same notification, and we'd rather skip the POST than spam the endpoint.
// Authoritative dedup still happens in processed_events on the server.
const RECENT_SIG_CACHE = 256;

export function startAlchemyLogsSubscriber(): SubscriberHandle | null {
  const wsUrl = process.env.ALCHEMY_WS_URL;
  const programId = process.env.KABOOM_PROGRAM_ID;
  const ingestUrl = process.env.INGEST_URL;
  const ingestAuth = process.env.INGEST_AUTH;
  if (!wsUrl || !programId || !ingestUrl || !ingestAuth) {
    console.log(
      "[alchemy-logs] disabled — set ALCHEMY_WS_URL, KABOOM_PROGRAM_ID, INGEST_URL, INGEST_AUTH to enable",
    );
    return null;
  }

  let ws: WebSocket | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let connected = false;
  const recent = new Set<string>();
  const recentOrder: string[] = [];

  const remember = (sig: string): boolean => {
    if (recent.has(sig)) return false;
    recent.add(sig);
    recentOrder.push(sig);
    if (recentOrder.length > RECENT_SIG_CACHE) {
      const evicted = recentOrder.shift();
      if (evicted) recent.delete(evicted);
    }
    return true;
  };

  const postSignature = async (sig: string): Promise<void> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(ingestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingestAuth}`,
        },
        body: JSON.stringify({ signature: sig }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.warn(`[alchemy-logs] ingest POST failed: HTTP ${res.status} sig=${sig.slice(0, 8)}`);
      }
    } catch (e) {
      console.warn(
        `[alchemy-logs] ingest POST error: ${(e as Error).message} sig=${sig.slice(0, 8)}`,
      );
    } finally {
      clearTimeout(t);
    }
  };

  const connect = (): void => {
    if (stopped) return;
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      connected = true;
      reconnectAttempt = 0;
      const sub = {
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [programId] }, { commitment: "confirmed" }],
      };
      ws?.send(JSON.stringify(sub));
      console.log(`[alchemy-logs] connected, subscribing to logs for program ${programId}`);
    });

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const obj = msg as { method?: string };
      if (obj.method !== "logsNotification") return; // ignore sub-ack, errors
      const notif = msg as LogsNotification;
      const sig = notif.params?.result?.value?.signature;
      if (typeof sig !== "string" || sig.length < 64) return;
      if (!remember(sig)) return;
      void postSignature(sig);
    });

    ws.on("close", (code, reason) => {
      connected = false;
      const reasonStr = reason?.toString() || "(no reason)";
      if (!stopped) {
        const delay = Math.min(
          RECONNECT_CAP_MS,
          RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
        );
        reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
        console.warn(
          `[alchemy-logs] closed code=${code} reason=${reasonStr} reconnecting in ${delay}ms`,
        );
        setTimeout(connect, delay);
      }
    });

    ws.on("error", (err) => {
      console.warn(`[alchemy-logs] ws error: ${err.message}`);
      // close handler does the reconnect; don't double-schedule here.
    });
  };

  pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        /* close handler will reconnect */
      }
    }
  }, PING_INTERVAL_MS);

  connect();

  return {
    isConnected: () => connected,
    stop: () => {
      stopped = true;
      if (pingInterval) clearInterval(pingInterval);
      try {
        ws?.close(1001, "shutdown");
      } catch {
        /* noop */
      }
    },
  };
}
