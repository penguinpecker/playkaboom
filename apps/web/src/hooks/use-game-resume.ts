"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { useGameStore } from "@/stores/game-store";

// Debounce window for auth-loss → EMPTY_INFO reset. Privy's token
// rotation transiently flips `authenticated` to false for a few hundred
// ms; without this debounce, info.active flips false, BetControls'
// hasStuckGame flips false, and the Engage button enables for a
// heartbeat — long enough for a fast double-click to fire commit
// against an existing on-chain GameSession and hit the 409 loop.
const AUTH_RESET_DEBOUNCE_MS = 2_000;

export type OnChainGameStatus = "Playing" | "Won" | "Lost" | "Expired";

export interface StuckGameInfo {
  active: boolean;
  /** True if server has the encrypted session and player can keep playing. */
  recoverable: boolean;
  /** True only when on-chain game exists AND server has no session. */
  stuck: boolean;
  /** Bet in lamports (string for u64). */
  betLamports: string | null;
  mineCount: number | null;
  /** Current GameSession status — drives which recovery ix the banner dispatches:
   *    Playing                  → refund_expired (refunds bet)
   *    Won/Lost & !settled      → close_unsettled_game (reclaims rent)
   *    Won/Lost & settled, OR Expired → close_game (no cooldown). */
  status: OnChainGameStatus | null;
  /** True if settle_game has already run for this game. When true and status
   *  is Won/Lost, the recovery ix MUST be close_game, NOT close_unsettled_game
   *  (the latter requires `!settled` and errors with GameAlreadySettled). */
  settled: boolean;
  /** Slots until the appropriate recovery ix becomes callable. 0 if already refundable. */
  slotsUntilRefund: number;
  /** Wall-clock seconds until refundable. 0 if already refundable. */
  secondsUntilRefund: number;
  /** True if the right ix (per status) would succeed right now. */
  refundable: boolean;
  /** Pre-fetched ciphertext — caller hands this to setGameToken when the
   *  player clicks the Resume button. NOT auto-applied (avoids surprise). */
  pendingGameToken: string | null;
  /** u16 bitmask of all revealed tiles from the on-chain GameSession. Used
   *  on resume to repaint already-flipped tiles so the player doesn't see
   *  an unflipped grid + click a "TileAlreadyRevealed" failure. */
  revealedMask: number;
  /** u16 bitmask of revealed-safe tiles (revealedMask minus the lone mine
   *  bit on a Lost game). For a Playing game equals revealedMask. */
  revealedSafeMask: number;
  /** Current multiplier as a ratio (multiplier_bps / 10_000). */
  multiplier: number;
  /** SHA-256 commitment hex from the on-chain GameSession. */
  commitment: string | null;
  /** Force-refresh the probe (e.g. after a Force Close lands). */
  refresh: () => void;
}

/**
 * On every wallet connect, asks the server "do I have an active game I can
 * resume?" — and surfaces the answer to callers so they can render a
 * "Stuck Game" banner with a refund countdown.
 *
 * Side effects: if a session is recoverable, rehydrates the store with the
 * fresh ciphertext and flips status to "playing". If not, status is set to
 * "idle" and the caller is responsible for offering the manual refund UX.
 */
const EMPTY_INFO: Omit<StuckGameInfo, "refresh"> = {
  active: false,
  recoverable: false,
  stuck: false,
  betLamports: null,
  mineCount: null,
  status: null,
  settled: false,
  slotsUntilRefund: 0,
  secondsUntilRefund: 0,
  refundable: false,
  pendingGameToken: null,
  revealedMask: 0,
  revealedSafeMask: 0,
  multiplier: 1,
  commitment: null,
};

