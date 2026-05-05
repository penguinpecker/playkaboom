"use client";
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import {
  buildClaimReferral,
  buildSetReferrer,
  decodeReferralAccount,
  deriveReferralPda,
  type ReferralAccountData,
} from "@playkaboom/sdk";
import { PROGRAM_ID } from "@/lib/cluster";

const REFERRER_LOCAL_KEY = "playkaboom.referrer.v1";

/**
 * Captures `?ref=<wallet>` from the URL on first visit, stashes in localStorage.
 * Idempotent and safe to mount on every page.
 */
export function useReferralCapture(): string | null {
  const [stored, setStored] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const ref = url.searchParams.get("ref");
    if (ref) {
      try {
        new PublicKey(ref); // validate
        localStorage.setItem(REFERRER_LOCAL_KEY, ref);
        setStored(ref);
        // Clean the URL so the param doesn't stick around in history.
        url.searchParams.delete("ref");
        window.history.replaceState({}, "", url.toString());
      } catch {
        /* invalid pubkey, drop */
      }
    } else {
      setStored(localStorage.getItem(REFERRER_LOCAL_KEY));
    }
  }, []);

  return stored;
}

/**
 * Reads the on-chain ReferralAccount for any pubkey. Live polling.
 */
export function useReferralAccount(referrer: string | null | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["referralAccount", referrer, connection.rpcEndpoint],
    enabled: !!referrer,
    refetchInterval: 15_000,
    queryFn: async (): Promise<ReferralAccountData | null> => {
      if (!referrer) return null;
      try {
        const [pda] = deriveReferralPda(PROGRAM_ID, new PublicKey(referrer));
        const info = await connection.getAccountInfo(pda, "confirmed");
        if (!info) return null;
        return decodeReferralAccount(info.data);
      } catch {
        return null;
      }
    },
  });
}

/**
 * Mutations: set my referrer (one-time) and claim my accrued rakeback.
 */
export function useReferralActions() {
  const { connection } = useConnection();
  const { authenticated, login } = usePrivy();
  const { wallets } = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  const wallet = wallets[0];
  const queryClient = useQueryClient();

  const signAndSend = useCallback(
    async (tx: Transaction): Promise<string> => {
      if (!wallet) throw new Error("No wallet connected");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = new PublicKey(wallet.address);
      const serialized = tx.serialize({ requireAllSignatures: false });
      const { signedTransaction } = await signTransaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: serialized as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
      });
      const raw =
        signedTransaction instanceof Uint8Array
          ? signedTransaction
          : Buffer.from(signedTransaction);
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      return sig;
    },
    [wallet, connection, signTransaction],
  );

  const setReferrer = useCallback(
    async (referrer: string): Promise<string> => {
      if (!authenticated) {
        login();
        throw new Error("Not authenticated");
      }
      if (!wallet) throw new Error("No wallet");
      const playerPk = new PublicKey(wallet.address);
      const referrerPk = new PublicKey(referrer);
      if (playerPk.equals(referrerPk)) throw new Error("Cannot refer yourself");
      const ix = buildSetReferrer({
        ctx: { programId: PROGRAM_ID },
        player: playerPk,
        referrer: referrerPk,
      });
      const tx = new Transaction().add(ix);
      const sig = await signAndSend(tx);
      // Clear pending referrer (now applied on-chain)
      if (typeof window !== "undefined") localStorage.removeItem(REFERRER_LOCAL_KEY);
      // Invalidate stats so referrer field refreshes
      queryClient.invalidateQueries({ queryKey: ["playerStats"] });
      return sig;
    },
    [authenticated, wallet, signAndSend, login, queryClient],
  );

  const claim = useCallback(async (): Promise<string> => {
    if (!wallet) throw new Error("No wallet");
    const ix = buildClaimReferral({
      ctx: { programId: PROGRAM_ID },
      referrer: new PublicKey(wallet.address),
    });
    const tx = new Transaction().add(ix);
    const sig = await signAndSend(tx);
    queryClient.invalidateQueries({ queryKey: ["referralAccount"] });
    return sig;
  }, [wallet, signAndSend, queryClient]);

  return { setReferrer, claim };
}

export function clearPendingReferrer() {
  if (typeof window !== "undefined") localStorage.removeItem(REFERRER_LOCAL_KEY);
}

export function getPendingReferrer(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFERRER_LOCAL_KEY);
}
