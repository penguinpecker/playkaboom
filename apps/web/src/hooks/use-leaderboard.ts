"use client";
import { useQuery } from "@tanstack/react-query";

export type LeaderboardView = "alltime" | "volume" | "streak";

export interface AllTimeRow {
  player: string;
  games_played: number;
  games_won: number;
  win_rate_bps: number;
  total_wagered: number;
  total_payouts: number;
  biggest_win: number;
  biggest_multiplier_bps: number;
  best_streak: number;
  current_streak: number;
  last_played: string | null;
}

export interface VolumeRow {
  player: string;
  total_wagered: number;
  total_payouts: number;
  games_played: number;
  last_played: string | null;
}

export interface StreakRow {
  player: string;
  best_streak: number;
  current_streak: number;
  games_played: number;
  games_won: number;
  last_played: string | null;
}

export type LeaderboardRow = AllTimeRow | VolumeRow | StreakRow;

export function useLeaderboardOnchain(view: LeaderboardView) {
  return useQuery({
    queryKey: ["leaderboard", view],
    refetchInterval: 8_000,
    queryFn: async (): Promise<LeaderboardRow[]> => {
      const res = await fetch(`/api/leaderboard?view=${view}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows: LeaderboardRow[] };
      return json.rows ?? [];
    },
  });
}
