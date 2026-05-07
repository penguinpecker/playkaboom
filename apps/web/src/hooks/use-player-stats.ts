"use client";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  decodePlayerStats,
  derivePlayerStatsPda,
  type PlayerStatsAccount,
} from "@playkaboom/sdk";
import { PROGRAM_ID } from "@/lib/cluster";

export function usePlayerStats(player: string | null | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["playerStats", player, connection.rpcEndpoint],
    enabled: !!player,
    refetchInterval: 8_000,
    queryFn: async (): Promise<PlayerStatsAccount | null> => {
      if (!player) return null;
      try {
        const [pda] = derivePlayerStatsPda(PROGRAM_ID, new PublicKey(player));
        const info = await connection.getAccountInfo(pda, "confirmed");
        if (!info) return null;
        return decodePlayerStats(info.data);
      } catch {
        return null;
      }
    },
  });
}
