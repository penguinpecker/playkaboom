"use client";
import { useMemo, useState } from "react";
import { formatEther, useAccount } from "@/lib/compat";
import { useLeaderboard, useGameCounter } from "@/hooks/useContracts";
import { useGameHistory } from "@/hooks/useGameHistory";

export default function LeaderboardPage() {
  const { address } = useAccount();
  const { data: leaders } = useLeaderboard();
  const { data: gameCount } = useGameCounter();
  const { history } = useGameHistory();
  const [tab, setTab] = useState("All-Time");

  const localStats = useMemo(() => {
    if (!history.length) return null;
    const myGames = address
      ? history.filter((g) => g.player.toLowerCase() === address.toLowerCase())
      : history;
    if (!myGames.length) return null;
    const wins = myGames.filter((g) => g.won);
    const losses = myGames.filter((g) => !g.won);
    return {
      gamesPlayed: myGames.length,
      gamesWon: wins.length,
      winRate: myGames.length > 0 ? (wins.length / myGames.length) * 100 : 0,
      biggestWin: wins.length > 0 ? Math.max(...wins.map((g) => g.payout)) : 0,
      biggestMult: wins.length > 0 ? Math.max(...wins.map((g) => g.multiplier)) : 0,
      totalPnl:
        wins.reduce((s, g) => s + g.payout - g.bet, 0) -
        losses.reduce((s, g) => s + g.bet, 0),
    };
  }, [address, history]);

  const localLeaders = useMemo(() => {
    const playerMap = new Map<
      string,
      { gamesPlayed: number; biggestWin: number; biggestMult: number; totalWon: number }
    >();
    history.forEach((g) => {
      const key = g.player.toLowerCase();
      const e = playerMap.get(key) || {
        gamesPlayed: 0,
        biggestWin: 0,
        biggestMult: 0,
        totalWon: 0,
      };
      e.gamesPlayed++;
      if (g.won) {
        e.totalWon += g.payout;
        if (g.payout > e.biggestWin) e.biggestWin = g.payout;
        if (g.multiplier > e.biggestMult) e.biggestMult = g.multiplier;
      }
      playerMap.set(key, e);
    });
    return Array.from(playerMap.entries())
      .filter(([, s]) => s.biggestWin > 0)
      .sort((a, b) => b[1].totalWon - a[1].totalWon)
      .slice(0, 10);
  }, [history]);

  const recentWins = useMemo(() => history.filter((g) => g.won).slice(0, 4), [history]);
  const activePlayers = useMemo(
    () => new Set(history.map((g) => g.player.toLowerCase())).size,
    [history],
  );
  const hasChainLeaders = leaders.length > 0;

  return (
    <div className="px-6 lg:px-8 pb-16 min-h-screen">
      <div className="flex justify-between items-end mb-8">
        <div>
          <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-1 mb-1">
            <span className="status-dot" />SYSTEM_NODE:{" "}
            {address ? address.slice(0, 10).toUpperCase() : "NOT_CONNECTED"}
          </p>
          <h1 className="font-headline text-4xl font-black italic tracking-tighter text-on-surface">
            GLOBAL <span className="text-primary italic">LEADERBOARD</span>
          </h1>
        </div>
        <div className="hidden lg:flex gap-4">
          <div className="bg-surface-container-high p-4 border-l-2 border-primary">
            <div className="font-headline text-[10px] tracking-widest text-on-surface-variant uppercase mb-1">
              Total PnL
            </div>
            <div
              className={`font-headline text-2xl font-bold ${localStats && localStats.totalPnl >= 0 ? "text-primary" : "text-error"}`}
            >
              {localStats
                ? (localStats.totalPnl >= 0 ? "+" : "") + localStats.totalPnl.toFixed(3)
                : "+0.000"}{" "}
              SOL
            </div>
          </div>
          <div className="bg-surface-container-high p-4 border-l-2 border-tertiary">
            <div className="font-headline text-[10px] tracking-widest text-on-surface-variant uppercase mb-1">
              Active Operators
            </div>
            <div className="font-headline text-2xl font-bold text-tertiary">
              {activePlayers || gameCount?.toString() || "0"}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2.5fr_1fr] gap-8">
        <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg overflow-hidden">
          <div className="flex justify-between items-center px-6 py-4 border-b border-outline-variant/10">
            <h2 className="font-headline text-sm font-bold tracking-widest text-on-surface uppercase flex items-center gap-2">
              <span className="material-symbols-outlined text-amber" style={{ fontSize: 20 }}>
                emoji_events
              </span>
              Top Operations
            </h2>
            <div className="flex gap-1">
              {["Daily", "Weekly", "All-Time"].map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1 font-headline text-[10px] font-bold tracking-widest transition-colors ${
                    t === tab
                      ? "bg-primary/10 text-primary border border-primary/15"
                      : "text-on-surface-variant/40 hover:text-on-surface"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-5 px-6 py-3 border-b border-outline-variant/10">
            {["Rank", "Operator Name", "Biggest Win", "Multiplier", "Status"].map((h, i) => (
              <span
                key={h}
                className={`font-headline text-[10px] tracking-widest text-on-surface-variant/40 uppercase ${i === 4 ? "text-right" : ""}`}
              >
                {h}
              </span>
            ))}
          </div>

          {hasChainLeaders ? null : localLeaders.length > 0 ? (
            localLeaders.map(([player, stats], i) => {
              const isMe = address && player.toLowerCase() === address.toLowerCase();
              return (
                <div
                  key={i}
                  className={`grid grid-cols-5 px-6 py-4 items-center border-b border-outline-variant/[0.04] ${isMe ? "bg-primary/5" : "hover:bg-surface-container-highest transition-colors"}`}
                >
                  <RankBadge rank={i + 1} />
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded bg-secondary/20 flex items-center justify-center font-headline text-[10px] font-bold text-secondary">
                      {player.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-headline text-xs font-bold text-on-surface">
                        {isMe ? "YOU" : player.slice(0, 8) + "…"}
                      </div>
                    </div>
                  </div>
                  <span className="font-headline text-sm font-bold text-primary">
                    {stats.biggestWin.toFixed(3)} SOL
                  </span>
                  <span className="font-headline text-sm font-bold text-secondary">
                    {stats.biggestMult.toFixed(1)}×
                  </span>
                  <span
                    className={`font-headline text-[10px] px-2 py-0.5 ${i === 0 ? "bg-tertiary/10 text-tertiary" : "bg-primary/10 text-primary"} tracking-widest w-fit ml-auto`}
                  >
                    {i === 0 ? "ELITE" : "ACTIVE"}
                  </span>
                </div>
              );
            })
          ) : (
            <div className="px-6 py-12 text-center text-on-surface-variant text-sm">
              No games played yet. Be the first operator!
            </div>
          )}
          <div className="px-6 py-4 text-center border-t border-outline-variant/10">
            <span className="font-headline text-[10px] text-on-surface-variant/40 tracking-widest uppercase">
              Indexer-backed global leaderboard ships in v0.2
            </span>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-outline-variant/10 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="status-dot" />
                <span className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase">
                  Live Operations
                </span>
              </div>
              <span className="font-headline text-[10px] text-on-surface-variant/40">TX MONITOR</span>
            </div>
            <div className="divide-y divide-outline-variant/5">
              {recentWins.length > 0 ? (
                recentWins.map((g) => (
                  <div key={`${g.gameId}-${g.timestamp}`} className="px-5 py-3">
                    <div className="flex justify-between items-start">
                      <div className="font-headline text-xs font-bold text-on-surface uppercase">
                        {g.player.slice(0, 8)}…
                      </div>
                      <span className="font-headline text-[10px] text-on-surface-variant/40">
                        {Math.max(1, Math.floor((Date.now() - g.timestamp) / 1000))}s ago
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="font-headline text-sm font-bold text-primary">
                        +{g.payout.toFixed(3)} SOL
                      </span>
                      <span className="px-2 py-0.5 bg-emerald/10 text-emerald font-headline text-[10px] font-bold">
                        {g.multiplier.toFixed(1)}×
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="px-5 py-6 text-center text-on-surface-variant/40 text-xs">
                  No wins yet
                </div>
              )}
            </div>
          </div>

          <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg p-5">
            <h3 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-4">
              Your Stats
            </h3>
            {localStats ? (
              <div className="space-y-3">
                <StatRow
                  label="Games Played"
                  value={localStats.gamesPlayed.toString()}
                  color="text-on-surface"
                />
                <StatRow
                  label="Games Won"
                  value={localStats.gamesWon.toString()}
                  color="text-secondary"
                />
                <StatRow
                  label="Win Rate"
                  value={localStats.winRate.toFixed(1) + "%"}
                  color="text-secondary"
                />
                <StatRow
                  label="Biggest Win"
                  value={localStats.biggestWin.toFixed(3) + " SOL"}
                  color="text-tertiary"
                />
                <StatRow
                  label="Best Mult"
                  value={localStats.biggestMult.toFixed(2) + "×"}
                  color="text-amber"
                />
                <StatRow
                  label="Total PnL"
                  value={
                    (localStats.totalPnl >= 0 ? "+" : "") +
                    localStats.totalPnl.toFixed(3) +
                    " SOL"
                  }
                  color={localStats.totalPnl >= 0 ? "text-primary" : "text-error"}
                />
              </div>
            ) : (
              <p className="text-sm text-on-surface-variant">
                {address ? "No games yet." : "Connect to see stats."}
              </p>
            )}
          </div>

          <div className="bg-gradient-to-br from-secondary-container/20 to-surface-container-high p-6 border border-secondary/10 rounded-lg">
            <h3 className="font-headline text-xl font-black italic text-on-surface mb-2">
              STEALTH REWARDS
            </h3>
            <p className="font-headline text-xs text-on-surface-variant uppercase tracking-widest mb-4 leading-relaxed">
              Compete for weekly pools. Top 10 operators receive elite ranking on-chain.
            </p>
            <button className="w-full py-3 bg-surface-container-highest border border-outline-variant/30 font-headline text-xs font-bold uppercase tracking-widest hover:border-primary transition-all">
              JOIN PROTOCOL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const cls =
    rank === 1
      ? "bg-amber/15 text-amber border-amber/30"
      : rank === 2
        ? "bg-on-surface-variant/10 text-on-surface-variant border-on-surface-variant/20"
        : rank === 3
          ? "bg-tertiary/10 text-tertiary border-tertiary/20"
          : "bg-surface-container-highest text-on-surface-variant/50 border-outline-variant/10";
  return (
    <span
      className={`w-8 h-8 rounded-lg ${cls} border font-headline font-bold text-xs flex items-center justify-center`}
    >
      #{rank}
    </span>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-outline-variant/[0.05]">
      <span className="text-xs text-on-surface-variant/50">{label}</span>
      <span className={`text-xs font-bold ${color}`}>{value}</span>
    </div>
  );
}
