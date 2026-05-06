"use client";
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
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
import { deserializeIx } from "@playkaboom/sdk";
import { confirmByPolling } from "@/lib/confirm";
import { buildPriorityIxs } from "@/lib/priority-fee";
import { PROGRAM_ID } from "@/lib/cluster";
import {
  apiVaultCancelWithdraw,
  apiVaultCompleteWithdraw,
  apiVaultDeposit,
  apiVaultPosition,
  apiVaultRequestWithdraw,
  apiVaultState,
  type VaultPositionResponse,
  type VaultStateResponse,
} from "@/lib/api";

export function useVaultState() {
  return useQuery<VaultStateResponse>({
    queryKey: ["vault-state"],
    queryFn: apiVaultState,
    refetchInterval: 30_000,
  });
}

export function useLpPosition(wallet?: string) {
  return useQuery<VaultPositionResponse>({
    queryKey: ["lp-position", wallet],
    queryFn: () => {
      if (!wallet) throw new Error("no wallet");
      return apiVaultPosition(wallet);
    },
    enabled: !!wallet,
    refetchInterval: 30_000,
  });
}

export function useLpActions() {
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  // Embedded-wallet hook (takes a Transaction, returns a signed Transaction).
  // useStandardSignTransaction is for external Wallet-Standard wallets and
  // throws "n.serializeMessage is not a function" against legacy txs.
  const { signTransaction } = useSignTransaction();
  const { connection } = useConnection();
  const qc = useQueryClient();

  const wallet = wallets[0];
  const walletAddress = wallet?.address;

  const signAndSend = useCallback(
    async (instructionResp: { instruction: Parameters<typeof deserializeIx>[0] }) => {
      if (!wallet) throw new Error("Connect wallet first");
      const ix = deserializeIx(instructionResp.instruction);
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
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 3,
      });
      await confirmByPolling(connection, sig, blockhash, lastValidBlockHeight);
      qc.invalidateQueries({ queryKey: ["vault-state"] });
      qc.invalidateQueries({ queryKey: ["lp-position", wallet.address] });
      return sig;
    },
    [wallet, connection, signTransaction, qc],
  );

  const deposit = useCallback(
    async (sol: string | number) => {
      if (!walletAddress) throw new Error("no wallet");
      const lamports = BigInt(Math.floor(Number(sol) * LAMPORTS_PER_SOL));
      const resp = await apiVaultDeposit({ player: walletAddress, amountLamports: lamports });
      return signAndSend(resp);
    },
    [walletAddress, signAndSend],
  );

  const requestWithdraw = useCallback(
    async (units: bigint) => {
      if (!walletAddress) throw new Error("no wallet");
      const resp = await apiVaultRequestWithdraw({ player: walletAddress, units });
      return signAndSend(resp);
    },
    [walletAddress, signAndSend],
  );

  const cancelWithdraw = useCallback(async () => {
    if (!walletAddress) throw new Error("no wallet");
    const resp = await apiVaultCancelWithdraw({ player: walletAddress });
    return signAndSend(resp);
  }, [walletAddress, signAndSend]);

  const completeWithdraw = useCallback(async () => {
    if (!walletAddress) throw new Error("no wallet");
    const resp = await apiVaultCompleteWithdraw({ player: walletAddress });
    return signAndSend(resp);
  }, [walletAddress, signAndSend]);

  return {
    authenticated,
    login,
    walletAddress,
    deposit,
    requestWithdraw,
    cancelWithdraw,
    completeWithdraw,
  };
}
