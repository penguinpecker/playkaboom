"use client";
import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

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

/** Shape of a Postgres `games` row delivered via Realtime payload.new. */
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

/** Shape of a `game_settled` NOTIFY payload from the Railway relay.
 *  Keys come straight from the json_build_object in the trigger. */
interface GameSettledNotify {
  signature: string;
  player: string;
  outcome: string;
  bet: string;
  payout: string;
  multiplier_bps: number;
  mine_count: number;
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

const notifyToGame = (n: GameSettledNotify): GlobalGame => ({
  signature: n.signature,
  player: n.player,
  outcome: n.outcome,
  bet: n.bet,
  payout: n.payout,
  multiplierBps: n.multiplier_bps,
  mineCount: n.mine_count,
  time: n.settled_at,
  slot: n.slot,
});

/** Idempotent setQueryData that prepends a new game iff its signature
 *  isn't already in the cache. Used by both push paths so they can
 *  fight to be first without ever creating duplicates. */
function applyIncoming(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  game: GlobalGame,
  limit: number,
) {
  queryClient.setQueryData<GlobalGame[]>(queryKey, (prev) => {
    const list = prev ?? [];
    if (list.some((g) => g.signature === game.signature)) return list;
    return [game, ...list].slice(0, limit);
  });
}

/**
 * Global live-feed of settled games. Three layers of freshness, from
 * fastest to most reliable:
 *
 *   1. Railway WebSocket relay (primary push) — set
 *      NEXT_PUBLIC_REALTIME_WS_URL to wss://<service>.up.railway.app.
 *      The relay listens to Postgres NOTIFY on `game_settled` (one
 *      Postgres connection serves all viewers) and broadcasts each
 *      payload over WS. Latency ~100ms from indexer write to client.
 *
 *   2. Supabase Realtime (fallback push) — postgres_changes listener
 *      on `public.games`. Activated by the 2026-05-09 migration that
 *      adds the table to the supabase_realtime publication. Burns one
 *      Supabase connection per client, so it's the cheaper path until
 *      we outgrow the 200-connection free-tier ceiling.
 *
 *   3. TanStack refetch @ 60s (last-resort poll) — kicks in only when
 *      both push paths are unreachable. Also handles the cold-start
 *      "what was the feed before the websocket connected" snapshot.
 *      `refetchOnWindowFocus` + `refetchOnReconnect` cover mobile-tab
 *      suspension recovery.
 *
 * All three deliver into the same TanStack cache via setQueryData;
 * `applyIncoming` is signature-idempotent so the layers can run in
 * parallel without creating duplicates.
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
          applyIncoming(queryClient, queryKey, notifyToGame(msg.data as GameSettledNotify), limit);
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

  // ── Layer 2: Supabase Realtime fallback ──────────────────────────
  useEffect(() => {
    const sb = getSupabaseBrowser();
    if (!sb) return;
    const channel = sb
      .channel("global-games-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "games" },
        (payload) => {
          applyIncoming(queryClient, queryKey, rowToGame(payload.new as GamesRow), limit);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games" },
        (payload) => {
          const updated = rowToGame(payload.new as GamesRow);
          queryClient.setQueryData<GlobalGame[]>(queryKey, (prev) => {
            if (!prev) return prev;
            const idx = prev.findIndex((g) => g.signature === updated.signature);
            if (idx === -1) return prev;
            const next = prev.slice();
            next[idx] = updated;
            return next;
          });
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [limit, queryClient]);

  return query;
}
