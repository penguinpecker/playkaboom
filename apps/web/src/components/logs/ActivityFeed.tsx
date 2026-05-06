"use client";
import { useEffect, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { apiActivity, type ActivityEvent } from "@/lib/api";
import { txExplorer } from "@/lib/cluster";

const ACTION_LABELS: Record<string, string> = {
  deposit: "LP Deposit",
  request_withdraw: "Withdraw Requested",
  cancel_withdraw: "Withdraw Cancelled",
  complete_withdraw: "Withdraw Completed",
  house_deposit: "House Deposit",
  house_request_withdraw: "House Withdraw Requested",
  house_cancel_withdraw: "House Withdraw Cancelled",
  house_complete_withdraw: "House Withdraw Completed",
};

const KIND_BADGE: Record<ActivityEvent["kind"], { label: string; color: string }> = {
  game: { label: "GAME", color: "bg-primary/10 text-primary border-primary/30" },
  lp: { label: "VAULT", color: "bg-emerald/10 text-emerald border-emerald/30" },
  ref_received: {
    label: "REFERRAL ▲",
    color: "bg-tertiary/10 text-tertiary border-tertiary/30",
  },
  ref_paid: { label: "REF (FROM YOU)", color: "bg-amber/10 text-amber border-amber/30" },
};

const fmtSol = (lamports: bigint | number | string | null | undefined) => {
  if (lamports == null) return "—";
  const n = typeof lamports === "bigint" ? Number(lamports) : Number(lamports);
  if (!Number.isFinite(n)) return "—";
  return (n / LAMPORTS_PER_SOL).toFixed(4) + " SOL";
};

const fmtSigned = (n: number) =>
  `${n >= 0 ? "+" : ""}${(n / LAMPORTS_PER_SOL).toFixed(4)} SOL`;

const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

function describe(ev: ActivityEvent): string {
  if (ev.kind === "game") {
    const g = ev.payload as {
      outcome?: string;
      bet?: number;
      payout?: number;
      multiplier_bps?: number;
    };
    if (g.outcome === "won") {
      const mult = g.multiplier_bps ? (g.multiplier_bps / 10_000).toFixed(2) + "×" : "—";
      return `Won ${fmtSol(g.payout)} (${mult} on ${fmtSol(g.bet)})`;
    }
    if (g.outcome === "lost") return `Lost ${fmtSol(g.bet)}`;
    return `${g.outcome ?? "game"} • bet ${fmtSol(g.bet)}`;
  }
  if (ev.kind === "lp") {
    const a = ev.payload as { action?: string; lamports_delta?: number };
    const label = ACTION_LABELS[a.action ?? ""] ?? a.action ?? "LP";
    if (a.lamports_delta != null && a.lamports_delta !== 0) {
      return `${label} • ${fmtSigned(a.lamports_delta)}`;
    }
    return label;
  }
  if (ev.kind === "ref_received") {
    const r = ev.payload as { amount?: number; tier?: number; player?: string };
    const tierName = ["Bronze", "Silver", "Gold"][r.tier ?? 0] ?? "—";
    return `Earned ${fmtSol(r.amount)} from ${(r.player ?? "").slice(0, 4)}…${(r.player ?? "").slice(-4)} (${tierName})`;
  }
  // ref_paid
  const r = ev.payload as { amount?: number; referrer?: string };
  return `Your wager paid ${fmtSol(r.amount)} to ${(r.referrer ?? "").slice(0, 4)}…${(r.referrer ?? "").slice(-4)}`;
}

type FilterKind = "all" | "game" | "lp" | "referral";

export function ActivityFeed() {
  const { wallets } = useWallets();
  const wallet = wallets[0]?.address;
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterKind>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiActivity(wallet)
      .then((r) => {
        if (!cancelled) setEvents(r.events);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load activity");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const filtered = events.filter((e) => {
    if (filter === "all") return true;
    if (filter === "game") return e.kind === "game";
    if (filter === "lp") return e.kind === "lp";
    if (filter === "referral") return e.kind === "ref_received" || e.kind === "ref_paid";
    return true;
  });

  return (
    <section className="bg-surface-container-low border border-outline-variant/10 rounded-lg p-6">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          <span className="status-dot bg-emerald" />
          <h2 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase">
            On-Chain Activity (vault + referrals + games)
          </h2>
        </div>
        <div className="flex gap-1">
          {(["all", "game", "lp", "referral"] as FilterKind[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 font-headline text-[10px] font-bold tracking-widest transition-colors ${filter === f ? "bg-primary/10 text-primary border border-primary/30" : "text-on-surface-variant/50 hover:text-on-surface"}`}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {!wallet && (
        <p className="font-mono text-xs text-on-surface-variant/60 italic">
          Connect a wallet to load on-chain activity.
        </p>
      )}
      {wallet && loading && (
        <p className="font-mono text-xs text-on-surface-variant/60 italic">Loading…</p>
      )}
      {wallet && error && (
        <p className="font-mono text-xs text-error/80">{error}</p>
      )}
      {wallet && !loading && !error && filtered.length === 0 && (
        <p className="font-mono text-xs text-on-surface-variant/60 italic">
          No activity yet. (Indexer polls every 5 min — recent on-chain actions
          may take a moment to appear.)
        </p>
      )}

      <div className="space-y-2 mt-4">
        {filtered.map((ev) => {
          const badge = KIND_BADGE[ev.kind];
          return (
            <div
              key={ev.signature + ev.kind}
              className="flex items-center justify-between gap-4 py-2 border-b border-outline-variant/[0.05] last:border-b-0"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span
                  className={`px-2 py-0.5 text-[9px] font-headline font-bold tracking-widest border rounded ${badge.color} flex-shrink-0`}
                >
                  {badge.label}
                </span>
                <div className="min-w-0">
                  <div className="font-mono text-xs text-on-surface truncate">
                    {describe(ev)}
                  </div>
                  <div className="font-mono text-[9px] text-on-surface-variant/40">
                    {fmtTime(ev.time)} · slot {ev.slot}
                  </div>
                </div>
              </div>
              <a
                href={txExplorer(ev.signature)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[9px] text-primary/60 hover:text-primary flex-shrink-0"
              >
                {ev.signature.slice(0, 6)}…{ev.signature.slice(-4)}
              </a>
            </div>
          );
        })}
      </div>
    </section>
  );
}
