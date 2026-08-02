"use client";
import { useCallback, useEffect, useState } from "react";

type Health = "operational" | "degraded" | "down" | "unknown";

interface Component {
  id: string;
  label: string;
  status: Health;
  latencyMs: number | null;
  detail: string;
  meta?: Record<string, string | number | boolean | null>;
}

interface StatusPayload {
  overall: Health;
  checkedAt: string;
  components: Component[];
}

const TONE: Record<Health, { dot: string; text: string; ring: string }> = {
  operational: { dot: "bg-emerald-400", text: "text-emerald-400", ring: "ring-emerald-400/30" },
  degraded: { dot: "bg-amber-400", text: "text-amber-400", ring: "ring-amber-400/30" },
  down: { dot: "bg-rose-500", text: "text-rose-500", ring: "ring-rose-500/30" },
  unknown: { dot: "bg-zinc-500", text: "text-zinc-400", ring: "ring-zinc-500/30" },
};

const HEADLINE: Record<Health, string> = {
  operational: "All systems operational",
  degraded: "Partially degraded",
  down: "Major outage",
  unknown: "Status unknown",
};

/** What each component means for a player, in plain terms. */
const EXPLAIN: Record<string, string> = {
  "solana-rpc": "Our connection to Solana mainnet. If this is down, nothing can be played or settled.",
  program: "The on-chain program that holds the bankroll and decides every game. Immutable game logic.",
  vault: "The bankroll backing payouts, and how much of it is uncommitted. Play halts below the health floor.",
  "vrf-gate": "Per-click randomness drawn on a MagicBlock rollup. When off, games use commit-reveal instead.",
  magicblock: "The rollup where each tile flip is drawn and signed, without a wallet popup per click.",
  database: "The mirror that powers the activity feed, leaderboard and profiles. Never holds funds.",
  indexer: "Whether the mirror behind the feed and leaderboard is still running. It never holds funds — lag affects display only.",
  "stuck-capital":
    "Bankroll reserved by games nobody finished. It is not lost — it just cannot back new bets until released. Abandoned rounds are swept automatically after 24h.",
  realtime: "Pushes live results to open browsers. When down, the feed polls instead — slower, not broken.",
};

export default function StatusClient() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as StatusPayload);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const i = setInterval(load, 15_000);
    return () => clearInterval(i);
  }, [load]);

  const tone = TONE[data?.overall ?? "unknown"];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 px-5 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-10">
          <a
            href="https://playkaboom.gg"
            className="text-xs uppercase tracking-[0.2em] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            playkaboom.gg
          </a>
          <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight">Protocol status</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Live health of every system the game depends on. Checked directly against Solana mainnet
            and the MagicBlock rollup on each load — nothing here is cached longer than 10 seconds.
          </p>
        </header>

        <section
          className={`rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 ring-1 ${tone.ring} mb-8`}
        >
          <div className="flex items-center gap-3">
            <span className={`inline-block h-3 w-3 rounded-full ${tone.dot} ${data ? "animate-pulse" : ""}`} />
            <span className={`text-lg font-medium ${tone.text}`}>
              {loading && !data ? "Checking…" : HEADLINE[data?.overall ?? "unknown"]}
            </span>
          </div>
          {data && (
            <p className="mt-2 text-xs text-zinc-500">
              Last checked {new Date(data.checkedAt).toLocaleString()} · refreshes every 15s
            </p>
          )}
          {error && <p className="mt-2 text-xs text-rose-400">Status probe failed: {error}</p>}
        </section>

        <div className="space-y-3">
          {(data?.components ?? []).map((c) => {
            const t = TONE[c.status];
            return (
              <article
                key={c.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 transition-colors hover:border-zinc-700"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
                      <h2 className="font-medium text-zinc-100">{c.label}</h2>
                    </div>
                    <p className="mt-1 text-sm text-zinc-400">{c.detail}</p>
                    {EXPLAIN[c.id] && (
                      <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{EXPLAIN[c.id]}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={`text-xs font-medium uppercase tracking-wide ${t.text}`}>
                      {c.status}
                    </div>
                    {c.latencyMs !== null && (
                      <div className="mt-0.5 text-xs tabular-nums text-zinc-600">{c.latencyMs} ms</div>
                    )}
                  </div>
                </div>
                {c.meta && Object.keys(c.meta).length > 0 && (
                  <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-zinc-800/70 pt-3 text-xs">
                    {Object.entries(c.meta)
                      .filter(([, v]) => v !== null && v !== undefined)
                      .map(([k, v]) => (
                        <div key={k} className="flex gap-1.5">
                          <dt className="text-zinc-600">{k}</dt>
                          <dd className="tabular-nums text-zinc-400 break-all">{String(v)}</dd>
                        </div>
                      ))}
                  </dl>
                )}
              </article>
            );
          })}
        </div>

        <footer className="mt-10 border-t border-zinc-800 pt-6 text-xs leading-relaxed text-zinc-500">
          <p>
            Every game is settled on Solana mainnet and independently verifiable. A degraded
            indexer or realtime relay affects only how quickly results appear on the site — it
            never affects your balance, a payout already made, or your ability to recover a bet.
          </p>
          <p className="mt-3">
            Machine-readable at{" "}
            <a href="/api/status" className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
              /api/status
            </a>
            .
          </p>
        </footer>
      </div>
    </main>
  );
}
