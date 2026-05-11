import type { Metadata } from "next";
import { InstallClient } from "./InstallClient";

export const metadata: Metadata = {
  title: "Install Kaboom! — Solana dApp Store",
  description:
    "Install Kaboom! on your Solana Seeker via the Solana dApp Store. Provably-fair on-chain Mines.",
  openGraph: {
    title: "Install Kaboom! on Seeker",
    description:
      "Provably-fair on-chain Mines. Install from the Solana dApp Store.",
    url: "https://www.playkaboom.gg/install",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export default function InstallPage() {
  return <InstallClient />;
}
