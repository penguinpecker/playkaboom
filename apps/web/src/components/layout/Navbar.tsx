"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { useEffect, useState } from "react";
import { CLUSTER_LABEL, CLUSTER } from "@/lib/cluster";
import { shortAddr } from "@/lib/format";
import { useWalletBalance } from "@/hooks/use-vault";
import { useModal } from "@/components/providers/modal";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/play", label: "Play" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/logs", label: "Logs" },
  { href: "/vault", label: "Vault" },
];

export function Navbar() {
  const pathname = usePathname();
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { open } = useModal();
  const wallet = wallets[0];
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { data: balance = 0 } = useWalletBalance(wallet?.address);
  const isConnected = mounted && authenticated && !!wallet;
  const short = wallet?.address ? shortAddr(wallet.address, 4, 4) : "";

  return (
    <header className="fixed top-0 z-50 flex h-16 w-full items-center justify-between bg-surface-container-low/90 px-6 shadow-[0_0_20px_rgba(208,188,255,0.1)] backdrop-blur-xl">
      <div className="flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2">
          <span className="font-headline text-2xl font-black italic tracking-tighter text-transparent">
            <span className="bg-gradient-to-br from-primary to-primary-container bg-clip-text">PLAY</span>
            <span className="text-on-surface">KABOOM</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-6 lg:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`font-headline text-sm uppercase tracking-tight transition-colors ${
                pathname === link.href
                  ? "border-b-2 border-primary pb-1 text-primary"
                  : "text-on-surface-variant hover:text-primary"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-4">
        {isConnected && (
          <div className="flex items-center gap-2 rounded-lg border border-outline-variant/20 bg-surface-container-highest px-4 py-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald" />
            <span className="font-headline text-sm font-bold tracking-wide text-primary">
              {balance.toFixed(2)} SOL
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={() => (isConnected ? open("profile") : login())}
          className="flex items-center gap-2 bg-gradient-to-br from-primary to-primary-container px-5 py-2 font-headline text-xs font-bold uppercase tracking-widest text-on-primary transition-all hover:shadow-[0_0_15px_rgba(164,201,255,0.4)] active:scale-95"
        >
          {isConnected ? short : "Connect"}
        </button>
        <span className="hidden text-[10px] uppercase tracking-widest text-on-surface-variant lg:inline">
          {CLUSTER_LABEL[CLUSTER]}
        </span>
      </div>
    </header>
  );
}
