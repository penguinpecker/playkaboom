import type { Metadata } from "next";
import StatusClient from "./status-client";

// Split from the client component purely so this file can export metadata —
// a "use client" module cannot. Without it the status page inherits the game's
// title and a player checking whether the protocol is up sees a browser tab
// that says "On-Chain Mines on Solana".
export const metadata: Metadata = {
  title: "Status — PlayKaboom",
  description:
    "Live health of the PlayKaboom protocol: Solana program, bankroll solvency, MagicBlock rollup, database and indexer freshness.",
  robots: { index: true, follow: true },
};

export default function StatusPage() {
  return <StatusClient />;
}
