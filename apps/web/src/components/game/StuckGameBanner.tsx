"use client";
import { useCallback, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useSolanaWallets as useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import { LAMPORTS_PER_SOL, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { buildCloseUnsettledGame } from "@playkaboom/sdk";
import { confirmByPolling } from "@/lib/confirm";
import { PROGRAM_ID } from "@/lib/cluster";
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
  const { connection } = useConnection();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const wallet = wallets[0];

  const forceClose = useCallback(async () => {
    if (busy || !wallet) return;
    setBusy(true);
    try {
      const ix = buildCloseUnsettledGame({
        ctx: { programId: PROGRAM_ID },
        player: new PublicKey(wallet.address),
      });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
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
      resetGame();
      // Force a reload of the resume probe.
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Close failed", "error");
    } finally {
      setBusy(false);
    }
  }, [busy, wallet, connection, signTransaction, toast, resetGame]);

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
        onClick={() => void forceClose()}
        className="w-full py-3 bg-amber text-on-primary font-headline font-bold text-xs tracking-widest hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? "CLOSING…" : info.refundable ? "FORCE CLOSE STUCK GAME" : `READY IN ${countdown}…`}
      </button>
      <p className="font-mono text-[10px] text-on-surface-variant/40 italic">
        Calls close_unsettled_game on the program — recovers PDA rent and unblocks
        your wallet for new games. If you won, your cash-out already paid out
        when the win landed; this just reclaims the slot.
      </p>
    </section>
  );
}
