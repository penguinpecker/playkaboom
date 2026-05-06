"use client";
import { useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { StuckGameInfo } from "@/hooks/use-game-resume";
import { useGame } from "@/hooks/useGame";
import { useToast } from "@/components/providers/toast";

interface Props {
  info: StuckGameInfo;
}

/**
 * Renders only when the player has an unrecoverable on-chain GameSession
 * (server has no encrypted session, so they can't keep revealing). Shows
 * the locked bet, the refund countdown, and a "Force Refund" button that
 * becomes active once refund_expired is callable.
 */
export function StuckGameBanner({ info }: Props) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const { resetGame } = useGame();

  if (!info.stuck) return null;

  const betSol = info.betLamports
    ? (Number(BigInt(info.betLamports)) / LAMPORTS_PER_SOL).toFixed(4)
    : "—";
  const countdown = (() => {
    if (info.refundable) return "now";
    const s = info.secondsUntilRefund;
    if (s < 60) return `${s}s`;
    return `${Math.ceil(s / 60)}m`;
  })();

  const forceRefund = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Reusing the existing useGame.cleanupStuck flow.
      const ok = await (async () => {
        const { useGameStore } = await import("@/stores/game-store");
        useGameStore.setState({ status: "cleaning" });
        const wnd = window as unknown as { __cleanupStuck?: () => Promise<boolean> };
        if (wnd.__cleanupStuck) return wnd.__cleanupStuck();
        return false;
      })();
      if (ok) {
        toast("Game cleaned up — bet refunded", "success");
        resetGame();
      } else {
        toast("Cleanup failed. If countdown above is 'now', try again in a few seconds.", "error");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Cleanup error", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-amber/10 border border-amber/40 p-5 rounded-lg space-y-3">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-amber" style={{ fontSize: 20 }}>
          warning
        </span>
        <h3 className="font-headline text-xs font-bold tracking-widest text-amber uppercase">
          Stuck Game On-Chain
        </h3>
      </div>
      <p className="font-mono text-xs text-on-surface-variant leading-relaxed">
        We found an active <span className="text-on-surface">{betSol} SOL</span> bet on
        chain that can't be resumed (the off-chain session is gone). You can
        refund it back to your wallet after the 300-slot expiry window —{" "}
        <span className={info.refundable ? "text-emerald" : "text-amber"}>
          refundable {countdown}
        </span>
        .
      </p>
      <button
        disabled={busy || !info.refundable}
        onClick={() => void forceRefund()}
        className="w-full py-3 bg-amber text-on-primary font-headline font-bold text-xs tracking-widest hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? "REFUNDING…" : info.refundable ? "FORCE REFUND BET" : `WAITS ${countdown}…`}
      </button>
    </section>
  );
}
