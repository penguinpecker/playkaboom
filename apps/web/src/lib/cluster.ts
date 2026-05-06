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
 * Default: our same-origin proxy `/api/rpc/<cluster>` so the upstream
 * RPC API key (Alchemy / paid provider) never enters the browser
 * bundle. The proxy enforces a JSON-RPC method allow-list + per-IP
 * rate limit (apps/web/src/app/api/rpc/[cluster]/route.ts).
 *
 * Escape hatch: NEXT_PUBLIC_SOLANA_RPC is honored if explicitly set —
 * useful for local dev pointing at a custom RPC, or for emergencies
 * where the proxy is down. In production we leave it unset.
 *
 * Final fallback: public Solana RPC. Slow + rate-limited but lets the
 * site render something instead of erroring out if both prior options
 * fail.
 */
const PROXY_CLUSTER_PATH =
  CLUSTER === "mainnet-beta" ? "mainnet" : CLUSTER === "testnet" ? "testnet" : "devnet";
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC && process.env.NEXT_PUBLIC_SOLANA_RPC.length > 0
    ? process.env.NEXT_PUBLIC_SOLANA_RPC
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
