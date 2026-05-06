"use client";
import { Grid } from "@/components/game/Grid";
import { BetControls } from "@/components/game/BetControls";
import { StuckGameBanner } from "@/components/game/StuckGameBanner";
import { useGame } from "@/hooks/useGame";
import { useGameResume } from "@/hooks/use-game-resume";
import { useVaultBalance, useVaultHealth, useGameCounter } from "@/hooks/useContracts";
import { CLUSTER, CLUSTER_LABEL } from "@/lib/cluster";

export default function PlayPage() {
  // Auto-recover an in-flight game from any device on mount.
  const stuckInfo = useGameResume();
  const { state } = useGame();
  const { data: vaultBal } = useVaultBalance();
  const { data: vaultHealth } = useVaultHealth();
  const { data: gameCount } = useGameCounter();
  return (
    <div className="px-6 lg:px-8 pb-16 min-h-screen kinetic-grid">
      <div className="flex justify-between items-end mb-10">
        <div>
          <h1 className="font-headline text-4xl font-black italic tracking-tighter uppercase text-on-surface mb-2">
            Tactical Grid <span className="text-primary-container">v0.1</span>
          </h1>
          <p className="font-headline text-xs tracking-[0.3em] text-on-surface-variant flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-tertiary-container animate-pulse" />
            SYSTEM_ACTIVE // {CLUSTER_LABEL[CLUSTER].toUpperCase()}
          </p>
        </div>
        <div className="hidden lg:flex gap-4">
          <div className="bg-surface-container-high p-4 stealth-card border-l-2 border-primary">
            <div className="font-headline text-[10px] tracking-widest text-on-surface-variant uppercase mb-1">
              Session PnL
            </div>
            <div
              className={`font-headline text-2xl font-bold ${state.sessionPnl >= 0 ? "text-primary" : "text-error"}`}
            >
              {state.sessionPnl >= 0 ? "+" : ""}
              {state.sessionPnl.toFixed(3)} SOL
            </div>
          </div>
          <div className="bg-surface-container-high p-4 stealth-card border-l-2 border-secondary">
            <div className="font-headline text-[10px] tracking-widest text-on-surface-variant uppercase mb-1">
              Games Played
            </div>
            <div className="font-headline text-2xl font-bold text-secondary">
              {state.sessionGames}
            </div>
          </div>
          <div className="bg-surface-container-high p-4 stealth-card border-l-2 border-tertiary">
            <div className="font-headline text-[10px] tracking-widest text-on-surface-variant uppercase mb-1">
              Vault Health
            </div>
            <div className="font-headline text-2xl font-bold text-tertiary">
              {vaultHealth ? vaultHealth.toString() : "—"}%
            </div>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-12 lg:col-span-4 space-y-6">
          <StuckGameBanner info={stuckInfo} />
          <BetControls />
          <section className="bg-surface-container-low p-6 stealth-card border border-outline-variant/10">
            <h2 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-4">
              On-Chain Stats
            </h2>
            <div className="space-y-3">
              <div className="flex justify-between items-center py-2 border-b border-outline-variant/10">
                <span className="font-headline text-[10px] text-on-surface-variant">
                  Vault Balance
                </span>
                <span className="font-headline text-[10px] text-primary">
                  {vaultBal ? Number((Number(vaultBal) / 1e9).toFixed(2)).toFixed(2) : "—"} SOL
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-outline-variant/10">
                <span className="font-headline text-[10px] text-on-surface-variant">
                  Total Games
                </span>
                <span className="font-headline text-[10px] text-secondary">
                  {gameCount ? gameCount.toString() : "—"}
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-outline-variant/10">
                <span className="font-headline text-[10px] text-on-surface-variant">
                  Vault Health
                </span>
                <span className="font-headline text-[10px] text-emerald">
                  {vaultHealth ? vaultHealth.toString() : "—"}%
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="font-headline text-[10px] text-on-surface-variant">Chain</span>
                <span className="font-headline text-[10px] text-on-surface-variant">
                  {CLUSTER_LABEL[CLUSTER]}
                </span>
              </div>
            </div>
          </section>
        </div>
        <div className="col-span-12 lg:col-span-8">
          <Grid />
        </div>
      </div>
    </div>
  );
}
