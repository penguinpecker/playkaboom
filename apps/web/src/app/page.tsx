"use client";
import Link from "next/link";
import { useVault } from "@/hooks/use-vault";
import { useHistoryStore } from "@/stores/history-store";

export default function HomePage() {
  const { data: vault } = useVault();
  const history = useHistoryStore((s) => s.history);
  const recent = history.slice(0, 4);

  return (
    <>
      <section className="kinetic-grid relative flex min-h-[860px] items-center justify-center overflow-hidden">
        <div className="container relative z-10 mx-auto flex flex-col items-center px-6 text-center">
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-outline-variant/15 bg-surface-container-high px-4 py-1">
            <span className="status-dot" />
            <span className="font-headline text-[10px] uppercase tracking-[0.2em] text-on-surface-variant">
              System online
            </span>
          </div>
          <h1 className="mb-6 font-headline text-6xl font-black italic leading-none tracking-tighter text-on-surface md:text-8xl">
            PROVE <span className="text-primary">YOUR LUCK</span>
          </h1>
          <p className="mb-12 max-w-2xl font-body text-lg text-on-surface-variant">
            On-chain Mines on a 4×4 grid. Provably fair via SHA-256 commit-reveal. Settlement is
            atomic when you hit a mine — no stuck states.
          </p>
          <Link
            href="/play"
            className="group relative bg-gradient-to-br from-primary to-primary-container px-12 py-5 font-headline text-2xl font-black italic tracking-tighter text-on-primary transition-all hover:scale-105 active:scale-95"
          >
            <span className="relative z-10">ENGAGE NOW</span>
            <div className="absolute inset-0 bg-primary opacity-0 blur-xl transition-opacity group-hover:opacity-30" />
          </Link>
        </div>
      </section>

      <section className="border-y border-outline-variant/10 bg-surface-container-low py-6">
        <div className="container mx-auto flex flex-col items-center justify-between gap-6 px-12 md:flex-row">
          <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
            On-chain stats
          </span>
          <div className="flex gap-12">
            <Stat label="Vault" value={`${vault?.balanceSol.toFixed(2) ?? "—"} SOL`} color="text-primary" />
            <Stat label="Health" value={`${vault?.healthPct ?? "—"}%`} color="text-emerald" />
            <Stat
              label="Total games"
              value={`${vault?.config?.totalGames.toString() ?? "0"}`}
              color="text-secondary"
            />
            <Stat
              label="Total wagered"
              value={`${vault ? Number(vault.config?.totalWagered ?? 0n) / 1e9 : 0} SOL`}
              color="text-tertiary"
            />
          </div>
        </div>
      </section>

      {recent.length > 0 && (
        <section className="container mx-auto px-12 py-24">
          <h2 className="mb-8 border-l-4 border-primary pl-6 font-headline text-2xl font-black italic tracking-tight text-on-surface">
            RECENT
          </h2>
          <div className="rounded border border-outline-variant/10 bg-surface-container-low">
            <div className="grid grid-cols-4 bg-surface-container-high px-6 py-4 font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
              <span>Player</span>
              <span>Mode</span>
              <span>Mult</span>
              <span className="text-right">Result</span>
            </div>
            {recent.map((g) => (
              <div
                key={`${g.gameId}-${g.timestamp}`}
                className="grid grid-cols-4 px-6 py-4 text-sm hover:bg-surface-container-highest"
              >
                <span className="font-mono text-xs text-on-surface">
                  {g.player.slice(0, 6)}…{g.player.slice(-4)}
                </span>
                <span className="font-headline text-xs text-on-surface-variant">MINES (4×4)</span>
                <span className={g.won ? "text-primary" : "text-on-surface-variant"}>
                  ×{g.won ? g.multiplier.toFixed(2) : "0.00"}
                </span>
                <span
                  className={`text-right font-headline text-sm font-bold ${g.won ? "text-primary" : "text-error"}`}
                >
                  {g.won ? "+" : "-"}
                  {(g.won ? g.payout : g.bet).toFixed(3)} SOL
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </span>
      <span className={`font-headline text-2xl font-bold ${color}`}>{value}</span>
    </div>
  );
}
