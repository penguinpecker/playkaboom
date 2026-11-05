import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export function lamportsToSol(value: bigint | number | undefined): number {
  if (value === undefined) return 0;
  return Number(value) / LAMPORTS_PER_SOL;
}

export function formatSol(value: bigint | number | undefined, fractionDigits = 3): string {
  return lamportsToSol(value).toFixed(fractionDigits);
}

/**
 * SOL amount for display. Below 0.01 it keeps up to 4 significant figures, so a
 * real 0.0001199 SOL win reads "0.0001199", not "0.000".
 */
export function formatSolAmount(sol: number, fractionDigits = 3): string {
  const abs = Math.abs(sol);
  if (abs === 0 || abs >= 0.01 || !Number.isFinite(sol)) return sol.toFixed(fractionDigits);
  const decimals = Math.min(9, 3 - Math.floor(Math.log10(abs)));
  return sol.toFixed(decimals).replace(/\.?0+$/, "");
}

/** K Points for display: whole points with thousands separators ("12,345"); missing reads "0". */
export function formatKPoints(points: number | undefined): string {
  return Math.trunc(points || 0).toLocaleString("en-US");
}

/** "1.6-day" from /api/vault/state withdrawCooldownDays; null until it loads. */
export function formatCooldown(days: number | undefined): string | null {
  return days ? `${days.toFixed(1)}-day` : null;
}

/** "12s ago" / "5m ago" / "3h ago" / "2d ago", same buckets as the live feed. */
export function formatAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "now";
  const sec = Math.floor((now - Date.parse(iso)) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function shortAddr(addr: string | undefined, lead = 4, trail = 4): string {
  if (!addr) return "";
  if (addr.length <= lead + trail + 1) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-trail)}`;
}
