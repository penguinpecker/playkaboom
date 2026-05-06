"use client";
import { useEffect, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

interface FeedEvent {
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

const fmtShort = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;
const fmtSol = (lamports: string) => {
  const n = Number(BigInt(lamports || "0")) / LAMPORTS_PER_SOL;
  if (n >= 1) return `${n.toFixed(2)} SOL`;
  if (n >= 0.001) return `${n.toFixed(3)} SOL`;
  return `${n.toFixed(4)} SOL`;
};
const fmtAgo = (iso: string | null) => {
  if (!iso) return "now";
  const sec = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (sec < 5) return "now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};

interface Props {
  /** Max rows to display. Defaults to 8 (compact); 12+ for hero/dashboard slots. */
  limit?: number;
  /** Optional class wrapping the section card. */
  className?: string;
  /** Heading shown at the top. Hide with empty string. */
  title?: string;
  /** Polling cadence in ms. 8s default keeps server load low while feeling live. */
  refreshMs?: number;
}

/**
 * Stake-style global activity ticker. Polls /api/activity/global every
 * `refreshMs` and renders a grid of recent settled games — short wallet,
 * outcome chip, bet, payout (or loss), multiplier, time-ago.
 *
 * Wins glow primary, losses dim to error. New rows fade in. Single column on
 * mobile, two columns on tablet, four on desktop — always plays nice with
 * narrow viewports.
 */
export function GlobalActivityFeed({
  limit = 16,
  className = "",
  title = "LIVE GAMES",
  refreshMs = 8_000,
}: Props) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchFeed = async () => {
      try {
        const res = await fetch(`/api/activity/global?limit=${limit}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { events: FeedEvent[] };
        if (!cancelled) {
          setEvents(data.events);
          setLoading(false);
        }
      } catch {
        // Silent — UI stays on last good data, retries next tick.
      }
    };
    void fetchFeed();
    const i = setInterval(fetchFeed, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, [limit, refreshMs]);

  return (
    <section
      className={`bg-surface-container-low p-4 sm:p-6 stealth-card border border-outline-variant/10 ${className}`}
    >
      {title && (
        <div className="flex items-center justify-between mb-4">
          <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-2">
            <span className="status-dot bg-emerald" />
            {title}
          </p>
          <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/60">
            {events.length} recent
          </span>
        </div>
      )}
      {loading && events.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 bg-surface-container-lowest border border-outline-variant/5 animate-pulse"
            />
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="font-mono text-xs text-on-surface-variant/60 py-6 text-center">
          No games settled yet — be the first to play.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {events.map((e) => {
            const won = e.outcome === "won";
            const mult = e.multiplierBps / 10_000;
            return (
              <a
                key={e.signature}
                href={`/verify/${e.signature}`}
                className={`block bg-surface-container-lowest p-3 border border-outline-variant/5 hover:border-primary/30 transition-colors ${
                  won ? "hover:bg-primary/5" : "hover:bg-error/5"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-[10px] text-on-surface-variant">
                    {fmtShort(e.player)}
                  </span>
                  <span
                    className={`font-headline text-[9px] font-bold tracking-widest uppercase px-1.5 py-0.5 ${
                      won ? "bg-emerald/15 text-emerald" : "bg-error/15 text-error"
                    }`}
                  >
                    {won ? "WIN" : "LOSS"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span
                    className={`font-headline text-sm font-bold ${
                      won ? "text-emerald" : "text-error/80"
                    }`}
                  >
                    {won ? `+${fmtSol(e.payout)}` : `-${fmtSol(e.bet)}`}
                  </span>
                  {won && mult > 0 && (
                    <span className="font-headline text-[10px] text-primary">
                      ×{mult.toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-1 text-[10px] text-on-surface-variant/50">
                  <span>{e.mineCount} mines</span>
                  <span>{fmtAgo(e.time)}</span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
