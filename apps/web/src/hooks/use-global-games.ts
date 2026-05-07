"use client";
import { useQuery } from "@tanstack/react-query";

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

/**
 * Fetches the global activity feed (every settled game across all
 * players). Polls every 8s so the /logs page feels live without
 * hammering Supabase. Server-side this hits the indexed `games`
 * table via /api/activity/global.
 */
export function useGlobalGames(limit = 200) {
  return useQuery<GlobalGame[]>({
    queryKey: ["global-games", limit],
    refetchInterval: 8_000,
    queryFn: async () => {
      const res = await fetch(`/api/activity/global?limit=${limit}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { events: GlobalGame[] };
      return json.events ?? [];
    },
  });
}
