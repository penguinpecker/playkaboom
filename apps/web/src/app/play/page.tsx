"use client";
import { Grid } from "@/components/game/Grid";
import { BetControls } from "@/components/game/BetControls";
import { GameRecoveryBanner } from "@/components/game/GameRecoveryBanner";
import { GlobalActivityFeed } from "@/components/GlobalActivityFeed";
import { useGame } from "@/hooks/useGame";
import { useGameResume } from "@/hooks/use-game-resume";
import { useVaultBalance, useGameCounter } from "@/hooks/useContracts";
import { CLUSTER, CLUSTER_LABEL } from "@/lib/cluster";

export default function PlayPage() {
  // Auto-recover an in-flight game from any device on mount.
  const stuckInfo = useGameResume();
  const { state } = useGame();
  const { data: vaultBal } = useVaultBalance();
  const { data: gameCount } = useGameCounter();
  return (
    <div className="px-2 sm:px-6 lg:px-8 pb-16 min-h-screen kinetic-grid">
      {/* Hero: compact single-line on mobile to avoid the "double header" feel
          stacked under the fixed Navbar. Full hero block returns at lg. */}
      <div className="flex items-center justify-between gap-3 mb-3 lg:hidden pt-2">
        <h1 className="font-headline text-base font-black italic tracking-tighter uppercase text-on-surface">
          Tactical Grid <span className="text-primary-container">v0.1</span>
        </h1>
        <span className="font-headline text-[9px] tracking-widest text-on-surface-variant flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-tertiary-container animate-pulse" />
          {CLUSTER_LABEL[CLUSTER].toUpperCase()}
        </span>
      </div>
      <div className="hidden lg:flex flex-col sm:flex-row justify-between sm:items-end gap-4 mb-10 pt-0">
        <div>
          <h1 className="font-headline text-3xl lg:text-4xl font-black italic tracking-tighter uppercase text-on-surface mb-2">
            Tactical Grid <span className="text-primary-container">v0.1</span>
          </h1>
          <p className="font-headline text-xs tracking-[0.3em] text-on-surface-variant flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-tertiary-container animate-pulse" />
            SYSTEM_ACTIVE // {CLUSTER_LABEL[CLUSTER].toUpperCase()}
          </p>
        </div>
        <div className="flex gap-4">
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
              Vault Balance
            </div>
            <div className="font-headline text-2xl font-bold text-tertiary">
              {vaultBal ? Number((Number(vaultBal) / 1e9).toFixed(2)).toFixed(2) : "—"} SOL
            </div>
          </div>
        </div>
      </div>
      {/* Mobile: Grid first (most important), then controls. Desktop: 4-col controls + 8-col grid. */}
      <div className="grid grid-cols-12 gap-4 lg:gap-8">
        <div className="col-span-12 lg:col-span-8 lg:order-2">
          <Grid />
        </div>
        <div className="col-span-12 lg:col-span-4 lg:order-1 space-y-4 lg:space-y-6">
          <GameRecoveryBanner info={stuckInfo} />
          <BetControls stuckInfo={stuckInfo} />
          <section className="bg-surface-container-low p-4 sm:p-6 stealth-card border border-outline-variant/10">
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
              <div className="flex justify-between items-center py-2">
                <span className="font-headline text-[10px] text-on-surface-variant">Chain</span>
                <span className="font-headline text-[10px] text-on-surface-variant">
                  {CLUSTER_LABEL[CLUSTER]}
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
      {/* Stake-style global ticker — engagement loop showing recent wins/losses
          across all players, with verify-fairness deep-link on each row. */}
      <div className="mt-6 lg:mt-10">
        <GlobalActivityFeed limit={16} />
      </div>
    </div>
  );
}
