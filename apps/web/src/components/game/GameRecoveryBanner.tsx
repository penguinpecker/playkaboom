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
  const hydrateResume = useGameStore((s) => s.hydrateResume);
  // Hide the banner the instant the player has actively re-entered a game
  // (status flips to "playing" via resume(), or to "starting"/"cashing" via
  // a normal flow). Without this gate the banner would linger because
  // `info.active` stays true for the entire on-chain GameSession lifetime,
  // and the 15s server poll won't run again immediately.
  const storeStatus = useGameStore((s) => s.status);

  // Smooth 1-second countdown between API polls. The session probe runs
  // every 15s, which left the visible countdown stuttering ("28s" → wait
  // 15s → "13s" → wait 15s → "ready"). We capture the seconds and
  // wall-clock at every poll, then re-render every 1s with the
  // interpolated remainder.
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
  // If the on-chain expiry has passed but the API hasn't re-polled yet,
  // the button should still be enabled — the program will succeed.
  const liveRefundable = info.refundable || liveSecondsUntilRefund === 0;

  const resume = useCallback(() => {
    if (!info.pendingGameToken) {
      toast("No saved session to resume", "error");
      return;
    }
    if (info.commitment && info.mineCount != null && info.betLamports) {
      // Hydrate the local UI from the on-chain GameSession masks so any
      // tiles the player already flipped before they paused show up as
      // SAFE/BOOM. Without this the grid renders blank and clicking a
      // previously-revealed tile errors with TileAlreadyRevealed.
      hydrateResume({
        bet: Number(BigInt(info.betLamports)) / LAMPORTS_PER_SOL,
        mineCount: info.mineCount,
        revealedMask: info.revealedMask,
        revealedSafeMask: info.revealedSafeMask,
        multiplier: info.multiplier,
        commitment: info.commitment,
        gameToken: info.pendingGameToken,
      });
    } else {
      // Fallback for the rare race where on-chain fields didn't make it
      // through the response payload — at least flip status so the player
      // can see the panel even if the masks are missing.
      setGameToken(info.pendingGameToken);
      setStatus("playing");
    }
    toast("Game resumed — pick up where you left off", "success");
  }, [info, hydrateResume, setGameToken, setStatus, toast]);

  // Pick the right ix based on the on-chain GameStatus. Calling the wrong one
  // throws GameNotFinished/GameNotExpired (custom error 0x1782 / 0x1781).
  const buildRecoveryIx = useCallback(
    (player: PublicKey) => {
      const ctx = { programId: PROGRAM_ID };
      switch (info.status) {
        case "Playing":
          // Refunds bet to player and closes the PDA. Requires start + 300 slots.
          return buildRefundExpired({ ctx, player });
        case "Won":
        case "Lost":
          // If settle_game already ran, the only thing left to reclaim is rent
          // — use the regular close_game ix (no `!settled` guard). The
          // close_unsettled_game ix REQUIRES `!settled` and errors with
          // GameAlreadySettled (0x1781) on a settled game.
          return info.settled
            ? buildCloseGame({ ctx, player })
            : buildCloseUnsettledGame({ ctx, player });
        case "Expired":
          // refund_expired already ran; just clean up the PDA.
          return buildCloseGame({ ctx, player });
        default:
          // Unknown / null — best-effort fallback to refund_expired so the
          // player at least gets their bet back if the status field was lost.
          return buildRefundExpired({ ctx, player });
      }
    },
    [info.status, info.settled],
  );

  const forceClose = useCallback(async () => {
    if (busy || !wallet) return;
    setBusy(true);
    try {
      const ix = buildRecoveryIx(new PublicKey(wallet.address));
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
        info.status === "Playing"
          ? "Bet refunded — wallet unblocked"
          : "Stuck game closed — wallet unblocked";
      toast(successMsg, "success");
      // G10: clear local store gameToken so a leftover token in
      // localStorage from this round can't sneak into a future round and
      // cause reveal-with-stale-layout corruption.
      setGameToken(null);
      // Refresh the probe so the banner hides and BetControls becomes available.
      info.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close failed";
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }, [busy, wallet, connection, signTransaction, buildRecoveryIx, info, toast, setGameToken]);

  if (!info.active) return null;
  // Player has resumed (or is mid-game on this device) — banner has done its job.
  if (storeStatus === "playing" || storeStatus === "starting" || storeStatus === "cashing") {
    return null;
  }

  const isPlaying = info.status === "Playing" || info.status === null;
  // Active = no on-chain settlement yet, bet still locked. Refund returns it.
  // Won/Lost = SOL already moved on-chain; close just reclaims rent.
  const closeLabel = isPlaying ? "REFUND BET" : "FORCE CLOSE";
  const closeBusyLabel = isPlaying ? "REFUNDING…" : "CLOSING…";
  const closeFootnote = isPlaying
    ? "refund_expired returns your full bet · ~0.002 SOL rent also reclaimed"
    : "close_unsettled_game · ~0.002 SOL rent returned (cash-out already paid)";

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
            disabled={busy || !liveRefundable}
            onClick={() => void forceClose()}
            className="px-4 py-3 border border-outline-variant/30 text-on-surface-variant font-headline font-bold text-xs tracking-widest hover:bg-surface-container hover:text-on-surface active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              liveRefundable
                ? isPlaying
                  ? "Forfeit this game on-chain and refund the full bet to your wallet."
                  : "Force-close this game. PDA rent returns to your wallet."
                : `Closable in ${countdownLabel(liveSecondsUntilRefund)}`
            }
          >
            {liveRefundable ? closeLabel : countdownLabel(liveSecondsUntilRefund)}
          </button>
        </div>
        <p className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40 mt-3">
          {isPlaying
            ? "Resume = same mine layout · Refund bet = forfeit, get bet back"
            : "Resume = same mine layout · Force close = reclaim slot"}
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
        {liveRefundable ? (
          <span className="text-emerald">Ready to close.</span>
        ) : (
          <>
            Closable in{" "}
            <span className="text-on-surface">{countdownLabel(liveSecondsUntilRefund)}</span>.
          </>
        )}
      </p>
      <button
        disabled={busy || !liveRefundable}
        onClick={() => void forceClose()}
        className="w-full py-3 border-2 border-tertiary text-tertiary font-headline font-bold text-xs tracking-widest hover:bg-tertiary/10 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy
          ? closeBusyLabel
          : liveRefundable
            ? `${closeLabel} STUCK GAME`
            : `READY IN ${countdownLabel(liveSecondsUntilRefund)}…`}
      </button>
      <p className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40 mt-3">
        {closeFootnote}
      </p>
    </section>
  );
}
