"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
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
import { buildPriorityIxs } from "@/lib/priority-fee";

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
 * Mounts in the app shell — the moment a wallet first connects on a
 * browser carrying a kb.ref.sid cookie (set by /r/<code>), pings
 * /api/ref/signup so the server marks that visit as a signup conversion.
 *
 * Idempotent server-side via the unique partial index on
 * referral_visits(session_id) WHERE wallet IS NOT NULL — extra calls
 * silently no-op, so this is safe to fire on every wallet change.
 *
 * We track which wallet we've already pinged in a per-session ref to
 * avoid even sending the request when we already know the answer.
 */
/**
 * Fire-and-forget prefetch of the wallet's referral short code on first
 * authentication. Mounted globally in PrivyAuthBridge so by the time the
 * user clicks "Referrals" in the nav, the code is already minted in the
 * DB and cached in TanStack Query — no spinner.
 *
 * Uses the canonical "ref-code" query key so the /referrals page reads
 * the same cache entry instead of issuing a duplicate request.
 */
export function useReferralCodePrefetch() {
  const { authenticated, getAccessToken } = usePrivy();
  const { wallets } = useSolanaWallets();
  const wallet = wallets[0];
  const qc = useQueryClient();
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!authenticated || !wallet?.address) return;
    if (fetchedFor.current === wallet.address) return;
    fetchedFor.current = wallet.address;
    void qc.fetchQuery({
      queryKey: ["ref-code", wallet.address],
      // 5 min stale — way longer than typical "land on /referrals after
      // login" interval, so the page always reads from cache.
      staleTime: 5 * 60_000,
      queryFn: async () => {
        const token = await getAccessToken();
        if (!token) throw new Error("no auth token");
        const res = await fetch(`/api/ref/code/${wallet.address}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`ref-code prefetch ${res.status}`);
        return (await res.json()) as {
          code: string;
          url: string;
          clickCount: number;
          signupCount: number;
          confirmedCount: number;
          lastVisitedAt: string | null;
        };
      },
    }).catch(() => {
      /* don't block login on a referral mint hiccup; /referrals page
         will retry on its own if the cache is empty. */
    });
  }, [authenticated, wallet?.address, getAccessToken, qc]);
}

export function useReferralSignupAttribution() {
  const { authenticated, getAccessToken } = usePrivy();
  const { wallets } = useSolanaWallets();
  const wallet = wallets[0];
  // Track which wallet we've already pinged for in a ref so we don't
  // re-fire on every render. Survives the lifetime of the page.
  const pingedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!authenticated || !wallet?.address) return;
    if (pingedFor.current === wallet.address) return;
    if (typeof document === "undefined") return;
    // Quick client-side gate — if there's no kb.ref.sid cookie, don't
    // bother hitting the server. Saves a request for the 99% of wallet
    // connects that didn't come from a /r/<code> click.
    if (!document.cookie.includes("kb.ref.sid=")) {
      pingedFor.current = wallet.address;
      return;
    }
    pingedFor.current = wallet.address;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        await fetch("/api/ref/signup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ wallet: wallet.address }),
          credentials: "include",
        });
      } catch {
        /* analytics — silent */
      }
    })();
  }, [authenticated, wallet?.address, getAccessToken]);
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
  const { authenticated, login, getAccessToken } = usePrivy();
  const { wallets } = useSolanaWallets();
  // Privy *embedded* wallets (the only kind we mint — see
  // providers/web3.tsx `embeddedWallets.solana.createOnLogin = "all-users"`)
  // must use useSignTransaction, which takes a Transaction object directly.
  // useStandardSignTransaction is for external Wallet-Standard wallets and
  // throws "n.serializeMessage is not a function" against the legacy txs
  // Privy embeds use. Same pattern as use-vault-lp.ts and use-game-actions.ts.
  const { signTransaction } = useSignTransaction();
  const wallet = wallets[0];
  const queryClient = useQueryClient();

  const signAndSend = useCallback(
    async (tx: Transaction): Promise<string> => {
      if (!wallet) throw new Error("No wallet connected");
      const [{ blockhash, lastValidBlockHeight }, priorityIxs] = await Promise.all([
        connection.getLatestBlockhash("confirmed"),
        buildPriorityIxs(connection, PROGRAM_ID),
      ]);
      // Prepend priority-fee ixs so refer/claim txs aren't evicted under load.
      const wrapped = new Transaction();
      for (const pix of priorityIxs) wrapped.add(pix);
      for (const orig of tx.instructions) wrapped.add(orig);
      tx = wrapped;
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
      // Tell the server: this set_referrer just landed, mark the
      // attribution row confirmed. Best-effort — the on-chain ix is
      // already done, this is just analytics so we don't block on it.
      void (async () => {
        try {
          const token = await getAccessToken();
          if (!token) return;
          await fetch("/api/ref/confirm", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ wallet: wallet.address, signature: sig }),
            credentials: "include",
          });
        } catch {
          /* analytics — silent */
        }
      })();
      return sig;
    },
    [authenticated, wallet, signAndSend, login, queryClient, getAccessToken],
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
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(REFERRER_LOCAL_KEY);
  } catch {
    /* noop */
  }
  // Also expire the V5 fallback cookie.
  try {
    document.cookie = "kb.ref.wallet=; max-age=0; path=/; SameSite=Lax";
  } catch {
    /* noop */
  }
}

function readWalletCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)kb\.ref\.wallet=([^;]+)/);
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export function getPendingReferrer(): string | null {
  if (typeof window === "undefined") return null;
  // Try localStorage first (the normal path); fall back to the V5
  // cookie set by /r/[code] when localStorage was unavailable
  // (Safari Private Browsing, Solana Seeker TWA, etc.).
  try {
    const fromLs = localStorage.getItem(REFERRER_LOCAL_KEY);
    if (fromLs) return fromLs;
  } catch {
    /* fall through to cookie */
  }
  return readWalletCookie();
}
