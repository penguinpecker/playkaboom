"use client";
import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

export interface GlobalGame {
  signature: string;
  player: string;
  outcome: "won" | "lost" | string;
  bet: string;
  payout: string;
  multiplierBps: number;
  mineCount: number;
  time: string | null;
  slot: number;
}

/** Shape of the `games` row projection the relay sends in `data`. */
interface GamesRow {
  signature: string;
  player: string;
  outcome: string;
  bet: string | number | null;
  payout: string | number | null;
  multiplier_bps: number | null;
  mine_count: number | null;
  settled_at: string | null;
  slot: number;
}

const rowToGame = (row: GamesRow): GlobalGame => ({
  signature: row.signature,
  player: row.player,
  outcome: row.outcome,
  bet: row.bet?.toString() ?? "0",
  payout: row.payout?.toString() ?? "0",
  multiplierBps: row.multiplier_bps ?? 0,
  mineCount: row.mine_count ?? 0,
  time: row.settled_at,
  slot: row.slot,
});

/** Idempotent setQueryData that prepends a new game iff its signature
 *  isn't already in the cache. Used by both push paths so they can
 *  fight to be first without ever creating duplicates. */
/** Insert OR update a game row in the cached list by signature. INSERTs go
 *  to the head; UPDATEs replace the existing row in-place. Both layers
 *  (relay WS + 60 s poll) feed this so the row updates as soon as the
 *  GameSettled UPDATE lands. */
function applyIncoming(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  game: GlobalGame,
  limit: number,
) {
  queryClient.setQueryData<GlobalGame[]>(queryKey, (prev) => {
    const list = prev ?? [];
    const idx = list.findIndex((g) => g.signature === game.signature);
    if (idx === -1) {
      // New row — prepend, clamp to limit.
      return [game, ...list].slice(0, limit);
    }
    // Existing row — replace in place so fairness fields (mine_layout,
    // mine_count, commitment, salt, settle_signature) appear live as soon
    // as the GameSettled UPDATE event arrives.
    const next = list.slice();
    next[idx] = game;
    return next;
  });
}

/**
 * Global live-feed of settled games. Two layers of freshness, from
 * fastest to most reliable:
 *
 *   1. Railway WebSocket relay (push) — set NEXT_PUBLIC_REALTIME_WS_URL
 *      to wss://<service>.up.railway.app. The relay LISTENs on the
 *      Postgres `kaboom_events` channel (one DB connection serves all
 *      viewers) and broadcasts each games INSERT/UPDATE over WS.
 *
 *   2. TanStack refetch @ 60s (safety-net poll via /api/activity/global)
 *      — covers relay outages and NOTIFYs lost while the relay was
 *      reconnecting. Also handles the cold-start snapshot.
 *      `refetchOnWindowFocus` + `refetchOnReconnect` cover mobile-tab
 *      suspension recovery.
 *
 * The browser has no direct database access. Both layers deliver into the
 * same TanStack cache; `applyIncoming` is signature-idempotent so they can
 * run in parallel without creating duplicates.
 */
export function useGlobalGames(limit = 200) {
  const queryClient = useQueryClient();
  const queryKey = ["global-games", limit] as const;

  const query = useQuery<GlobalGame[]>({
    queryKey,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async () => {
      const res = await fetch(`/api/activity/global?limit=${limit}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { events: GlobalGame[] };
      return json.events ?? [];
    },
  });

  // ── Layer 1: Railway WS relay ────────────────────────────────────
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_REALTIME_WS_URL;
    if (!url) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1_000;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        backoffMs = 1_000;
      };
      ws.onmessage = (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        const msg = parsed as { type?: string; data?: unknown };
        if (msg.type === "game_settled" && msg.data) {
          // Relay sends a fixed 12-column projection of the games row.
          applyIncoming(queryClient, queryKey, rowToGame(msg.data as GamesRow), limit);
        }
      };
      ws.onclose = () => {
        ws = null;
        scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* noop */
        }
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // Exponential backoff capped at 30s. Reset on successful open
      // so a brief network blip doesn't stretch into long reconnect
      // delays after recovery.
      reconnectTimer = setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  }, [limit, queryClient]);

  return query;
}
