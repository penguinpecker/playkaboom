"use client";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

/**
 * Global live-feed of settled games. Two sources of freshness:
 *
 *   1. Supabase Realtime — push subscription on `public.games`. Inserts
 *      land in the cache within ~100ms of the indexer writing the row.
 *      This is the fast path that replaces the old 8-second poll.
 *
 *   2. TanStack refetchInterval @ 60s — a slow safety net that catches
 *      anything missed during a websocket reconnect / brief network blip.
 *      `refetchOnWindowFocus` + `refetchOnReconnect` cover mobile-tab
 *      suspension recovery (per the 2026-05-09 polling-fix commit).
 *
 * Falls back to pure polling if NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are
 * missing — the hook degrades gracefully rather than crashing the page.
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

  useEffect(() => {
    const sb = getSupabaseBrowser();
    if (!sb) return;
    const channel = sb
      .channel("global-games-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "games" },
        (payload) => {
          const incoming = rowToGame(payload.new as GamesRow);
          queryClient.setQueryData<GlobalGame[]>(queryKey, (prev) => {
            const list = prev ?? [];
            // Idempotency: ignore inserts that already landed via the
            // initial fetch (or a prior event). Indexer can replay rows
            // with the same signature when ?reset=1 fires.
            if (list.some((g) => g.signature === incoming.signature)) return list;
            return [incoming, ...list].slice(0, limit);
          });
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
