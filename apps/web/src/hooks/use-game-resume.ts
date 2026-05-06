"use client";
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { useGameStore } from "@/stores/game-store";

export interface StuckGameInfo {
  active: boolean;
  /** True if server has the encrypted session and player can keep playing. */
  recoverable: boolean;
  /** True only when on-chain game exists AND server has no session. */
  stuck: boolean;
  /** Bet in lamports (string for u64). */
  betLamports: string | null;
  mineCount: number | null;
  /** Slots until refund_expired becomes callable. 0 if already refundable. */
  slotsUntilRefund: number;
  /** Wall-clock seconds until refundable. 0 if already refundable. */
  secondsUntilRefund: number;
  /** True if refund_expired ix would succeed right now. */
  refundable: boolean;
  /** Pre-fetched ciphertext — caller hands this to setGameToken when the
   *  player clicks the Resume button. NOT auto-applied (avoids surprise). */
  pendingGameToken: string | null;
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
  slotsUntilRefund: 0,
  secondsUntilRefund: 0,
  refundable: false,
  pendingGameToken: null,
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

  const probe = useCallback(async () => {
    if (!authenticated || !wallet?.address) {
      setInfo(EMPTY_INFO);
      return;
    }
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
        onChain?: { bet?: string; mineCount?: number };
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
        slotsUntilRefund: data.refund?.slotsUntilRefund ?? 0,
        secondsUntilRefund: data.refund?.secondsUntilRefund ?? 0,
        refundable: data.refund?.refundable ?? false,
        pendingGameToken: data.gameToken ?? null,
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

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...info, refresh };
}
