"use client";
import { useModal } from "@/hooks/useModal";

export function Footer() {
  const { open } = useModal();
  return (
    <footer className="flex justify-between items-center px-4 md:px-6 py-2.5 bg-surface-container-low border-t border-outline-variant/[0.06]">
      <div className="font-headline text-[7px] tracking-[.08em] uppercase text-on-surface-variant/25">
        © {new Date().getFullYear()} KABOOM! • Solana
      </div>
      <div className="flex gap-4">
        <button
          onClick={() => open("fair")}
          className="font-headline text-[7px] tracking-widest uppercase text-on-surface-variant/20 hover:text-primary transition-colors"
        >
          Provably Fair
        </button>
        <a
          href="https://github.com/penguinpecker/kaboom-solana"
          target="_blank"
          rel="noreferrer"
          className="font-headline text-[7px] tracking-widest uppercase text-on-surface-variant/20 hover:text-primary transition-colors"
        >
          GitHub
        </a>
        <a
          href="https://solscan.io"
          target="_blank"
          rel="noreferrer"
          className="font-headline text-[7px] tracking-widest uppercase text-on-surface-variant/20 hover:text-primary transition-colors"
        >
          Solscan
        </a>
      </div>
    </footer>
  );
}
