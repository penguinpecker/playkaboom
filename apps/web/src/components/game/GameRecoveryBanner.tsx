"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  buildCashOut,
  buildCloseGame,
  buildCloseUnsettledGame,
  buildRefundExpired,
} from "@playkaboom/sdk";
import { confirmByPolling } from "@/lib/confirm";
import { PROGRAM_ID } from "@/lib/cluster";
import { buildPriorityIxs } from "@/lib/priority-fee";
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

/** Number of safe tiles flipped pre-pause; drives the cashout/refund choice. */
function popcount(n: number): number {
  let count = 0;
  let v = n & 0xffff;
  while (v) {
    v &= v - 1;
    count++;
  }
  return count;
}

/** Possible recovery actions, ranked instant-first. */
type Action =
  | { kind: "cashOut"; payoutSol: number }      // Playing + reveals>0; INSTANT
  | { kind: "closeGame" }                        // Won/Lost+settled OR Expired; INSTANT
  | { kind: "closeUnsettled"; secondsUntilReady: number } // Won/Lost+!settled; needs slot+600
  | { kind: "refundExpired"; secondsUntilReady: number }; // Playing+0reveals; needs slot+300

/**
 * Single-button recovery banner.
 *
 * Resume was removed (2026-05-10) — kept producing edge-case bugs around
 * stale gameToken / desync between client masks and server session, and
 * the user explicitly asked for "just one force-close button" that does
 * the right thing per state. The new flow:
 *
 *   - Playing + safe_reveals > 0  → cash_out         INSTANT, gets earnings
 *   - Playing + 0 safe reveals    → refund_expired   needs start+300 slots (~2m)
 *   - Won/Lost + settled OR Expired → close_game     INSTANT, reclaims rent
 *   - Won/Lost + !settled         → close_unsettled  needs start+600 slots (~4m)
 *
 * The "instant" cases have no countdown — button is live the moment the
 * banner appears. The "needs-slot" cases show the countdown.
 */
