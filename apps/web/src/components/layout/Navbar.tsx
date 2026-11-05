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
import { useGameLink } from "./status-host";
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
  const toGame = useGameLink();
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
    // Mobile background-tab suspension drifts setInterval to a halt over
    // hours; re-fire on visibility/focus/online to recover instantly.
    const onWake = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void f();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      cancelled = true;
      clearInterval(i);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [publicKey, connection]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setShowNotif(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowNotif(false);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, []);

  return (
    <>
      <header className="sticky top-0 w-full z-50 flex justify-between items-center px-3 sm:px-6 h-14 sm:h-16 bg-surface-container-low/90 backdrop-blur-xl shadow-[0_0_20px_rgba(208,188,255,0.1)]">
        <div className="flex items-center gap-3 sm:gap-8 min-w-0">
          <button className="lg:hidden flex-shrink-0" onClick={() => setShowMobile(true)} aria-label="Menu" aria-expanded={showMobile}>
            <span
              className="material-symbols-outlined text-on-surface-variant"
              style={{ fontSize: 24 }}
            >
              menu
            </span>
          </button>
          <Link {...toGame("/")} className="flex items-center flex-shrink-0" aria-label="Kaboom — home">
            <span className="lg:hidden"><KaboomLogo size={36} glow /></span>
            <span className="hidden lg:inline"><KaboomLogo size={48} glow /></span>
          </Link>
          <nav className="hidden lg:flex gap-6 items-center">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                {...toGame(link.href)}
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
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          {isConnected && (
            <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-1 sm:py-1.5 bg-surface-container-highest rounded-lg border border-outline-variant/20 min-w-0">
              <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-emerald flex-shrink-0" />
              <span className="font-headline text-xs sm:text-sm font-bold text-primary tracking-wide whitespace-nowrap">
                {walletBal} SOL
              </span>
            </div>
          )}
          <button
            onClick={() => (isConnected ? open("profile") : login())}
            aria-label={isConnected ? `Wallet ${shortAddr}` : "Connect"}
            className="bg-gradient-to-br from-primary to-primary-container text-on-primary px-3 sm:px-5 py-1.5 sm:py-2 font-headline text-xs font-bold uppercase tracking-widest hover:shadow-[0_0_15px_rgba(164,201,255,0.4)] transition-all active:scale-95 flex items-center gap-2 flex-shrink-0"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }} aria-hidden="true">
              {isConnected ? "person" : "account_balance_wallet"}
            </span>
            <span className="hidden sm:inline">{isConnected ? shortAddr : "Connect"}</span>
          </button>
          <div className="relative hidden sm:block" ref={notifRef}>
            <button
              onClick={() => setShowNotif(!showNotif)}
              aria-label="System status"
              className="relative p-2 hover:bg-surface-container-highest rounded-lg transition-all"
            >
              <span
                className="material-symbols-outlined text-on-surface-variant"
                style={{ fontSize: 22 }}
                aria-hidden="true"
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
                    msg="Per-click MagicBlock VRF"
                  />
                  <NR icon="speed" color="text-tertiary" label="CHAIN" msg={CLUSTER_LABEL[CLUSTER]} />
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => open("settings")}
            aria-label="Settings"
            className="hidden lg:block p-2 hover:bg-surface-container-highest rounded-lg transition-all"
          >
            <span
              className="material-symbols-outlined text-on-surface-variant"
              style={{ fontSize: 22 }}
              aria-hidden="true"
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
        <span className={`material-symbols-outlined mi ${color}`} style={{ fontSize: 16 }} aria-hidden="true">
          {icon}
        </span>
        <span className={`font-headline text-[10px] ${color} tracking-widest`}>{label}</span>
      </div>
      <p className="text-xs text-on-surface-variant">{msg}</p>
    </div>
  );
}
