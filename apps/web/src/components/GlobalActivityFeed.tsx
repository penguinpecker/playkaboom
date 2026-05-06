"use client";
import { useEffect, useRef, useState } from "react";
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
  if (n >= 1) return `${n.toFixed(3)}`;
  if (n >= 0.001) return `${n.toFixed(4)}`;
  return `${n.toFixed(5)}`;
};
const fmtAgo = (iso: string | null) => {
  if (!iso) return "now";
  const sec = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};

interface Props {
  /** Max rows to fetch + display. */
  limit?: number;
  /** Optional class wrapping the section card. */
  className?: string;
  /** Heading shown at the top. Hide with empty string. */
  title?: string;
  /** Polling cadence in ms. 5s default — fast enough to feel live, slow enough
   *  not to hammer the API. */
  refreshMs?: number;
  /** Fixed pixel height of the scroll viewport. Default 480 (~10 rows). */
  maxHeight?: number;
}

/**
 * Stake-style global activity ticker. Polls /api/activity/global every
 * `refreshMs` and renders a single scrollable column of sentence-style
 * rows: "5pc1Y…CsD2 won 0.0234 SOL · 4 mines · ×2.34 — 12s ago".
 *
 * Wins are emerald, losses are dim error. New rows fade-in (CSS animation).
 * The scroll viewport is fixed-height with overflow — long lists scroll
 * inside the card without pushing the layout. The time-ago labels tick
 * every 1s independently of the data refresh so "12s ago" walks up to
 * "13s ago" without waiting for the next poll.
 */
export function GlobalActivityFeed({
  limit = 30,
  className = "",
  title = "LIVE GAMES",
  refreshMs = 5_000,
  maxHeight = 480,
}: Props) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  // Forces fmtAgo to recompute every second even when `events` is unchanged,
  // so the visible "Xs ago" label keeps walking forward in real time.
  const [, setTick] = useState(0);
  // Track the highest slot we've already seen so we can tag fresh rows for
  // the fade-in animation. A ref keeps re-renders out of the inner-loop.
  const highestSlotRef = useRef(0);

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

  // Tick once per second so relative-time labels update without waiting on
  // a server poll. Cheap — a single re-render of this component.
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(i);
  }, []);

  return (
    <section
      className={`bg-surface-container-low rounded-lg border border-outline-variant/10 overflow-hidden ${className}`}
    >
      {title && (
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-outline-variant/10">
          <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-2">
            <span className="status-dot bg-emerald" />
            {title}
          </p>
          <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/60">
            {events.length} recent · auto-refresh
          </span>
        </div>
      )}
      {/* Header row mirrors the home-page REAL-TIME INTEL columns so the
          two feeds feel like the same surface. Hidden on mobile where
          we drop the table layout for a stacked card. */}
      <div className="hidden sm:grid grid-cols-12 px-6 py-4 bg-surface-container-high font-headline text-[10px] uppercase tracking-widest text-on-surface-variant gap-4">
        <span className="col-span-3">Operative</span>
        <span className="col-span-3">Module</span>
        <span className="col-span-2">Multiplier</span>
        <span className="col-span-2 text-right">Result</span>
        <span className="col-span-2 text-right">Time</span>
      </div>
      {loading && events.length === 0 ? (
        <div className="p-4 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-12 bg-surface-container-lowest border border-outline-variant/5 animate-pulse"
            />
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="font-mono text-xs text-on-surface-variant/60 py-12 text-center">
          No games settled yet — be the first to play.
        </p>
      ) : (
        <div
          className="overflow-y-auto divide-y divide-outline-variant/5 feed-scroll"
          style={{ maxHeight }}
        >
          {events.map((e) => {
            const won = e.outcome === "won";
            const mult = e.multiplierBps / 10_000;
            const isNew = e.slot > highestSlotRef.current;
            // Update the high-water mark only after we've decided whether
            // *this* row is fresh, so subsequent rows in the same render
            // don't all get classed as new.
            if (e.slot > highestSlotRef.current) highestSlotRef.current = e.slot;
            const initials = e.player.slice(0, 2).toUpperCase();
            return (
              <a
                key={e.signature}
                href={`/verify/${e.signature}`}
                className={`block hover:bg-surface-container-highest transition-colors ${
                  isNew ? "animate-feed-row-in" : ""
                }`}
              >
                {/* Desktop / tablet: 5-column grid matching REAL-TIME INTEL */}
                <div className="hidden sm:grid grid-cols-12 px-6 py-4 items-center gap-4">
                  <div className="col-span-3 flex items-center gap-2 min-w-0">
                    <div
                      className={`w-6 h-6 rounded shrink-0 flex items-center justify-center font-headline text-[8px] font-bold ${
                        won ? "bg-primary/20 text-primary" : "bg-error/20 text-error"
                      }`}
                    >
                      {initials}
                    </div>
                    <span className="font-body text-sm text-on-surface truncate">
                      {fmtShort(e.player)}
                    </span>
                  </div>
                  <span className="col-span-3 font-headline text-xs text-on-surface-variant">
                    MINES (4×4) · {e.mineCount} BOMB{e.mineCount === 1 ? "" : "S"}
                  </span>
                  <span
                    className={`col-span-2 font-headline text-sm font-bold ${
                      won && mult > 0 ? "text-primary" : "text-on-surface-variant/50"
                    }`}
                  >
                    ×{won && mult > 0 ? mult.toFixed(2) : "0.00"}
                  </span>
                  <span
                    className={`col-span-2 font-headline text-sm font-bold text-right ${
                      won ? "text-primary" : "text-error"
                    }`}
                  >
                    {won ? "+" : "−"}
                    {fmtSol(won ? e.payout : e.bet)} SOL
                  </span>
                  <span className="col-span-2 font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/50 text-right">
                    {fmtAgo(e.time)}
                  </span>
                </div>
                {/* Mobile: stacked card preserving the same data */}
                <div className="sm:hidden px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className={`w-5 h-5 rounded shrink-0 flex items-center justify-center font-headline text-[8px] font-bold ${
                          won ? "bg-primary/20 text-primary" : "bg-error/20 text-error"
                        }`}
                      >
                        {initials}
                      </div>
                      <span className="font-body text-sm text-on-surface truncate">
                        {fmtShort(e.player)}
                      </span>
                    </div>
                    <span
                      className={`font-headline text-sm font-bold ${
                        won ? "text-primary" : "text-error"
                      }`}
                    >
                      {won ? "+" : "−"}
                      {fmtSol(won ? e.payout : e.bet)} SOL
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-on-surface-variant/50 font-headline">
                    <span>
                      {e.mineCount} BOMB{e.mineCount === 1 ? "" : "S"}
                      {won && mult > 0 && (
                        <span className="text-primary ml-2">×{mult.toFixed(2)}</span>
                      )}
                    </span>
                    <span>{fmtAgo(e.time)}</span>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}
      <style jsx>{`
        @keyframes feed-row-in {
          from {
            opacity: 0;
            transform: translateY(-6px);
            background-color: rgba(164, 201, 255, 0.08);
          }
          to {
            opacity: 1;
            transform: translateY(0);
            background-color: transparent;
          }
        }
        .animate-feed-row-in {
          animation: feed-row-in 0.6s ease-out;
        }
        .feed-scroll::-webkit-scrollbar {
          width: 4px;
        }
        .feed-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .feed-scroll::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 2px;
        }
        .feed-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </section>
  );
}
