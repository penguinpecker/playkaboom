"use client";
import { useGameStore } from "@/stores/game-store";
import { useGameActions } from "@/hooks/use-game-actions";

export function Tile({ index }: { index: number }) {
  const status = useGameStore((s) => s.status);
  const safeTiles = useGameStore((s) => s.safeTiles);
  const mineTiles = useGameStore((s) => s.mineTiles);
  const pendingTile = useGameStore((s) => s.pendingTile);
  const { revealTile } = useGameActions();

  const isSafe = safeTiles.has(index);
  const isMine = mineTiles.has(index);
  const isPending = pendingTile === index;
  const isPlaying = status === "playing";
  const otherPending = pendingTile !== null && pendingTile !== index;

  if (isSafe) {
    return (
      <div className="stealth-card gem-glow flex animate-tile-reveal flex-col items-center justify-center border border-primary/60 bg-primary-container/20">
        <span className="text-2xl font-bold text-primary">✦</span>
        <span className="font-headline text-[10px] font-bold uppercase text-primary">SAFE</span>
      </div>
    );
  }

  if (isMine) {
    return (
      <div className="stealth-card boom-glow flex animate-tile-reveal flex-col items-center justify-center border border-tertiary bg-tertiary-container/20">
        <span className="text-2xl font-black text-tertiary">⚠</span>
        <span className="font-headline text-[10px] font-black uppercase text-tertiary">BOOM</span>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="stealth-card flex animate-pulse flex-col items-center justify-center border border-primary/50 bg-primary/10">
        <span className="text-primary">…</span>
      </div>
    );
  }

  if (!isPlaying) {
    return (
      <div className="stealth-card flex items-center justify-center border border-primary/5 bg-surface-container-highest">
        <span className="text-primary/15">▦</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => !otherPending && revealTile(index)}
      disabled={otherPending}
      className={`stealth-card group relative flex items-center justify-center border border-primary/5 bg-surface-container-highest transition-all ${
        otherPending
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:border-primary/30 hover:bg-primary/10"
      }`}
    >
      <span
        className={`transition-all ${
          otherPending
            ? "text-primary/15"
            : "text-primary/20 group-hover:scale-110 group-hover:text-primary/50"
        }`}
      >
        ▦
      </span>
    </button>
  );
}
