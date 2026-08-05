"use client";
import Link from "next/link";
import { useModal } from "@/hooks/useModal";
import { PROGRAM_ID } from "@/lib/cluster";

// Was text-[7px] at 20% opacity — present in the DOM but effectively
// unreadable, which is why the terms, privacy and social links read as
// missing. Kept deliberately quiet (this is a footer, not a call to action)
// but at a size and contrast a person can actually resolve.
const linkCls =
  "font-headline text-[10px] tracking-widest uppercase text-on-surface-variant/60 hover:text-primary transition-colors";

export function Footer() {
  const { open } = useModal();
  return (
    <footer className="flex flex-wrap justify-between items-center px-4 md:px-6 py-2.5 gap-x-4 gap-y-2 bg-surface-container-low border-t border-outline-variant/[0.06]">
      <div className="font-headline text-[10px] tracking-[.08em] uppercase text-on-surface-variant/45">
        © {new Date().getFullYear()} KABOOM! • Solana
      </div>
      <div className="flex flex-wrap gap-4">
        <button onClick={() => open("fair")} className={linkCls}>
          Provably Fair
        </button>
        <a
          href="https://x.com/playkaboom"
          target="_blank"
          rel="noreferrer"
          aria-label="PlayKaboom on X (Twitter)"
          title="PlayKaboom on X (formerly Twitter)"
          className={linkCls}
        >
          X (Twitter) · @playkaboom
        </a>
        <a
          href="https://github.com/penguinpecker/playkaboom"
          target="_blank"
          rel="noreferrer"
          className={linkCls}
        >
          GitHub
        </a>
        <a
          href={`https://solscan.io/account/${PROGRAM_ID.toBase58()}`}
          target="_blank"
          rel="noreferrer"
          title="View the Kaboom program on Solscan"
          className={linkCls}
        >
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
