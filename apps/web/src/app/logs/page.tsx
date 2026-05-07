"use client";
import { useMemo, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useAccount } from "@/lib/compat";
import { useGlobalGames, type GlobalGame } from "@/hooks/use-global-games";
import { useVaultMaxBet } from "@/hooks/useContracts";
import { txExplorer } from "@/lib/cluster";

type FilterMode = "all" | "mine" | "wins";

export default function LogsPage() {
  const { address } = useAccount();
  const { data: globalGames, isLoading, refetch, dataUpdatedAt } = useGlobalGames(200);
  const { data: maxBetLamports } = useVaultMaxBet();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [page, setPage] = useState(1);
  const perPage = 15;

  const filtered = useMemo(() => {
    const all = globalGames ?? [];
    if (filter === "wins") return all.filter((g) => g.outcome === "won");
    if (filter === "mine") return address ? all.filter((g) => g.player === address) : [];
    return all;
  }, [globalGames, filter, address]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const paged = filtered.slice((page - 1) * perPage, page * perPage);

  const stats = useMemo(() => {
    if (filtered.length === 0) {
      return { pnl: 0, winRate: 0, avgMult: 0, count: 0 };
    }
    let totalBet = 0n;
    let totalPayout = 0n;
    let wins = 0;
    let multSum = 0;
    for (const g of filtered) {
      totalBet += BigInt(g.bet);
      totalPayout += BigInt(g.payout);
      if (g.outcome === "won") {
        wins += 1;
        multSum += g.multiplierBps / 10_000;
      }
    }
    const pnlLamports = filter === "all"
      ? totalBet - totalPayout // house perspective
      : totalPayout - totalBet; // player perspective
    return {
      pnl: Number(pnlLamports) / LAMPORTS_PER_SOL,
      winRate: (wins / filtered.length) * 100,
      avgMult: wins > 0 ? multSum / wins : 0,
      count: filtered.length,
    };
  }, [filtered, filter]);

  const maxBet = maxBetLamports
    ? (Number(maxBetLamports) / LAMPORTS_PER_SOL).toFixed(4)
    : "—";

  const fmtSol = (lamportsStr: string) =>
    (Number(BigInt(lamportsStr)) / LAMPORTS_PER_SOL).toFixed(3);
  const fmtPlayer = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  const fmtTime = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
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

  const lastSync = dataUpdatedAt ? new Date(dataUpdatedAt) : null;
  const lastSyncStr = lastSync
    ? `${String(lastSync.getHours()).padStart(2, "0")}:${String(lastSync.getMinutes()).padStart(2, "0")}:${String(lastSync.getSeconds()).padStart(2, "0")}`
    : "—";

  return (
    <div className="px-6 lg:px-8 pb-16 min-h-screen">
      <div className="flex flex-wrap justify-between items-end mb-8 gap-4">
        <div>
          <h1 className="font-headline text-5xl font-black italic tracking-tighter text-on-surface mb-2">
            COMBAT LOG
          </h1>
          <p className="font-body text-sm text-on-surface-variant max-w-lg">
            Live archive of every settled game across all operators. Auto-refreshes every 8s
            from the on-chain indexer.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
              setFilter("mine");
              setPage(1);
            }}
            disabled={!address}
            className={`px-4 py-2 font-headline text-[10px] font-bold tracking-widest transition-colors ${filter === "mine" ? "bg-tertiary/10 text-tertiary border border-tertiary/15" : "text-on-surface-variant/40 hover:text-on-surface"} disabled:opacity-30 disabled:hover:text-on-surface-variant/40`}
          >
            MY GAMES
          </button>
          <button
            onClick={() => {
              setFilter("wins");
              setPage(1);
            }}
            className={`px-4 py-2 font-headline text-[10px] font-bold tracking-widest transition-colors ${filter === "wins" ? "bg-emerald/10 text-emerald border border-emerald/15" : "text-on-surface-variant/40 hover:text-on-surface"}`}
          >
            WINS ONLY
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2.5fr_1fr] gap-8 mb-8">
        <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <span className="status-dot bg-emerald" />
              <span className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase">
                {filter === "all"
                  ? "Global Analytics"
                  : filter === "mine"
                    ? "My Analytics"
                    : "Wins Analytics"}
              </span>
            </div>
            <span className="font-headline text-[10px] text-on-surface-variant/50 tracking-widest uppercase">
              Live · synced {lastSyncStr}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-8">
            <div>
              <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest block mb-1">
                {filter === "all" ? "Vault P&L" : "Net P&L"}
              </span>
              <span
                className={`font-headline text-3xl font-bold ${stats.pnl >= 0 ? "text-primary" : "text-error"}`}
              >
                {stats.pnl >= 0 ? "+" : ""}
                {stats.pnl.toFixed(4)} SOL
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
            onClick={() => void refetch()}
            className="w-full mt-4 py-2.5 bg-surface-container-highest border border-outline-variant/20 font-headline text-xs font-bold uppercase tracking-widest hover:border-primary transition-all"
          >
            Refresh Now
          </button>
        </div>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/10 rounded-lg overflow-hidden">
        <div className="grid grid-cols-7 px-6 py-4 border-b border-outline-variant/10 bg-surface-container-high">
          {["Operator", "Game", "Bet", "Multiplier", "Outcome", "Time", "Action"].map((h, i) => (
            <span
              key={h}
              className={`font-headline text-[10px] tracking-widest text-on-surface-variant/40 uppercase ${i === 6 ? "text-right" : ""}`}
            >
              {h}
            </span>
          ))}
        </div>

        {isLoading ? (
          <div className="px-6 py-12 text-center text-on-surface-variant text-sm">Loading…</div>
        ) : paged.length === 0 ? (
          <div className="px-6 py-12 text-center text-on-surface-variant text-sm">
            {filter === "mine"
              ? address
                ? "You haven't played any games yet."
                : "Connect your wallet to see your games."
              : "No settled games yet. Be the first operator!"}
          </div>
        ) : (
          paged.map((g: GlobalGame) => {
            const won = g.outcome === "won";
            const mult = won ? g.multiplierBps / 10_000 : 0;
            return (
              <div
                key={g.signature}
                className="grid grid-cols-7 px-6 py-4 items-center border-b border-outline-variant/[0.04] hover:bg-surface-container-highest transition-colors"
              >
                <span
                  className={`font-mono text-sm ${g.player === address ? "text-tertiary font-bold" : "text-on-surface"}`}
                >
                  {fmtPlayer(g.player)}
                </span>
                <span className="px-2 py-0.5 bg-primary/10 text-primary font-headline text-[10px] font-bold tracking-widest w-fit rounded">
                  MINES · {g.mineCount}
                </span>
                <span className="font-headline text-sm text-on-surface">
                  {fmtSol(g.bet)} SOL
                </span>
                <span
                  className={`font-headline text-sm font-bold ${won ? "text-primary" : "text-on-surface-variant"}`}
                >
                  {won ? mult.toFixed(2) : "0.00"}×
                </span>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`w-2 h-2 rounded-full ${won ? "bg-emerald" : "bg-error"}`}
                  />
                  <span
                    className={`font-headline text-sm font-bold ${won ? "text-primary" : "text-error"}`}
                  >
                    {won ? "+" : "−"}
                    {fmtSol(won ? g.payout : g.bet)} SOL
                  </span>
                </div>
                <span className="font-headline text-xs text-on-surface-variant">
                  {fmtTime(g.time)}
                </span>
                <div className="text-right flex justify-end gap-2">
                  <a
                    href={`/verify/${g.signature}`}
                    title="Verify provable fairness"
                    className="material-symbols-outlined text-on-surface-variant/40 hover:text-emerald transition-colors cursor-pointer"
                    style={{ fontSize: 18 }}
                  >
                    verified
                  </a>
                  <a
                    href={txExplorer(g.signature)}
                    target="_blank"
                    rel="noreferrer"
                    title="View on Solscan"
                    className="material-symbols-outlined text-on-surface-variant/40 hover:text-primary transition-colors cursor-pointer"
                    style={{ fontSize: 18 }}
                  >
                    open_in_new
                  </a>
                </div>
              </div>
            );
          })
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-4 border-t border-outline-variant/10">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
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
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="w-8 h-8 flex items-center justify-center font-headline text-[10px] text-on-surface-variant/30 disabled:opacity-20"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
