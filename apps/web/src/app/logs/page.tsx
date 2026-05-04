"use client";
import { useMemo, useState } from "react";
import { useHistoryStore } from "@/stores/history-store";
import { txExplorer } from "@/lib/cluster";

export default function LogsPage() {
  const { history, clear } = useHistoryStore();
  const [filter, setFilter] = useState<"all" | "wins">("all");
  const [page, setPage] = useState(1);
  const perPage = 15;

  const filtered = useMemo(
    () => (filter === "wins" ? history.filter((g) => g.won) : history),
    [history, filter],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const paged = filtered.slice((page - 1) * perPage, page * perPage);

  const stats = useMemo(() => {
    const wins = history.filter((g) => g.won);
    const losses = history.filter((g) => !g.won);
    const pnl = wins.reduce((s, g) => s + g.payout - g.bet, 0) - losses.reduce((s, g) => s + g.bet, 0);
    return {
      pnl,
      winRate: history.length > 0 ? (wins.length / history.length) * 100 : 0,
      avgMult: wins.length > 0 ? wins.reduce((s, g) => s + g.multiplier, 0) / wins.length : 0,
    };
  }, [history]);

  return (
    <div className="min-h-screen px-6 pb-16 lg:px-8">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="mb-2 font-headline text-5xl font-black italic tracking-tighter">COMBAT LOG</h1>
          <p className="max-w-lg font-body text-sm text-on-surface-variant">
            All engagements with on-chain tx links.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setFilter("all");
              setPage(1);
            }}
            className={`px-4 py-2 font-headline text-[10px] font-bold tracking-widest transition-colors ${
              filter === "all"
                ? "border border-primary/15 bg-primary/10 text-primary"
                : "text-on-surface-variant/40 hover:text-on-surface"
            }`}
          >
            ALL
          </button>
          <button
            type="button"
            onClick={() => {
              setFilter("wins");
              setPage(1);
            }}
            className={`px-4 py-2 font-headline text-[10px] font-bold tracking-widest transition-colors ${
              filter === "wins"
                ? "border border-primary/15 bg-primary/10 text-primary"
                : "text-on-surface-variant/40 hover:text-on-surface"
            }`}
          >
            WINS
          </button>
        </div>
      </div>

      <div className="mb-8 grid grid-cols-3 gap-6">
        <Stat label="PNL" value={`${stats.pnl.toFixed(3)} SOL`} color={stats.pnl >= 0 ? "text-primary" : "text-error"} />
        <Stat label="Win rate" value={`${stats.winRate.toFixed(1)}%`} color="text-secondary" />
        <Stat label="Avg mult" value={`${stats.avgMult.toFixed(2)}×`} color="text-tertiary" />
      </div>

      <div className="overflow-hidden rounded border border-outline-variant/10 bg-surface-container-low">
        <div className="grid grid-cols-6 border-b border-outline-variant/10 bg-surface-container-high px-6 py-4 font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/60">
          <span>ID</span>
          <span>Bet</span>
          <span>Mult</span>
          <span>Result</span>
          <span>When</span>
          <span className="text-right">Tx</span>
        </div>
        {paged.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-on-surface-variant">No games yet.</div>
        ) : (
          paged.map((g) => (
            <div
              key={`${g.gameId}-${g.timestamp}`}
              className="grid grid-cols-6 items-center border-b border-outline-variant/[0.04] px-6 py-4 hover:bg-surface-container-highest"
            >
              <span className="font-mono text-xs">#{g.gameId.slice(-6)}</span>
              <span className="text-sm">{g.bet.toFixed(3)} SOL</span>
              <span className={g.won ? "text-primary" : "text-on-surface-variant"}>
                {g.won ? `${g.multiplier.toFixed(2)}×` : "0.00×"}
              </span>
              <span className={`text-sm font-bold ${g.won ? "text-primary" : "text-error"}`}>
                {g.won ? "+" : "-"}
                {(g.won ? g.payout : g.bet).toFixed(3)} SOL
              </span>
              <span className="text-xs text-on-surface-variant">
                {new Date(g.timestamp).toLocaleString()}
              </span>
              <span className="text-right">
                {g.txHash ? (
                  <a
                    href={txExplorer(g.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    view
                  </a>
                ) : (
                  <span className="text-on-surface-variant/30">—</span>
                )}
              </span>
            </div>
          ))
        )}
        <div className="flex items-center justify-between border-t border-outline-variant/10 px-6 py-4">
          <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40">
            {filtered.length} entries
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="h-8 w-8 disabled:opacity-20"
            >
              ‹
            </button>
            <span className="px-3 font-headline text-xs">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="h-8 w-8 disabled:opacity-20"
            >
              ›
            </button>
          </div>
        </div>
      </div>

      {history.length > 0 && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={clear}
            className="font-headline text-[10px] tracking-widest text-on-surface-variant/30 transition-colors hover:text-error"
          >
            CLEAR LOCAL CACHE
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded border border-outline-variant/10 bg-surface-container-low p-6">
      <div className="mb-1 font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className={`font-headline text-3xl font-bold ${color}`}>{value}</div>
    </div>
  );
}
