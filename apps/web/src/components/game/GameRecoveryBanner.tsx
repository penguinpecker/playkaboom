"use client";
import { useCallback, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  useSolanaWallets as useWallets,
  useSignTransaction,
} from "@privy-io/react-auth/solana";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { buildCloseUnsettledGame } from "@playkaboom/sdk";
import { confirmByPolling } from "@/lib/confirm";
import { PROGRAM_ID } from "@/lib/cluster";
import type { StuckGameInfo } from "@/hooks/use-game-resume";
import { useGameStore } from "@/stores/game-store";
import { useToast } from "@/components/providers/toast";

interface Props {
  info: StuckGameInfo;
}

const fmtSol = (lamports: string | null) => {
  if (!lamports) return "—";
  return (Number(BigInt(lamports)) / LAMPORTS_PER_SOL).toFixed(4) + " SOL";
};

const countdownLabel = (s: number) => {
  if (s <= 0) return "now";
  if (s < 60) return `${s}s`;
  return `${Math.ceil(s / 60)}m`;
};

/**
 * Unified banner shown above BetControls whenever the player has any
 * on-chain GameSession. Two distinct states:
 *
 *   • info.recoverable  → "Resume Game" button (server still has the
 *     encrypted session — clicking flips status to "playing" and the
 *     existing game UI continues).
 *
 *   • info.stuck        → "Force Close" button (no recoverable session;
 *     ix close_unsettled_game runs after the 4-min cooldown).
 *
 * Both paths refresh the probe on success rather than reloading the page,
 * which avoids React #418 hydration races we hit with setTimeout+reload.
 */
export function GameRecoveryBanner({ info }: Props) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const { connection } = useConnection();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const wallet = wallets[0];
  const setGameToken = useGameStore((s) => s.setGameToken);
  const setStatus = useGameStore((s) => s.setStatus);

  const resume = useCallback(() => {
    if (!info.pendingGameToken) {
      toast("No saved session to resume", "error");
      return;
    }
    setGameToken(info.pendingGameToken);
    setStatus("playing");
    toast("Game resumed — pick up where you left off", "success");
  }, [info.pendingGameToken, setGameToken, setStatus, toast]);

  const forceClose = useCallback(async () => {
    if (busy || !wallet) return;
    setBusy(true);
    try {
      const ix = buildCloseUnsettledGame({
        ctx: { programId: PROGRAM_ID },
        player: new PublicKey(wallet.address),
      });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = new PublicKey(wallet.address);
      const signed = await signTransaction({
        transaction: tx,
        connection,
        address: wallet.address,
      });
      const raw =
        signed instanceof VersionedTransaction
          ? signed.serialize()
          : (signed as Transaction).serialize();
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
      await confirmByPolling(connection, sig, blockhash, lastValidBlockHeight);
      toast("Stuck game closed — wallet unblocked", "success");
      // Refresh the probe so the banner hides and BetControls becomes available.
      info.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close failed";
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }, [busy, wallet, connection, signTransaction, info, toast]);

  if (!info.active) return null;

  // ─── Recoverable: Resume vs forfeit ───────────────────────────────────
  if (info.recoverable) {
    return (
      <section className="bg-surface-container-low p-5 stealth-card border border-outline-variant/10">
        <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-2 mb-2">
          <span className="status-dot bg-primary" />
          IN-FLIGHT GAME — RESUME?
        </p>
        <h3 className="font-headline text-base font-black italic tracking-tight text-on-surface mb-3">
          PICK UP WHERE YOU LEFT OFF
        </h3>
        <p className="font-mono text-xs text-on-surface-variant leading-relaxed mb-4">
          Active <span className="text-on-surface font-bold">{fmtSol(info.betLamports)}</span> game
          {info.mineCount != null ? ` (${info.mineCount} mines)` : ""} paused on another
          device. Resume to keep playing the same mine layout.
        </p>
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={resume}
            className="flex-1 py-3 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-xs tracking-widest hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
          >
            RESUME GAME
          </button>
          <button
            disabled={busy || !info.refundable}
            onClick={() => void forceClose()}
            className="px-4 py-3 border border-outline-variant/30 text-on-surface-variant font-headline font-bold text-xs tracking-widest hover:bg-surface-container hover:text-on-surface active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              info.refundable
                ? "Force-close this game (forfeit it on-chain). PDA rent returns to your wallet."
                : `Closable in ${countdownLabel(info.secondsUntilRefund)}`
            }
          >
            {info.refundable
              ? "FORCE CLOSE"
              : `${countdownLabel(info.secondsUntilRefund)}`}
          </button>
        </div>
        <p className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40 mt-3">
          Resume = same mine layout · Force close = forfeit, reclaim slot
        </p>
      </section>
    );
  }

  // ─── Stuck: only force-close path is meaningful ────────────────────────
  return (
    <section className="bg-surface-container-low p-5 stealth-card border border-outline-variant/10">
      <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-2 mb-2">
        <span className="status-dot bg-tertiary" />
        STUCK GAME ON-CHAIN
      </p>
      <h3 className="font-headline text-base font-black italic tracking-tight text-on-surface mb-3">
        UNBLOCK YOUR WALLET
      </h3>
      <p className="font-mono text-xs text-on-surface-variant leading-relaxed mb-4">
        On-chain bet of <span className="text-on-surface font-bold">{fmtSol(info.betLamports)}</span>{" "}
        with no recoverable session.{" "}
        {info.refundable ? (
          <span className="text-emerald">Ready to close.</span>
        ) : (
          <>
            Closable in{" "}
            <span className="text-on-surface">{countdownLabel(info.secondsUntilRefund)}</span>.
          </>
        )}
      </p>
      <button
        disabled={busy || !info.refundable}
        onClick={() => void forceClose()}
        className="w-full py-3 border-2 border-tertiary text-tertiary font-headline font-bold text-xs tracking-widest hover:bg-tertiary/10 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy
          ? "CLOSING…"
          : info.refundable
            ? "FORCE CLOSE STUCK GAME"
            : `READY IN ${countdownLabel(info.secondsUntilRefund)}…`}
      </button>
      <p className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40 mt-3">
        Calls close_unsettled_game · ~0.002 SOL rent returned
      </p>
    </section>
  );
}
