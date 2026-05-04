import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export function lamportsToSol(value: bigint | number | undefined): number {
  if (value === undefined) return 0;
  return Number(value) / LAMPORTS_PER_SOL;
}

export function formatSol(value: bigint | number | undefined, fractionDigits = 3): string {
  return lamportsToSol(value).toFixed(fractionDigits);
}

export function shortAddr(addr: string | undefined, lead = 4, trail = 4): string {
  if (!addr) return "";
  if (addr.length <= lead + trail + 1) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-trail)}`;
}
