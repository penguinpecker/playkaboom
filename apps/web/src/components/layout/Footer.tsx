"use client";
import { CLUSTER_LABEL, CLUSTER, accountExplorer } from "@/lib/cluster";
import { PROGRAM_ID } from "@/lib/cluster";

export function Footer() {
  return (
    <footer className="flex w-full flex-col items-center justify-between gap-4 border-t border-outline-variant/15 bg-surface-container-lowest px-12 py-8 md:flex-row">
      <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
        © {new Date().getFullYear()} PlayKaboom. {CLUSTER_LABEL[CLUSTER]}.
      </span>
      <a
        href={accountExplorer(PROGRAM_ID.toBase58())}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-[10px] text-on-surface-variant hover:text-primary"
      >
        {PROGRAM_ID.toBase58()}
      </a>
    </footer>
  );
}
