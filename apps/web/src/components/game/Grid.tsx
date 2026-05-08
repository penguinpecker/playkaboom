"use client";
import { useEffect } from "react";
import { GAME_CONFIG } from "@/lib/chain";
import { useGame } from "@/hooks/useGame";
import { useModal } from "@/hooks/useModal";
import { Tile } from "./Tile";

export function Grid() {
  const { state, cashOut } = useGame();
  const { open } = useModal();
  const safeTilesTotal = GAME_CONFIG.GRID_SIZE - state.mineCount;

  useEffect(() => {
    if (state.status === "won") {
      const t = setTimeout(() => open("win"), 400);
      return () => clearTimeout(t);
    }
    if (state.status === "lost") {
      const t = setTimeout(() => open("lose"), 600);
      return () => clearTimeout(t);
    }
    return;
  }, [state.status, open]);

  const riskLevel = state.safeTiles.size / safeTilesTotal;
  const riskText =
    state.status !== "playing"
      ? "STANDBY"
      : riskLevel > 0.6
        ? "CRITICAL"
        : riskLevel > 0.3
          ? "HIGH"
          : riskLevel > 0
            ? "MODERATE"
            : "LOW";
  const riskColor =
    riskLevel > 0.6 ? "text-error" : riskLevel > 0.3 ? "text-amber" : "text-emerald";

  return (
    <div className="bg-surface-container-low p-3 sm:p-6 lg:p-8 stealth-card border border-outline-variant/10 flex flex-col w-full max-w-[700px] mx-auto">
      <div className="flex flex-wrap justify-between items-center gap-2 mb-4 sm:mb-6">
        <div className="flex flex-wrap gap-1.5 sm:gap-2 min-w-0">
          <span className="px-2 sm:px-3 py-1 bg-surface-container-highest text-[9px] sm:text-[10px] font-headline font-bold text-primary tracking-widest whitespace-nowrap">
            GRID: 4X4
          </span>
          <span className="px-2 sm:px-3 py-1 bg-surface-container-highest text-[9px] sm:text-[10px] font-headline font-bold text-tertiary tracking-widest whitespace-nowrap">
            {state.multiplier.toFixed(2)}X
          </span>
          {state.gameId && (
            <span className="px-2 sm:px-3 py-1 bg-surface-container-highest text-[9px] sm:text-[10px] font-headline font-bold text-secondary tracking-widest whitespace-nowrap">
              #{state.gameId.toString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-headline text-[9px] sm:text-[10px] tracking-widest text-on-surface-variant uppercase whitespace-nowrap">
          {state.status === "playing" && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse" />
          )}
          {state.status === "playing" ? "Live" : "Ready"}
        </div>
      </div>

      <div className="aspect-square grid grid-cols-4 grid-rows-4 gap-1.5 sm:gap-3 lg:gap-4">
        {Array.from({ length: GAME_CONFIG.GRID_SIZE }, (_, i) => (
          <Tile key={i} index={i} />
        ))}
      </div>

      <div className="mt-4 sm:mt-8 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 bg-surface-container-lowest/50 p-3 sm:p-4 border-l-4 border-primary">
        <div className="grid grid-cols-3 sm:flex sm:items-center sm:gap-4 gap-2">
          <div>
            <div className="font-headline text-[9px] sm:text-[10px] uppercase tracking-widest text-on-surface-variant">
              Next Gain
            </div>
            <div className="font-headline font-bold text-primary text-base sm:text-lg">
              {state.multiplier.toFixed(2)}×
            </div>
          </div>
          <div className="hidden sm:block h-8 w-px bg-outline-variant/20" />
          <div>
            <div className="font-headline text-[9px] sm:text-[10px] uppercase tracking-widest text-on-surface-variant">
              Risk
            </div>
            <div className={`font-headline font-bold text-base sm:text-lg ${riskColor}`}>{riskText}</div>
          </div>
          <div className="hidden sm:block h-8 w-px bg-outline-variant/20" />
          <div>
            <div className="font-headline text-[9px] sm:text-[10px] uppercase tracking-widest text-on-surface-variant">
              Cleared
            </div>
            <div className="font-headline font-bold text-secondary text-base sm:text-lg">
              {state.safeTiles.size} / {safeTilesTotal}
            </div>
          </div>
        </div>
        {(state.status === "playing" || state.status === "cashing") && state.safeTiles.size > 0 && (
          <button
            onClick={cashOut}
            disabled={state.status === "cashing"}
            className="w-full sm:w-auto py-3 px-4 sm:px-8 bg-surface-bright border border-primary/30 text-primary font-headline font-black text-xs tracking-widest hover:bg-primary hover:text-on-primary transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            EXIT &amp; WITHDRAW
          </button>
        )}
      </div>

      {state.error && (
        <div className="mt-3 bg-error/10 border border-error/20 p-3 text-error text-xs font-mono">
          {state.error}
        </div>
      )}
    </div>
  );
}
