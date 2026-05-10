"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useAccount } from "@/lib/compat";
import { useGameCounter } from "@/hooks/useContracts";
import { useGameHistory } from "@/hooks/useGameHistory";
import { useLeaderboardOnchain, type LeaderboardView } from "@/hooks/use-leaderboard";
import { shortAddr } from "@/lib/format";

const TABS: { label: string; view: LeaderboardView }[] = [
  { label: "Top Wins", view: "alltime" },
  { label: "Volume", view: "volume" },
  { label: "Streak", view: "streak" },
];

export default function LeaderboardPage() {
  const { address } = useAccount();
  const { data: gameCount } = useGameCounter();
  const { history } = useGameHistory();
  const [tab, setTab] = useState<LeaderboardView>("alltime");
  const { data: chainRows = [] } = useLeaderboardOnchain(tab);
  const hasChain = chainRows.length > 0;

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

  return (
    <div className="px-3 sm:px-6 lg:px-8 pb-16 min-h-screen">
      <div className="flex justify-between items-end mb-6 sm:mb-8 pt-2 sm:pt-0">
        <div className="min-w-0">
          <p className="font-headline text-[9px] sm:text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-1 mb-1 truncate">
            <span className="status-dot flex-shrink-0" />SYSTEM_NODE:{" "}
            {address ? address.slice(0, 10).toUpperCase() : "NOT_CONNECTED"}
          </p>
          <h1 className="font-headline text-2xl sm:text-4xl font-black italic tracking-tighter text-on-surface leading-tight">
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

      <div className="grid grid-cols-1 lg:grid-cols-[2.5fr_1fr] gap-4 sm:gap-8">
        <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 px-4 sm:px-6 py-3 sm:py-4 border-b border-outline-variant/10">
            <h2 className="font-headline text-xs sm:text-sm font-bold tracking-widest text-on-surface uppercase flex items-center gap-2">
              <span className="material-symbols-outlined text-amber" style={{ fontSize: 18 }}>
                emoji_events
              </span>
              Top Operations
            </h2>
            <div className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.view}
                  onClick={() => setTab(t.view)}
                  className={`flex-1 sm:flex-none px-2 sm:px-3 py-1 font-headline text-[9px] sm:text-[10px] font-bold tracking-widest transition-colors ${
                    t.view === tab
                      ? "bg-primary/10 text-primary border border-primary/15"
                      : "text-on-surface-variant/40 hover:text-on-surface"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          {/* Desktop column headers — hidden on mobile (rows are self-labeled). */}
          <div className="hidden sm:grid grid-cols-5 px-6 py-3 border-b border-outline-variant/10">
            {(tab === "alltime"
              ? ["Rank", "Operator", "Biggest Win", "Biggest Loss", "Status"]
              : tab === "volume"
                ? ["Rank", "Operator", "Total Wagered", "Games", "Status"]
                : ["Rank", "Operator", "Best Streak", "Games Won", "Status"]
            ).map((h, i) => (
              <span
                key={h}
                className={`font-headline text-[10px] tracking-widest text-on-surface-variant/40 uppercase ${i === 4 ? "text-right" : ""}`}
              >
                {h}
              </span>
            ))}
          </div>

          {hasChain ? (
            chainRows.map((row, i) => {
              const isMe = address && row.player.toLowerCase() === address.toLowerCase();
              const cellA =
                tab === "alltime"
                  ? `${(("biggest_win" in row ? row.biggest_win : 0) / LAMPORTS_PER_SOL).toFixed(3)} SOL`
                  : tab === "volume"
                    ? `${(("total_wagered" in row ? row.total_wagered : 0) / LAMPORTS_PER_SOL).toFixed(3)} SOL`
                    : `${"best_streak" in row ? row.best_streak : 0}`;
              const cellB =
                tab === "alltime"
                  ? `${(("biggest_loss" in row ? Number(row.biggest_loss) : 0) / LAMPORTS_PER_SOL).toFixed(3)} SOL`
                  : tab === "volume"
                    ? `${"games_played" in row ? row.games_played : 0}`
                    : `${"games_won" in row ? row.games_won : 0}`;
              return (
                <Link
                  key={`${row.player}-${i}`}
                  href={`/profile/${row.player}`}
                  className={`flex sm:grid sm:grid-cols-5 px-4 sm:px-6 py-3 sm:py-4 items-center gap-3 border-b border-outline-variant/[0.04] ${isMe ? "bg-primary/5" : "hover:bg-surface-container-highest transition-colors"}`}
                >
                  <div className="flex-shrink-0">
                    <RankBadge rank={i + 1} />
                  </div>
                  <div className="flex items-center gap-2 sm:gap-3 flex-1 sm:flex-none min-w-0">
                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded bg-secondary/20 flex items-center justify-center font-headline text-[9px] sm:text-[10px] font-bold text-secondary flex-shrink-0">
                      {row.player.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="font-headline text-xs font-bold text-on-surface truncate">
                      {isMe ? "YOU" : shortAddr(row.player, 4, 3)}
                    </div>
                  </div>
                  <span className="font-headline text-xs sm:text-sm font-bold text-primary whitespace-nowrap">{cellA}</span>
                  <span
                    className={`hidden sm:inline font-headline text-sm font-bold ${tab === "alltime" ? "text-error" : "text-secondary"}`}
                  >
                    {cellB}
                  </span>
                  <span
                    className={`hidden sm:inline-block font-headline text-[10px] px-2 py-0.5 ${i === 0 ? "bg-tertiary/10 text-tertiary" : "bg-primary/10 text-primary"} tracking-widest w-fit ml-auto`}
                  >
                    {i === 0 ? "ELITE" : "ACTIVE"}
                  </span>
                </Link>
              );
            })
          ) : localLeaders.length > 0 ? (
            localLeaders.map(([player, stats], i) => {
              const isMe = address && player.toLowerCase() === address.toLowerCase();
              return (
                <div
                  key={i}
                  className={`flex sm:grid sm:grid-cols-5 px-4 sm:px-6 py-3 sm:py-4 items-center gap-3 border-b border-outline-variant/[0.04] ${isMe ? "bg-primary/5" : "hover:bg-surface-container-highest transition-colors"}`}
                >
                  <div className="flex-shrink-0">
                    <RankBadge rank={i + 1} />
                  </div>
                  <div className="flex items-center gap-2 sm:gap-3 flex-1 sm:flex-none min-w-0">
                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded bg-secondary/20 flex items-center justify-center font-headline text-[9px] sm:text-[10px] font-bold text-secondary flex-shrink-0">
                      {player.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="font-headline text-xs font-bold text-on-surface truncate">
                      {isMe ? "YOU" : player.slice(0, 6) + "…"}
                    </div>
                  </div>
                  <span className="font-headline text-xs sm:text-sm font-bold text-primary whitespace-nowrap">
                    {stats.biggestWin.toFixed(3)} SOL
                  </span>
                  <span className="hidden sm:inline font-headline text-sm font-bold text-secondary">
                    {stats.biggestMult.toFixed(1)}×
                  </span>
                  <span
                    className={`hidden sm:inline-block font-headline text-[10px] px-2 py-0.5 ${i === 0 ? "bg-tertiary/10 text-tertiary" : "bg-primary/10 text-primary"} tracking-widest w-fit ml-auto`}
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
              {hasChain
                ? "On-chain · indexed onchain"
                : "Indexer will populate after first settled game"}
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
