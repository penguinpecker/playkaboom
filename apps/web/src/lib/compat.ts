"use client";
import { useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";

/** Drop-in for wagmi's formatEther — lamports → SOL string. */
export function formatEther(value: bigint | number | undefined): string {
  if (value === undefined) return "0";
  return (Number(value) / LAMPORTS_PER_SOL).toString();
}

/** Drop-in for wagmi's useAccount — Privy-backed. */
export function useAccount() {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  return {
    address: wallet?.address || undefined,
    isConnected: authenticated && !!wallet,
  };
}

/** Drop-in for wagmi's useBalance. */
export function useBalance({ address }: { address?: string }) {
  const { connection } = useConnection();
  const [data, setData] = useState<{ value: bigint; formatted: string } | undefined>();
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const balance = await connection.getBalance(new PublicKey(address));
        if (!cancelled) {
          setData({
            value: BigInt(balance),
            formatted: (balance / LAMPORTS_PER_SOL).toFixed(4),
          });
        }
      } catch {
        /* noop */
      }
    };
    void fetchOnce();
    const id = setInterval(fetchOnce, 8_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [address, connection]);
  return { data };
}
