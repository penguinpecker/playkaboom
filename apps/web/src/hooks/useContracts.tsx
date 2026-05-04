"use client";
import { useEffect, useState } from "react";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import { deriveVaultPda, decodeVault, type VaultAccount } from "@playkaboom/sdk";
import { PROGRAM_ID } from "@/lib/cluster";

const VAULT_PDA = deriveVaultPda(PROGRAM_ID)[0];

function useVaultAccount() {
  const { connection } = useConnection();
  const [data, setData] = useState<{ lamports: bigint; vault: VaultAccount | null }>({
    lamports: 0n,
    vault: null,
  });
  useEffect(() => {
    let cancelled = false;
    const f = async () => {
      try {
        const [lamports, info] = await Promise.all([
          connection.getBalance(VAULT_PDA, "confirmed"),
          connection.getAccountInfo(VAULT_PDA, "confirmed"),
        ]);
        if (cancelled) return;
        setData({
          lamports: BigInt(lamports),
          vault: info ? decodeVault(info.data) : null,
        });
      } catch {
        /* noop */
      }
    };
    void f();
    const id = setInterval(f, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection]);
  return data;
}

export function useContracts() {
  const { lamports } = useVaultAccount();
  return { vaultBalance: Number(lamports) / LAMPORTS_PER_SOL };
}

export function useVaultBalance() {
  const { lamports } = useVaultAccount();
  return { data: lamports > 0n ? lamports : undefined };
}

export function useVaultHealth() {
  const { lamports } = useVaultAccount();
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  return { data: sol >= 1 ? 100 : Math.round(sol * 100) };
}

export function useVaultMaxBet() {
  const { lamports, vault } = useVaultAccount();
  const bps = vault?.maxBetBps ?? 200;
  return {
    data: lamports > 0n ? (lamports * BigInt(bps)) / 10_000n : undefined,
  };
}

export function useVaultMaxPayout() {
  const { lamports, vault } = useVaultAccount();
  const bps = vault?.maxPayoutBps ?? 5_000;
  return {
    data: lamports > 0n ? (lamports * BigInt(bps)) / 10_000n : undefined,
  };
}

export function useGameCounter() {
  const { vault } = useVaultAccount();
  return { data: vault ? vault.totalGames : 0n };
}

export function useRiskLevel() {
  const { data } = useVaultHealth();
  const level = data >= 70 ? 0 : data >= 30 ? 1 : 2;
  return { data: level };
}

export function useWhaleAlertCount() {
  return { data: 0 };
}

export function useDepositToVault() {
  const { connection } = useConnection();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const deposit = async (amt?: string) => {
    const wallet = wallets[0];
    if (!wallet) return;
    try {
      setIsPending(true);
      const sol = parseFloat(amt || "0");
      if (sol <= 0) return;
      const lamports = Math.round(sol * LAMPORTS_PER_SOL);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(wallet.address),
          toPubkey: VAULT_PDA,
          lamports,
        }),
      );
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = new PublicKey(wallet.address);
      setIsConfirming(true);
      const { signedTransaction } = await signTransaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: tx.serialize({ requireAllSignatures: false }) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
      });
      const raw =
        signedTransaction instanceof Uint8Array ? signedTransaction : Buffer.from(signedTransaction);
      const sig = await connection.sendRawTransaction(raw);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setIsSuccess(true);
      setTimeout(() => setIsSuccess(false), 3_000);
    } catch (e) {
      console.error("Deposit failed:", e instanceof Error ? e.message : e);
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return { deposit, isPending, isConfirming, isSuccess };
}

export interface LeaderboardEntry {
  player: string;
  totalWagered: bigint;
  totalWon: bigint;
  gamesPlayed: bigint;
  biggestWin: bigint;
  biggestMultiplier: bigint;
}

export function useLeaderboard() {
  return { data: [] as LeaderboardEntry[] };
}
