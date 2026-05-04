import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_EXPLORERS, EXPLORERS, type SolanaCluster } from "@playkaboom/shared";

const RAW_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";
export const CLUSTER: SolanaCluster =
  RAW_CLUSTER === "mainnet-beta" || RAW_CLUSTER === "devnet" || RAW_CLUSTER === "testnet"
    ? RAW_CLUSTER
    : "devnet";

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC ??
  (CLUSTER === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com");

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
