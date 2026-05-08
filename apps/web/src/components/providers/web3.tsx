"use client";
import type { ReactNode } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { ConnectionProvider } from "@solana/wallet-adapter-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CLUSTER, RPC_URL } from "@/lib/cluster";
import { setAuthTokenResolver } from "@/lib/api";
import { useReferralCodePrefetch, useReferralSignupAttribution } from "@/hooks/use-referral";

const solanaConnectors = toSolanaWalletConnectors();

/** Wires Privy's `getAccessToken()` into the auth-fetch helper so every
 * authed API call attaches `Authorization: Bearer <privy token>`. */
function PrivyAuthBridge({ children }: { children: ReactNode }) {
  const { getAccessToken } = usePrivy();
  useEffect(() => {
    setAuthTokenResolver(() => getAccessToken());
  }, [getAccessToken]);
  // Fires /api/ref/signup the first time a wallet connects on a browser
  // carrying the kb.ref.sid cookie. Mounted here so it covers every page,
  // including ones the visitor lands on after the /r/<code> redirect.
  useReferralSignupAttribution();
  // Pre-mints the user's referral short code on first auth and warms
  // the TanStack Query cache so /referrals renders the link instantly.
  useReferralCodePrefetch();
  return <>{children}</>;
}

export function Web3Provider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!privyAppId) {
    return (
      <div style={{ padding: 24, fontFamily: "monospace" }}>
        <strong>NEXT_PUBLIC_PRIVY_APP_ID</strong> is not set.
        <br />
        Copy <code>.env.example</code> to <code>.env.local</code> and add your Privy app id.
      </div>
    );
  }
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: { theme: "dark", accentColor: "#a4c9ff" },
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: { solana: { createOnLogin: "all-users" }, showWalletUIs: false },
        externalWallets: { solana: { connectors: solanaConnectors } },
        solanaClusters:
          CLUSTER === "mainnet-beta"
            ? [{ name: "mainnet-beta", rpcUrl: RPC_URL }]
            : [{ name: "devnet", rpcUrl: RPC_URL }],
      }}
    >
      <ConnectionProvider endpoint={RPC_URL}>
        <QueryClientProvider client={queryClient}>
          <PrivyAuthBridge>{children}</PrivyAuthBridge>
        </QueryClientProvider>
      </ConnectionProvider>
    </PrivyProvider>
  );
}
