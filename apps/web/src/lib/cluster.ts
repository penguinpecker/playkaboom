import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_EXPLORERS, EXPLORERS, type SolanaCluster } from "@playkaboom/shared";

const RAW_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";
export const CLUSTER: SolanaCluster =
  RAW_CLUSTER === "mainnet-beta" || RAW_CLUSTER === "devnet" || RAW_CLUSTER === "testnet"
    ? RAW_CLUSTER
    : "devnet";

/**
 * Client-facing RPC URL.
 *
 * Production builds ALWAYS use our same-origin proxy `/api/rpc/<cluster>`
 * so the upstream RPC API key (Alchemy / paid provider) never enters the
 * browser bundle. The proxy enforces a JSON-RPC method allow-list +
 * per-IP rate limit (apps/web/src/app/api/rpc/[cluster]/route.ts) and
 * reads the key from the server-only SOLANA_MAINNET_RPC / SOLANA_RPC env.
 *
 * 2026-05-21 incident: `NEXT_PUBLIC_SOLANA_RPC` had been set to a
 * vendor-key URL in Vercel prod env. Next.js inlines NEXT_PUBLIC_*
 * values at build time, so the API key was shipped in every JS chunk to
 * every visitor for as long as that env var stayed set. Mobile TWA
 * clients also reported "VAULT UNAVAILABLE" because hitting the vendor
 * endpoint directly is flakier on cellular networks than going
 * through the same-origin proxy. Operator must rotate the leaked key
 * AND unset the env var; this code change ensures a future env mistake
 * cannot re-introduce the leak.
 *
 * Dev-only override: `NEXT_PUBLIC_SOLANA_RPC` is honored when
 * NODE_ENV !== "production" (local validator, custom dev endpoint). In
 * prod builds the entire branch is dead code — Next.js tree-shakes
 * `process.env.NODE_ENV !== "production"` to `false` at build time,
 * dropping any inlined NEXT_PUBLIC_SOLANA_RPC value from the bundle.
 *
 * Final SSR fallback: public Solana RPC. Only used during server-side
 * page rendering before hydration; browser code always takes the proxy
 * branch since `typeof window !== "undefined"`.
 */
const PROXY_CLUSTER_PATH =
  CLUSTER === "mainnet-beta" ? "mainnet" : CLUSTER === "testnet" ? "testnet" : "devnet";

const DEV_RPC_OVERRIDE =
  process.env.NODE_ENV !== "production" &&
  process.env.NEXT_PUBLIC_SOLANA_RPC &&
  process.env.NEXT_PUBLIC_SOLANA_RPC.length > 0
    ? process.env.NEXT_PUBLIC_SOLANA_RPC
    : null;

export const RPC_URL =
  DEV_RPC_OVERRIDE !== null
    ? DEV_RPC_OVERRIDE
    : typeof window !== "undefined"
      ? `${window.location.origin}/api/rpc/${PROXY_CLUSTER_PATH}`
      : CLUSTER === "mainnet-beta"
        ? "https://api.mainnet-beta.solana.com"
        : "https://api.devnet.solana.com";

const RAW_PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID;
export const PROGRAM_ID = RAW_PROGRAM_ID
  ? new PublicKey(RAW_PROGRAM_ID)
  : new PublicKey("Kab1TestProgam11111111111111111111111111111");

export const txExplorer = (sig: string) => EXPLORERS[CLUSTER](sig);
export const accountExplorer = (addr: string) => ACCOUNT_EXPLORERS[CLUSTER](addr);

export const CLUSTER_LABEL: Record<SolanaCluster, string> = {
  "mainnet-beta": "Solana Mainnet",
  devnet: "Solana Devnet",
  testnet: "Solana Testnet",
  localnet: "Solana Localnet",
};