export function GameRecoveryBanner({ info }: Props) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const { connection } = useConnection();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const wallet = wallets[0];
  const setGameToken = useGameStore((s) => s.setGameToken);
  // Hide the banner the instant the player has actively re-entered a
  // game flow — playing/starting/cashing means the BetControls/Grid is
  // taking over and the banner is irrelevant.
  const storeStatus = useGameStore((s) => s.status);
  // Also hide while the post-cashout chain (apiSettle phase=settle →
  // server deleteSession → cleanup → close_game) is in flight. Without
  // this gate the banner re-renders the moment the user dismisses
  // WinModal (status: won → idle) but the server hasn't yet processed
  // the settle that deletes the session row, so probe sees the session
  // and shows recovery for a game the player just cashed out from.
  const pendingClose = useGameStore((s) => s.pendingClose);

  // Smooth 1-second countdown between API polls.
  const baseSecondsRef = useRef(info.secondsUntilRefund);
  const baseAtRef = useRef(Date.now());
  useEffect(() => {
    baseSecondsRef.current = info.secondsUntilRefund;
    baseAtRef.current = Date.now();
  }, [info.secondsUntilRefund]);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (info.secondsUntilRefund <= 0 && info.refundable) return;
    const i = setInterval(() => forceTick((t) => t + 1), 1_000);
    return () => clearInterval(i);
  }, [info.secondsUntilRefund, info.refundable]);
  const elapsed = Math.floor((Date.now() - baseAtRef.current) / 1000);
  const liveSecondsUntilRefund = Math.max(0, baseSecondsRef.current - elapsed);

  // Decide which on-chain ix this banner offers based on the on-chain
  // state. cash_out and close_game are always instant; refund_expired
  // and close_unsettled_game gate on slot timers.
  const action: Action = (() => {
    const safeReveals = popcount(info.revealedSafeMask);
    const betLamports = info.betLamports ? BigInt(info.betLamports) : 0n;
    const payoutSol =
      Number(betLamports) * info.multiplier / LAMPORTS_PER_SOL;
    if (info.status === "Playing") {
      if (safeReveals > 0) return { kind: "cashOut", payoutSol };
      return { kind: "refundExpired", secondsUntilReady: liveSecondsUntilRefund };
    }
    if (info.status === "Expired") return { kind: "closeGame" };
    if (info.status === "Won" || info.status === "Lost") {
      if (info.settled) return { kind: "closeGame" };
      return { kind: "closeUnsettled", secondsUntilReady: liveSecondsUntilRefund };
    }
    // Unknown / null status — fallback to refund_expired (matches the
    // pre-2026-05-10 behavior). Slot timer applies.
    return { kind: "refundExpired", secondsUntilReady: liveSecondsUntilRefund };
  })();

  const isInstant = action.kind === "cashOut" || action.kind === "closeGame";
  const isReady =
    isInstant ||
    (action.kind === "refundExpired" && action.secondsUntilReady === 0) ||
    (action.kind === "closeUnsettled" && action.secondsUntilReady === 0);

  const buildIx = useCallback(
    (player: PublicKey) => {
      const ctx = { programId: PROGRAM_ID };
      switch (action.kind) {
        case "cashOut":
          return buildCashOut({ ctx, player });
        case "refundExpired":
          return buildRefundExpired({ ctx, player });
        case "closeUnsettled":
          return buildCloseUnsettledGame({ ctx, player });
        case "closeGame":
          return buildCloseGame({ ctx, player });
      }
    },
    [action.kind],
  );

  const submit = useCallback(async () => {
    if (busy || !wallet || !isReady) return;
    setBusy(true);
    try {
      const ix = buildIx(new PublicKey(wallet.address));
      const [{ blockhash, lastValidBlockHeight }, priorityIxs] = await Promise.all([
        connection.getLatestBlockhash("confirmed"),
        buildPriorityIxs(connection, PROGRAM_ID),
      ]);
      const tx = new Transaction();
      for (const pix of priorityIxs) tx.add(pix);
      tx.add(ix);
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

      const successMsg =
        action.kind === "cashOut"
          ? `Cashed out — ${action.payoutSol.toFixed(4)} SOL withdrawn`
          : action.kind === "refundExpired"
            ? "Bet refunded — wallet unblocked"
            : "Game closed — wallet unblocked";
      toast(successMsg, "success");
      setGameToken(null);
      info.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }, [busy, wallet, isReady, buildIx, connection, signTransaction, action, toast, setGameToken, info]);

  if (!info.active) return null;
  if (storeStatus === "playing" || storeStatus === "starting" || storeStatus === "cashing") {
    return null;
  }
  if (pendingClose) return null;

  const sectionDot =
    action.kind === "cashOut" ? "bg-emerald" : action.kind === "closeGame" ? "bg-primary" : "bg-tertiary";
  const sectionHeader =
    action.kind === "cashOut"
      ? "IN-FLIGHT GAME — CASH OUT"
      : action.kind === "refundExpired"
        ? "IN-FLIGHT GAME — REFUND"
        : action.kind === "closeUnsettled"
          ? "STUCK GAME ON-CHAIN"
          : "UNCLAIMED GAME";
  const sectionTitle =
    action.kind === "cashOut"
      ? "CLAIM YOUR WINNINGS"
      : action.kind === "refundExpired"
        ? "REFUND YOUR BET"
        : "UNBLOCK YOUR WALLET";
  const sectionBody =
    action.kind === "cashOut"
      ? `Active ${fmtSol(info.betLamports)} game with ${popcount(info.revealedSafeMask)} safe tile${popcount(info.revealedSafeMask) === 1 ? "" : "s"} flipped. Cash out at ${info.multiplier.toFixed(2)}× — your wallet receives ${action.payoutSol.toFixed(4)} SOL.`
      : action.kind === "refundExpired"
        ? `On-chain bet of ${fmtSol(info.betLamports)} with no tiles flipped. ${isReady ? "Ready to refund." : `Refundable in ${countdownLabel(action.secondsUntilReady)}.`}`
        : action.kind === "closeUnsettled"
          ? `On-chain bet of ${fmtSol(info.betLamports)}, payout already moved. ${isReady ? "Ready to close." : `Closable in ${countdownLabel(action.secondsUntilReady)}.`}`
          : `Stale game session ready to close. ~0.002 SOL rent returned to your wallet.`;
  const buttonLabel = busy
    ? "PROCESSING…"
    : action.kind === "cashOut"
      ? `EXIT & WITHDRAW — ${action.payoutSol.toFixed(4)} SOL`
      : action.kind === "refundExpired"
        ? isReady
          ? "REFUND BET"
          : `READY IN ${countdownLabel(action.secondsUntilReady)}…`
        : action.kind === "closeUnsettled"
          ? isReady
            ? "FORCE CLOSE"
            : `READY IN ${countdownLabel(action.secondsUntilReady)}…`
          : "CLOSE GAME";
  const buttonClasses =
    action.kind === "cashOut"
      ? "w-full py-3 border-2 border-emerald text-emerald font-headline font-bold text-xs tracking-widest hover:bg-emerald/10 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      : "w-full py-3 border-2 border-tertiary text-tertiary font-headline font-bold text-xs tracking-widest hover:bg-tertiary/10 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed";
  const footnote =
    action.kind === "cashOut"
      ? "cash_out · pays accrued multiplier × bet · ~0.002 SOL rent returned later via auto-close"
      : action.kind === "refundExpired"
        ? "refund_expired returns your full bet · ~0.002 SOL rent also reclaimed"
        : action.kind === "closeUnsettled"
          ? "close_unsettled_game · ~0.002 SOL rent returned (cash-out already paid)"
          : "close_game · ~0.002 SOL rent returned";

  return (
    <section className="bg-surface-container-low p-5 stealth-card border border-outline-variant/10">
      <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-2 mb-2">
        <span className={`status-dot ${sectionDot}`} />
        {sectionHeader}
      </p>
      <h3 className="font-headline text-base font-black italic tracking-tight text-on-surface mb-3">
        {sectionTitle}
      </h3>
      <p className="font-mono text-xs text-on-surface-variant leading-relaxed mb-4">
        {sectionBody}
      </p>
      <button disabled={busy || !isReady} onClick={() => void submit()} className={buttonClasses}>
        {buttonLabel}
      </button>
      <p className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40 mt-3">
        {footnote}
      </p>
    </section>
  );
}
