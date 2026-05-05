"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useModal } from "@/hooks/useModal";
import { useVaultBalance, useVaultHealth, useRiskLevel } from "@/hooks/useContracts";
import { MobileDrawer } from "./MobileDrawer";
import { KaboomLogo } from "@/components/ui/KaboomLogo";
import { CLUSTER, CLUSTER_LABEL } from "@/lib/cluster";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/play", label: "Play" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/referrals", label: "Referrals" },
  { href: "/logs", label: "Logs" },
  { href: "/vault", label: "Vault" },
];

const RISK_LABELS = ["Healthy", "Caution", "Emergency"];

export function Navbar() {
  const pathname = usePathname();
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const publicKey = wallets[0]?.address ? { toBase58: () => wallets[0]!.address } : null;
  const connected = authenticated && !!wallets[0];

  const { connection } = useConnection();
  const { open } = useModal();
  const [showMobile, setShowMobile] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [walletBal, setWalletBal] = useState("0.00");
  const notifRef = useRef<HTMLDivElement>(null);
  const { data: vaultBal } = useVaultBalance();
  const { data: vaultHealth } = useVaultHealth();
  const { data: riskLevel } = useRiskLevel();
  const shortAddr = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-3)}`
    : "";
  const riskIdx = riskLevel !== undefined ? Number(riskLevel) : 0;
  const isConnected = mounted && connected && !!publicKey;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!publicKey || !connection) return;
    let cancelled = false;
    const f = async () => {
      try {
        const { PublicKey: PK } = await import("@solana/web3.js");
        const b = await connection.getBalance(new PK(publicKey.toBase58()));
        if (!cancelled) setWalletBal((b / LAMPORTS_PER_SOL).toFixed(2));
      } catch {
        /* noop */
      }
    };
    void f();
    const i = setInterval(f, 8_000);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, [publicKey, connection]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setShowNotif(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <>
      <header className="fixed top-0 w-full z-50 flex justify-between items-center px-6 h-16 bg-surface-container-low/90 backdrop-blur-xl shadow-[0_0_20px_rgba(208,188,255,0.1)]">
        <div className="flex items-center gap-8">
          <button className="lg:hidden" onClick={() => setShowMobile(true)}>
            <span
              className="material-symbols-outlined text-on-surface-variant"
              style={{ fontSize: 24 }}
            >
              menu
            </span>
          </button>
          <Link href="/" className="flex items-center gap-2">
            <KaboomLogo size={36} />
            <span className="text-2xl font-black italic tracking-tighter font-headline text-transparent bg-clip-text bg-gradient-to-br from-blue-300 to-blue-500">
              KABOOM!
            </span>
          </Link>
          <nav className="hidden lg:flex gap-6 items-center">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`font-headline tracking-tight text-sm uppercase transition-colors ${
                  pathname === link.href
                    ? "text-primary border-b-2 border-primary pb-1"
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
            <div className="flex items-center gap-2 px-4 py-1.5 bg-surface-container-highest rounded-lg border border-outline-variant/20">
              <span className="w-2 h-2 rounded-full bg-emerald" />
              <span className="font-headline text-sm font-bold text-primary tracking-wide">
                {walletBal} SOL
              </span>
            </div>
          )}
          <button
            onClick={() => (isConnected ? open("profile") : login())}
            className="bg-gradient-to-br from-primary to-primary-container text-on-primary px-5 py-2 font-headline text-xs font-bold uppercase tracking-widest hover:shadow-[0_0_15px_rgba(164,201,255,0.4)] transition-all active:scale-95 flex items-center gap-2"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              {isConnected ? "person" : "account_balance_wallet"}
            </span>
            <span className="hidden sm:inline">{isConnected ? shortAddr : "Connect"}</span>
          </button>
          <div className="relative" ref={notifRef}>
            <button
              onClick={() => setShowNotif(!showNotif)}
              className="relative p-2 hover:bg-surface-container-highest rounded-lg transition-all"
            >
              <span
                className="material-symbols-outlined text-on-surface-variant"
                style={{ fontSize: 22 }}
              >
                notifications
              </span>
            </button>
            {showNotif && (
              <div className="absolute right-0 top-12 w-80 bg-surface-container-low border border-outline-variant/15 shadow-[0_8px_32px_rgba(0,0,0,.6)] z-50">
                <div className="px-4 py-3 border-b border-outline-variant/10 flex justify-between">
                  <span className="font-headline text-xs font-bold tracking-widest uppercase text-primary">
                    System Status
                  </span>
                  <span
                    className={`font-headline text-[10px] tracking-widest ${riskIdx === 0 ? "text-emerald" : riskIdx === 1 ? "text-amber" : "text-error"}`}
                  >
                    {RISK_LABELS[riskIdx]}
                  </span>
                </div>
                <div className="max-h-[260px] overflow-y-auto">
                  <NR
                    icon="shield"
                    color="text-emerald"
                    label="VAULT"
                    msg={`Health: ${vaultHealth ?? "—"}%`}
                  />
                  <NR
                    icon="account_balance"
                    color="text-primary"
                    label="BALANCE"
                    msg={`${vaultBal ? (Number(vaultBal) / LAMPORTS_PER_SOL).toFixed(2) : "—"} SOL`}
                  />
                  <NR
                    icon="enhanced_encryption"
                    color="text-secondary"
                    label="FAIRNESS"
                    msg="SHA-256 Commit-Reveal"
                  />
                  <NR icon="speed" color="text-tertiary" label="CHAIN" msg={CLUSTER_LABEL[CLUSTER]} />
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => open("settings")}
            className="hidden lg:block p-2 hover:bg-surface-container-highest rounded-lg transition-all"
          >
            <span
              className="material-symbols-outlined text-on-surface-variant"
              style={{ fontSize: 22 }}
            >
              settings
            </span>
          </button>
        </div>
      </header>
      {showMobile && <MobileDrawer onClose={() => setShowMobile(false)} />}
    </>
  );
}

function NR({ icon, color, label, msg }: { icon: string; color: string; label: string; msg: string }) {
  return (
    <div className="px-4 py-3 border-b border-outline-variant/[0.05]">
      <div className="flex items-center gap-2 mb-1">
        <span className={`material-symbols-outlined mi ${color}`} style={{ fontSize: 16 }}>
          {icon}
        </span>
        <span className={`font-headline text-[10px] ${color} tracking-widest`}>{label}</span>
      </div>
      <p className="text-xs text-on-surface-variant">{msg}</p>
    </div>
  );
}
