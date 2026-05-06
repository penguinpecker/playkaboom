"use client";
import { useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { useGameStore } from "@/stores/game-store";
import { useToast } from "@/components/providers/toast";

/**
 * On every wallet connect, asks the server "do I have an active game I can
 * resume?" — if yes, rehydrates the local store with the recovered token so
 * the player can continue revealing or settle/refund without the original
 * device.
 *
 * Idle when the wallet is not yet connected or already has a token in
 * localStorage matching the on-chain state.
 */
export function useGameResume(): void {
  const { authenticated, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  const setGameToken = useGameStore((s) => s.setGameToken);
  const setStatus = useGameStore((s) => s.setStatus);
  const setError = useGameStore((s) => s.setError);
  const { toast } = useToast();

  useEffect(() => {
    if (!authenticated || !wallet?.address) return;
    let cancelled = false;
    const f = async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch(`/api/session/${wallet.address}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          active: boolean;
          gameToken?: string | null;
          onChain?: { status?: string };
        };
        if (cancelled) return;
        if (!data.active) return;
        if (data.gameToken) {
          setGameToken(data.gameToken);
          setStatus("playing");
          toast("Resumed your in-flight game", "primary");
        } else {
          // On-chain game exists but server has no session row.
          // Player can refund after the expiry window.
          setStatus("idle");
          setError("Stuck game on-chain. Use 'Cleanup' to refund after 300 slots.");
        }
      } catch {
        /* silent — non-blocking probe */
      }
    };
    void f();
    return () => {
      cancelled = true;
    };
  }, [authenticated, wallet?.address, getAccessToken, setGameToken, setStatus, setError, toast]);
}
