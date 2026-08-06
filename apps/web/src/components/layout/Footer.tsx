"use client";
import Link from "next/link";
import { useModal } from "@/hooks/useModal";
import { PROGRAM_ID } from "@/lib/cluster";

// Footer links are chips, not bare text. They started at 7px and 20% opacity —
// in the DOM but unreadable — so terms, privacy and the socials effectively did
// not exist for anyone looking at the page. Chamfered so they speak the same
// console language as the game cards, and lit on hover with the same primary
// glow used elsewhere.
const chipCls =
  "chip-chamfer font-headline text-lg md:text-xl font-bold tracking-widest uppercase " +
  "px-8 py-5 bg-surface-container-high text-white " +
  "transition-all duration-200 " +
  "hover:bg-surface-container-highest hover:text-primary " +
  "hover:shadow-[0_0_22px_rgba(164,201,255,0.32)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

export function Footer() {
  const { open } = useModal();
  return (
    <footer className="flex flex-wrap items-center justify-between gap-x-10 gap-y-8 border-t border-outline-variant/20 bg-surface-container-low px-6 py-14 md:px-12 md:py-16">
      <div className="font-headline text-lg md:text-xl font-bold tracking-[.12em] uppercase text-white">
        © {new Date().getFullYear()} KABOOM! • Solana
      </div>
      <nav aria-label="Footer" className="flex flex-wrap items-center gap-4">
        <button onClick={() => open("fair")} className={chipCls}>
          Provably Fair
        </button>
        <a
          href="https://x.com/playkaboom"
          target="_blank"
          rel="noreferrer"
          aria-label="PlayKaboom on X (Twitter)"
          title="PlayKaboom on X (formerly Twitter)"
          className={chipCls}
        >
          X (Twitter) · @playkaboom
        </a>
        <a
          href="https://github.com/penguinpecker/playkaboom"
          target="_blank"
          rel="noreferrer"
          className={chipCls}
        >
          GitHub
        </a>
        <a
          href={`https://solscan.io/account/${PROGRAM_ID.toBase58()}`}
          target="_blank"
          rel="noreferrer"
          title="View the Kaboom program on Solscan"
          className={chipCls}
        >
          Solscan
        </a>
        <Link href="/terms" className={chipCls}>
          Terms
        </Link>
        <Link href="/privacy" className={chipCls}>
          Privacy
        </Link>
      </nav>
    </footer>
  );
}
