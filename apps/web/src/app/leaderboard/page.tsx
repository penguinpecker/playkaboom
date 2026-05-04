"use client";
import { useMemo } from "react";
import { useHistoryStore } from "@/stores/history-store";
import { shortAddr } from "@/lib/format";

export default function LeaderboardPage() {
  const history = useHistoryStore((s) => s.history);

  const leaders = useMemo(() => {
    const map = new Map<
      string,
      { games: number; totalWon: number; biggestWin: number; biggestMult: number }
    >();
    for (const g of history) {
      const e = map.get(g.player) ?? { games: 0, totalWon: 0, biggestWin: 0, biggestMult: 0 };
      e.games += 1;
      if (g.won) {
        e.totalWon += g.payout;
        if (g.payout > e.biggestWin) e.biggestWin = g.payout;
        if (g.multiplier > e.biggestMult) e.biggestMult = g.multiplier;
      }
      map.set(g.player, e);
    }
    return Array.from(map.entries())
      .filter(([, s]) => s.biggestWin > 0)
      .sort((a, b) => b[1].totalWon - a[1].totalWon)
      .slice(0, 10);
  }, [history]);

  return (
    <div className="min-h-screen px-6 pb-16 lg:px-8">
      <h1 className="mb-8 font-headline text-4xl font-black italic tracking-tighter">
        GLOBAL <span className="text-primary italic">LEADERBOARD</span>
      </h1>
      <p className="mb-6 text-xs text-on-surface-variant/60">
        Currently sourced from this device&apos;s game history. Indexer-backed global leaderboard
        ships in v0.2.
      </p>
      <div className="overflow-hidden rounded border border-outline-variant/10 bg-surface-container-low">
        <div className="grid grid-cols-5 border-b border-outline-variant/10 px-6 py-3 font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/60">
          <span>Rank</span>
          <span>Player</span>
          <span>Biggest win</span>
          <span>Best mult</span>
          <span className="text-right">Total won</span>
        </div>
        {leaders.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-on-surface-variant">
            Play a game to seed the leaderboard.
          </div>
        ) : (
          leaders.map(([player, s], i) => (
            <div
              key={player}
              className="grid grid-cols-5 items-center border-b border-outline-variant/[0.04] px-6 py-4 hover:bg-surface-container-highest"
            >
              <span className="font-headline text-xs font-bold text-primary">#{i + 1}</span>
              <span className="font-mono text-xs">{shortAddr(player)}</span>
              <span className="font-headline text-sm font-bold text-primary">
                {s.biggestWin.toFixed(3)} SOL
              </span>
              <span className="font-headline text-sm font-bold text-secondary">
                {s.biggestMult.toFixed(1)}×
              </span>
              <span className="text-right font-headline text-sm font-bold text-primary">
                {s.totalWon.toFixed(3)} SOL
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
