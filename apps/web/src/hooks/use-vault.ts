"use client";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { decodeVault, deriveVaultPda } from "@playkaboom/sdk";
import { PROGRAM_ID } from "@/lib/cluster";

export function useVaultPda() {
  return deriveVaultPda(PROGRAM_ID)[0];
}

/**
 * Live vault balance + decoded config. Polls every 15s with React Query.
 */
export function useVault() {
  const { connection } = useConnection();
  const vaultPda = useVaultPda();

  return useQuery({
    queryKey: ["vault", vaultPda.toBase58(), connection.rpcEndpoint],
    refetchInterval: 15_000,
    queryFn: async () => {
      const [balanceLamports, info] = await Promise.all([
        connection.getBalance(vaultPda, "confirmed"),
        connection.getAccountInfo(vaultPda, "confirmed"),
      ]);
      const decoded = info ? decodeVault(info.data) : null;
      const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
      return {
        pda: vaultPda,
        balanceLamports: BigInt(balanceLamports),
        balanceSol,
        config: decoded,
        // 100% when ≥1 SOL, otherwise scaled.
        healthPct: Math.min(100, Math.round(balanceSol * 100)),
        maxBetSol: decoded
          ? (Number(BigInt(balanceLamports)) * decoded.maxBetBps) / 10_000 / LAMPORTS_PER_SOL
          : 0,
        maxPayoutSol: decoded
          ? (Number(BigInt(balanceLamports)) * decoded.maxPayoutBps) / 10_000 / LAMPORTS_PER_SOL
          : 0,
      };
    },
  });
}

export function useWalletBalance(address: string | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["walletBalance", address, connection.rpcEndpoint],
    enabled: !!address,
    refetchInterval: 8_000,
    queryFn: async () => {
      if (!address) return 0;
      const { PublicKey } = await import("@solana/web3.js");
      const lamports = await connection.getBalance(new PublicKey(address), "confirmed");
      return lamports / LAMPORTS_PER_SOL;
    },
  });
}