export function useGameResume(): StuckGameInfo {
  const { authenticated, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  const setStatus = useGameStore((s) => s.setStatus);
  const setError = useGameStore((s) => s.setError);

  const [info, setInfo] = useState<Omit<StuckGameInfo, "refresh">>(EMPTY_INFO);
  // Bumping this triggers a re-probe via the useEffect below.
  const [tick, setTick] = useState(0);
  // Track when we last had auth — used to debounce the EMPTY_INFO reset
  // through Privy token rotations.
  const lastAuthAtRef = useRef<number>(0);

  const probe = useCallback(async () => {
    if (!authenticated || !wallet?.address) {
      // Don't blow away info during a brief auth blip (Privy token
      // rotation, network reconnect). If we had auth within the last
      // AUTH_RESET_DEBOUNCE_MS window, leave info alone — the next
      // probe (15s later or via visibility wake) will re-confirm.
      const sinceAuth = Date.now() - lastAuthAtRef.current;
      if (lastAuthAtRef.current > 0 && sinceAuth < AUTH_RESET_DEBOUNCE_MS) return;
      setInfo(EMPTY_INFO);
      return;
    }
    lastAuthAtRef.current = Date.now();
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch(`/api/session/${wallet.address}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        active: boolean;
        gameToken?: string | null;
        sessionRecovered?: boolean;
        onChain?: {
          bet?: string;
          mineCount?: number;
          status?: OnChainGameStatus;
          settled?: boolean;
          revealedMask?: number;
          revealedSafeMask?: number;
          multiplierBps?: string;
          commitment?: string;
        };
        refund?: {
          refundable: boolean;
          slotsUntilRefund: number;
          secondsUntilRefund: number;
        };
      };
      if (!data.active) {
        setInfo(EMPTY_INFO);
        // Make sure the UI returns to a clean idle when the game closes.
        setStatus("idle");
        setError(null);
        return;
      }
      const multiplierBps = data.onChain?.multiplierBps
        ? Number(BigInt(data.onChain.multiplierBps))
        : 10_000;
      // Don't auto-flip status to "playing" — present the choice through the
      // GameRecoveryBanner Resume button instead. Auto-flipping was confusing
      // (player got taken straight into a game they may not have wanted to
      // resume on this device).
      setInfo({
        active: true,
        recoverable: !!data.gameToken,
        stuck: !data.gameToken,
        betLamports: data.onChain?.bet ?? null,
        mineCount: data.onChain?.mineCount ?? null,
        status: data.onChain?.status ?? null,
        settled: data.onChain?.settled ?? false,
        slotsUntilRefund: data.refund?.slotsUntilRefund ?? 0,
        secondsUntilRefund: data.refund?.secondsUntilRefund ?? 0,
        refundable: data.refund?.refundable ?? false,
        pendingGameToken: data.gameToken ?? null,
        revealedMask: data.onChain?.revealedMask ?? 0,
        revealedSafeMask: data.onChain?.revealedSafeMask ?? 0,
        multiplier: multiplierBps / 10_000,
        commitment: data.onChain?.commitment ?? null,
      });
    } catch {
      /* silent */
    }
  }, [authenticated, wallet?.address, getAccessToken, setStatus, setError]);

  // Initial probe + 15-second poll while a game is active so the countdown
  // updates without a page reload. Re-runs whenever `tick` bumps.
  useEffect(() => {
    void probe();
    if (!info.active) return;
    const i = setInterval(() => void probe(), 15_000);
    return () => clearInterval(i);
  }, [probe, info.active, tick]);

  // Re-probe immediately when the store transitions to a terminal state
  // (won/lost) or when the post-cashout pendingClose flag clears. The
  // 15s poll alone is too slow — the player can finish a game and see
  // a stale "RESUME" banner for the entire 15s window otherwise. Probe
  // ASAP after relevant store changes so the banner reflects truth.
  const storeStatus = useGameStore((s) => s.status);
  const pendingClose = useGameStore((s) => s.pendingClose);
  useEffect(() => {
    if (storeStatus === "won" || storeStatus === "lost") {
      void probe();
    }
  }, [storeStatus, probe]);
  useEffect(() => {
    // Fires once when pendingClose flips false → server settle + on-chain
    // close should both have completed.
    if (!pendingClose) void probe();
  }, [pendingClose, probe]);

  // Mobile browsers aggressively suspend background tabs and the 15s
  // setInterval can drift or stall for hours, leaving the live-game state
  // frozen. Trigger an immediate probe whenever the tab becomes visible
  // again, the network reconnects, or the page is restored from bfcache.
  // Cheap (one fetch per event) and recovers the live feed instantly.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void probe();
    };
    const onOnline = () => void probe();
    const onPageShow = () => void probe();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [probe]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...info, refresh };
}
