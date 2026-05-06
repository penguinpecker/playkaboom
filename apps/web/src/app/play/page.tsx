"use client";
import { Grid } from "@/components/game/Grid";
import { BetControls } from "@/components/game/BetControls";
import { GameRecoveryBanner } from "@/components/game/GameRecoveryBanner";
import { GlobalActivityFeed } from "@/components/GlobalActivityFeed";
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
    <div className="px-3 sm:px-6 lg:px-8 pb-16 min-h-screen kinetic-grid">
      <div className="flex flex-col sm:flex-row justify-between sm:items-end gap-4 mb-6 lg:mb-10 pt-4 lg:pt-0">
        <div>
          <h1 className="font-headline text-2xl sm:text-3xl lg:text-4xl font-black italic tracking-tighter uppercase text-on-surface mb-2">
            Tactical Grid <span className="text-primary-container">v0.1</span>
          </h1>
          <p className="font-headline text-[10px] sm:text-xs tracking-[0.2em] sm:tracking-[0.3em] text-on-surface-variant flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-tertiary-container animate-pulse" />
            SYSTEM_ACTIVE // {CLUSTER_LABEL[CLUSTER].toUpperCase()}
          </p>
        </div>
        {/* Mobile: 3 compact stat chips; Desktop: large stat cards */}
        <div className="grid grid-cols-3 gap-2 lg:hidden">
          <div className="bg-surface-container-high p-2 stealth-card border-l-2 border-primary">
            <div className="font-headline text-[9px] tracking-wider text-on-surface-variant uppercase">PnL</div>
            <div
              className={`font-headline text-sm font-bold ${state.sessionPnl >= 0 ? "text-primary" : "text-error"}`}
            >
              {state.sessionPnl >= 0 ? "+" : ""}
              {state.sessionPnl.toFixed(3)}
            </div>
          </div>
          <div className="bg-surface-container-high p-2 stealth-card border-l-2 border-secondary">
            <div className="font-headline text-[9px] tracking-wider text-on-surface-variant uppercase">Games</div>
            <div className="font-headline text-sm font-bold text-secondary">{state.sessionGames}</div>
          </div>
          <div className="bg-surface-container-high p-2 stealth-card border-l-2 border-tertiary">
            <div className="font-headline text-[9px] tracking-wider text-on-surface-variant uppercase">Health</div>
            <div className="font-headline text-sm font-bold text-tertiary">
              {vaultHealth ? `${vaultHealth.toString()}%` : "—"}
            </div>
          </div>
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
      {/* Mobile: Grid first (most important), then controls. Desktop: 4-col controls + 8-col grid. */}
      <div className="grid grid-cols-12 gap-4 lg:gap-8">
        <div className="col-span-12 lg:col-span-8 lg:order-2">
          <Grid />
        </div>
        <div className="col-span-12 lg:col-span-4 lg:order-1 space-y-4 lg:space-y-6">
          <GameRecoveryBanner info={stuckInfo} />
          <BetControls />
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
      </div>
      {/* Stake-style global ticker — engagement loop showing recent wins/losses
          across all players, with verify-fairness deep-link on each row. */}
      <div className="mt-6 lg:mt-10">
        <GlobalActivityFeed limit={16} />
      </div>
    </div>
  );
}
