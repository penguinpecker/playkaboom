"use client";
import Link from "next/link";
import { useModal } from "@/hooks/useModal";
import { KaboomLogo } from "@/components/ui/KaboomLogo";

const LINKS = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/play", label: "Play", icon: "bomb" },
  { href: "/leaderboard", label: "Leaderboard", icon: "emoji_events" },
  { href: "/referrals", label: "Referrals", icon: "diversity_3" },
  { href: "/logs", label: "Event Logs", icon: "receipt_long" },
  { href: "/vault", label: "Vault", icon: "account_balance" },
];

export function MobileDrawer({ onClose }: { onClose: () => void }) {
  const { open } = useModal();
  return (
    <div
      className="fixed inset-0 z-[95] modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-60 h-full bg-surface-container-low border-r border-outline-variant/10 p-5 animate-scale-in">
        <div className="flex items-center gap-2 mb-6">
          <KaboomLogo size={28} />
          <span className="font-headline text-base font-black italic text-transparent bg-clip-text bg-gradient-to-r from-primary to-primary-container">
            KABOOM!
          </span>
        </div>
        <nav className="space-y-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={onClose}
              className="flex items-center gap-3 px-3 py-2.5 font-headline text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:text-primary hover:bg-surface-container-highest/40 transition-all"
            >
              <span className="material-symbols-outlined text-lg mi">{l.icon}</span>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="mt-6 pt-4 border-t border-outline-variant/10 space-y-1">
          <button
            onClick={() => {
              open("fair");
              onClose();
            }}
            className="flex items-center gap-3 px-3 py-1.5 font-headline text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/50 hover:text-primary w-full"
          >
            <span className="material-symbols-outlined text-sm">verified_user</span>Provably Fair
          </button>
        </div>
      </div>
    </div>
  );
}
