"use client";
import Link from "next/link";
import { useModal } from "@/hooks/useModal";

const linkCls =
  "font-headline text-[7px] tracking-widest uppercase text-on-surface-variant/20 hover:text-primary transition-colors";

export function Footer() {
  const { open } = useModal();
  return (
    <footer className="flex flex-wrap justify-between items-center px-4 md:px-6 py-2.5 gap-x-4 gap-y-2 bg-surface-container-low border-t border-outline-variant/[0.06]">
      <div className="font-headline text-[7px] tracking-[.08em] uppercase text-on-surface-variant/25">
        © {new Date().getFullYear()} KABOOM! • Solana
      </div>
      <div className="flex flex-wrap gap-4">
        <button onClick={() => open("fair")} className={linkCls}>
          Provably Fair
        </button>
        <a href="https://x.com/playkaboom" target="_blank" rel="noreferrer" className={linkCls}>
          X
        </a>
        <a
          href="https://github.com/penguinpecker/playkaboom"
          target="_blank"
          rel="noreferrer"
          className={linkCls}
        >
          GitHub
        </a>
        <a href="https://solscan.io" target="_blank" rel="noreferrer" className={linkCls}>
          Solscan
        </a>
        <Link href="/terms" className={linkCls}>
          Terms
        </Link>
        <Link href="/privacy" className={linkCls}>
          Privacy
        </Link>
      </div>
    </footer>
  );
}
