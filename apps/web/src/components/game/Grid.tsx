"use client";
import { useEffect } from "react";
import { GRID_SIZE } from "@playkaboom/shared";
import { useGameStore } from "@/stores/game-store";
import { useGameActions } from "@/hooks/use-game-actions";
import { useModal } from "@/components/providers/modal";
import { Tile } from "./Tile";

export function Grid() {
  const status = useGameStore((s) => s.status);
  const mineCount = useGameStore((s) => s.mineCount);
  const safeTiles = useGameStore((s) => s.safeTiles);
  const multiplier = useGameStore((s) => s.multiplier);
  const error = useGameStore((s) => s.error);
  const { cashOut } = useGameActions();
  const { open } = useModal();

  const safeTotal = GRID_SIZE - mineCount;
  const ratio = safeTiles.size / safeTotal;
  const riskText =
    status !== "playing"
      ? "STANDBY"
      : ratio > 0.6
        ? "CRITICAL"
        : ratio > 0.3
          ? "HIGH"
          : ratio > 0
            ? "MODERATE"
            : "LOW";
  const riskColor = ratio > 0.6 ? "text-error" : ratio > 0.3 ? "text-amber" : "text-emerald";

  useEffect(() => {
    if (status === "won") {
      const t = setTimeout(() => open("win"), 400);
      return () => clearTimeout(t);
    }
    if (status === "lost") {
      const t = setTimeout(() => open("lose"), 600);
      return () => clearTimeout(t);
    }
    return;
  }, [status, open]);

  return (
    <div className="stealth-card mx-auto flex w-full max-w-[700px] flex-col border border-outline-variant/10 bg-surface-container-low p-8">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex gap-2">
          <span className="bg-surface-container-highest px-3 py-1 font-headline text-[10px] font-bold tracking-widest text-primary">
            GRID 4×4
          </span>
          <span className="bg-surface-container-highest px-3 py-1 font-headline text-[10px] font-bold tracking-widest text-tertiary">
            ×{multiplier.toFixed(2)}
          </span>
        </div>
        <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
          {status === "playing" ? "Live On-Chain" : "Ready"}
        </div>
      </div>

      <div className="grid aspect-square grid-cols-4 grid-rows-4 gap-4">
        {Array.from({ length: GRID_SIZE }, (_, i) => (
          <Tile key={i} index={i} />
        ))}
      </div>

      <div className="mt-8 flex items-center justify-between border-l-4 border-primary bg-surface-container-lowest/50 p-4">
        <div className="flex items-center gap-4">
          <Stat label="Next gain" value={`×${multiplier.toFixed(2)}`} color="text-primary" />
          <Sep />
          <Stat label="Risk" value={riskText} color={riskColor} />
          <Sep />
          <Stat label="Cleared" value={`${safeTiles.size} / ${safeTotal}`} color="text-secondary" />
        </div>
        {status === "playing" && safeTiles.size > 0 && (
          <button
            type="button"
            onClick={cashOut}
            className="border border-primary/30 bg-surface-bright px-8 py-3 font-headline text-xs font-black tracking-widest text-primary transition-all hover:bg-primary hover:text-on-primary active:scale-95"
          >
            EXIT &amp; WITHDRAW
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 border border-error/20 bg-error/10 p-3 font-mono text-xs text-error">
          {error}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className={`font-headline text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}

function Sep() {
  return <div className="h-8 w-px bg-outline-variant/20" />;
}
