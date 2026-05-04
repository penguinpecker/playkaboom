"use client";
import { useGame } from "@/hooks/useGame";

export function Tile({ index }: { index: number }) {
  const { state, revealTile } = useGame();
  const isSafe = state.safeTiles.has(index);
  const isMine = state.mineTiles.has(index);
  const isPending = state.pendingTile === index;
  const isPlaying = state.status === "playing";
  const isGameOver = state.status === "won" || state.status === "lost";

  if (isSafe) {
    return (
      <div className="bg-primary-container/20 stealth-card border border-primary/60 flex flex-col items-center justify-center gem-glow animate-tile-reveal">
        <span className="material-symbols-outlined text-primary mi" style={{ fontSize: 48 }}>
          verified
        </span>
        <span className="font-headline text-[10px] font-bold text-primary uppercase">SAFE</span>
      </div>
    );
  }

  if (isMine) {
    return (
      <div className="bg-tertiary-container/20 stealth-card border border-tertiary flex flex-col items-center justify-center boom-glow animate-tile-reveal">
        <span className="material-symbols-outlined text-tertiary mi" style={{ fontSize: 48 }}>
          emergency
        </span>
        <span className="font-headline text-[10px] font-black text-tertiary uppercase">BOOM</span>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="bg-primary/10 stealth-card border border-primary/50 flex flex-col items-center justify-center animate-pulse">
        <span
          className="material-symbols-outlined text-primary animate-spin"
          style={{ fontSize: 36 }}
        >
          progress_activity
        </span>
        <span className="font-headline text-[9px] text-primary/70 uppercase mt-1">confirming</span>
      </div>
    );
  }

  if (isPlaying && !isGameOver) {
    const isDisabled = state.pendingTile !== null;
    return (
      <div
        onClick={() => !isDisabled && revealTile(index)}
        className={`bg-surface-container-highest stealth-card group border border-primary/5 relative flex items-center justify-center transition-all
          ${
            isDisabled
              ? "opacity-50 cursor-not-allowed"
              : "cursor-pointer hover:bg-primary/10 hover:border-primary/30"
          }`}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <span
          className={`material-symbols-outlined transition-all ${
            isDisabled
              ? "text-primary/15"
              : "text-primary/20 group-hover:text-primary/50 group-hover:scale-110"
          }`}
          style={{ fontSize: 40 }}
        >
          view_in_ar
        </span>
      </div>
    );
  }

  return (
    <div className="bg-surface-container-highest stealth-card border border-primary/5 flex items-center justify-center">
      <span className="material-symbols-outlined text-primary/15" style={{ fontSize: 40 }}>
        view_in_ar
      </span>
    </div>
  );
}
