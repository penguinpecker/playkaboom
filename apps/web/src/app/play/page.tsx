"use client";
import { Grid } from "@/components/game/Grid";
import { BetControls } from "@/components/game/BetControls";
import { useGameStore } from "@/stores/game-store";
import { useVault } from "@/hooks/use-vault";

export default function PlayPage() {
  const sessionPnl = useGameStore((s) => s.sessionPnl);
  const sessionGames = useGameStore((s) => s.sessionGames);
  const { data: vault } = useVault();

  return (
    <div className="kinetic-grid min-h-screen px-6 pb-16 lg:px-8">
      <div className="mb-10 flex items-end justify-between">
        <div>
          <h1 className="mb-2 font-headline text-4xl font-black italic uppercase tracking-tighter">
            Tactical grid <span className="text-primary-container">v0.1</span>
          </h1>
          <p className="flex items-center gap-2 font-headline text-xs uppercase tracking-[0.3em] text-on-surface-variant">
            <span className="h-2 w-2 animate-pulse rounded-full bg-tertiary-container" />
            SYSTEM ACTIVE
          </p>
        </div>
        <div className="hidden gap-4 lg:flex">
          <KPI
            label="Session PnL"
            value={`${sessionPnl >= 0 ? "+" : ""}${sessionPnl.toFixed(3)} SOL`}
            color={sessionPnl >= 0 ? "text-primary" : "text-error"}
          />
          <KPI label="Games" value={sessionGames.toString()} color="text-secondary" />
          <KPI label="Vault" value={`${vault?.healthPct ?? "—"}%`} color="text-tertiary" />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-12 space-y-6 lg:col-span-4">
          <BetControls />
          <section className="stealth-card border border-outline-variant/10 bg-surface-container-low p-6">
            <h2 className="mb-4 font-headline text-xs font-bold uppercase tracking-widest text-on-surface">
              On-chain stats
            </h2>
            <Row label="Vault balance" value={`${vault?.balanceSol.toFixed(2) ?? "—"} SOL`} color="text-primary" />
            <Row label="Total games" value={`${vault?.config?.totalGames.toString() ?? "—"}`} color="text-secondary" />
            <Row label="Health" value={`${vault?.healthPct ?? "—"}%`} color="text-emerald" />
          </section>
        </div>
        <div className="col-span-12 lg:col-span-8">
          <Grid />
        </div>
      </div>
    </div>
  );
}

function KPI({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="stealth-card border-l-2 border-primary bg-surface-container-high p-4">
      <div className="mb-1 font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className={`font-headline text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between border-b border-outline-variant/10 py-2">
      <span className="font-headline text-[10px] text-on-surface-variant">{label}</span>
      <span className={`font-headline text-[10px] ${color}`}>{value}</span>
    </div>
  );
}
