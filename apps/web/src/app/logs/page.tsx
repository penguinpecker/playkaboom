"use client";
import { useMemo, useState } from "react";
import { formatEther, useAccount } from "@/lib/compat";
import { useGameHistory } from "@/hooks/useGameHistory";
import { useVaultMaxBet } from "@/hooks/useContracts";
import { txExplorer } from "@/lib/cluster";
import { ActivityFeed } from "@/components/logs/ActivityFeed";

export default function LogsPage() {
  useAccount();
  const { history, refresh, clearHistory } = useGameHistory();
  const { data: maxBetWei } = useVaultMaxBet();
  const [filter, setFilter] = useState<"all" | "wins">("all");
  const [page, setPage] = useState(1);
  const perPage = 15;

  const filtered = useMemo(
    () => (filter === "wins" ? history.filter((l) => l.won) : history),
    [history, filter],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const paged = filtered.slice((page - 1) * perPage, page * perPage);

  const stats = useMemo(() => {
    const wins = history.filter((g) => g.won);
    const losses = history.filter((g) => !g.won);
    const pnl =
      wins.reduce((s, g) => s + g.payout - g.bet, 0) -
      losses.reduce((s, g) => s + g.bet, 0);
    return {
      pnl,
      winRate: history.length > 0 ? (wins.length / history.length) * 100 : 0,
      avgMult:
        wins.length > 0 ? wins.reduce((s, g) => s + g.multiplier, 0) / wins.length : 0,
    };
  }, [history]);

  const maxBet = maxBetWei ? Number(formatEther(maxBetWei)).toFixed(4) : "0.1100";

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0") +
      " " +
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0") +
      ":" +
      String(d.getSeconds()).padStart(2, "0")
    );
  };

  return (
    <div className="px-6 lg:px-8 pb-16 min-h-screen">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="font-headline text-5xl font-black italic tracking-tighter text-on-surface mb-2">
            COMBAT LOG
          </h1>
          <p className="font-body text-sm text-on-surface-variant max-w-lg">
            Comprehensive archive of all tactical engagements. Cached locally with on-chain tx
            verification via Solana explorer.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setFilter("all");
              setPage(1);
            }}
            className={`px-4 py-2 font-headline text-[10px] font-bold tracking-widest transition-colors ${filter === "all" ? "bg-primary/10 text-primary border border-primary/15" : "text-on-surface-variant/40 hover:text-on-surface"}`}
          >
            ALL GAMES
          </button>
          <button
            onClick={() => {
              setFilter("wins");
              setPage(1);
            }}
            className={`px-4 py-2 font-headline text-[10px] font-bold tracking-widest transition-colors ${filter === "wins" ? "bg-primary/10 text-primary border border-primary/15" : "text-on-surface-variant/40 hover:text-on-surface"}`}
          >
            WINS ONLY
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2.5fr_1fr] gap-8 mb-8">
        <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg p-6">
          <div className="flex items-center gap-2 mb-6">
            <span className="status-dot" />
            <span className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase">
              Session Analytics
            </span>
          </div>
          <div className="grid grid-cols-3 gap-8">
            <div>
              <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest block mb-1">
                Total Profit
              </span>
              <span
                className={`font-headline text-3xl font-bold ${stats.pnl >= 0 ? "text-primary" : "text-error"}`}
              >
                {stats.pnl >= 0 ? "+" : ""}
                {stats.pnl.toFixed(3)} SOL
              </span>
              <div className="h-0.5 w-full bg-primary/20 mt-2">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.min(100, Math.abs(stats.pnl) * 200)}%` }}
                />
              </div>
            </div>
            <div>
              <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest block mb-1">
                Win Rate
              </span>
              <span className="font-headline text-3xl font-bold text-secondary">
                {stats.winRate.toFixed(1)}%
              </span>
              <div className="h-0.5 w-full bg-secondary/20 mt-2">
                <div
                  className="h-full bg-secondary transition-all"
                  style={{ width: `${stats.winRate}%` }}
                />
              </div>
            </div>
            <div>
              <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest block mb-1">
                Avg. Multiplier
              </span>
              <span className="font-headline text-3xl font-bold text-tertiary">
                {stats.avgMult.toFixed(2)}×
              </span>
              <div className="h-0.5 w-full bg-tertiary/20 mt-2">
                <div
                  className="h-full bg-tertiary transition-all"
                  style={{ width: `${Math.min(100, stats.avgMult * 10)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg p-6">
          <h3 className="font-headline text-sm font-bold tracking-widest text-on-surface uppercase mb-4">
            System Range
          </h3>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
                Min Bet
              </span>
              <span className="font-headline text-sm font-bold text-on-surface">0.001 SOL</span>
            </div>
            <div className="w-full h-1 bg-surface-container-highest rounded">
              <div className="h-full bg-primary rounded w-[10%]" />
            </div>
            <div className="flex justify-between items-center">
              <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
                Max Bet
              </span>
              <span className="font-headline text-sm font-bold text-on-surface">
                {maxBet} SOL
              </span>
            </div>
          </div>
          <button
            onClick={() => refresh()}
            className="w-full mt-4 py-2.5 bg-surface-container-highest border border-outline-variant/20 font-headline text-xs font-bold uppercase tracking-widest hover:border-primary transition-all"
          >
            Refresh Logs
          </button>
        </div>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg overflow-hidden">
        <div className="grid grid-cols-7 px-6 py-4 border-b border-outline-variant/10 bg-surface-container-high">
          {[
            "Event ID",
            "Game Type",
            "Bet Amount",
            "Multiplier",
            "Outcome",
            "Date/Time",
            "Action",
          ].map((h, i) => (
            <span
              key={h}
              className={`font-headline text-[10px] tracking-widest text-on-surface-variant/40 uppercase ${i === 6 ? "text-right" : ""}`}
            >
              {h}
            </span>
          ))}
        </div>

        {paged.length === 0 ? (
          <div className="px-6 py-12 text-center text-on-surface-variant text-sm">
            {history.length === 0 ? "No games played yet. Play a game to see logs." : "No matching games."}
          </div>
        ) : (
          paged.map((g) => (
            <div
              key={`${g.gameId}-${g.timestamp}`}
              className="grid grid-cols-7 px-6 py-4 items-center border-b border-outline-variant/[0.04] hover:bg-surface-container-highest transition-colors"
            >
              <span className="font-headline text-sm text-on-surface">#K-{g.gameId.slice(-6)}</span>
              <span className="px-2 py-0.5 bg-primary/10 text-primary font-headline text-[10px] font-bold tracking-widest w-fit rounded">
                MINES
              </span>
              <span className="font-headline text-sm text-on-surface">
                {g.bet.toFixed(3)} SOL
              </span>
              <span
                className={`font-headline text-sm font-bold ${g.won ? "text-primary" : "text-on-surface-variant"}`}
              >
                {g.won ? g.multiplier.toFixed(2) : "0.00"}×
              </span>
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${g.won ? "bg-emerald" : "bg-error"}`}
                />
                <span
                  className={`font-headline text-sm font-bold ${g.won ? "text-primary" : "text-error"}`}
                >
                  {g.won ? "+" : "-"}
                  {(g.won ? g.payout : g.bet).toFixed(3)} SOL
                </span>
              </div>
              <span className="font-headline text-xs text-on-surface-variant">
                {formatDate(g.timestamp)}
              </span>
              <div className="text-right flex justify-end gap-2">
                {g.txHash ? (
                  <>
                    <a
                      href={`/verify/${g.txHash}`}
                      title="Verify provable fairness"
                      className="material-symbols-outlined text-on-surface-variant/40 hover:text-emerald transition-colors cursor-pointer"
                      style={{ fontSize: 18 }}
                    >
                      verified
                    </a>
                    <a
                      href={txExplorer(g.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      title="View on Solscan"
                      className="material-symbols-outlined text-on-surface-variant/40 hover:text-primary transition-colors cursor-pointer"
                      style={{ fontSize: 18 }}
                    >
                      visibility
                    </a>
                  </>
                ) : (
                  <span className="text-on-surface-variant/20">—</span>
                )}
              </div>
            </div>
          ))
        )}

        <div className="px-6 py-4 flex justify-between items-center border-t border-outline-variant/10">
          <span className="font-headline text-[10px] text-on-surface-variant/40 uppercase tracking-widest">
            Showing {filtered.length > 0 ? (page - 1) * perPage + 1 : 0}-
            {Math.min(page * perPage, filtered.length)} of {filtered.length} deployments
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="w-8 h-8 flex items-center justify-center font-headline text-[10px] text-on-surface-variant/30 disabled:opacity-20"
            >
              ‹
            </button>
            {Array.from({ length: Math.min(totalPages, 5) }).map((_, i) => (
              <button
                key={i}
                onClick={() => setPage(i + 1)}
                className={`w-8 h-8 flex items-center justify-center font-headline text-xs font-bold transition-colors ${page === i + 1 ? "bg-primary/10 text-primary border border-primary/15" : "text-on-surface-variant/30 hover:text-on-surface"}`}
              >
                {i + 1}
              </button>
            ))}
            <button
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="w-8 h-8 flex items-center justify-center font-headline text-[10px] text-on-surface-variant/30 disabled:opacity-20"
            >
              ›
            </button>
          </div>
        </div>
      </div>

      {history.length > 0 && (
        <div className="mt-4 text-center">
          <button
            onClick={clearHistory}
            className="font-headline text-[10px] text-on-surface-variant/30 hover:text-error transition-colors tracking-widest"
          >
            CLEAR LOCAL CACHE
          </button>
        </div>
      )}

      <div className="mt-10">
        <ActivityFeed />
      </div>
    </div>
  );
}
