"use client";
import { useQuery } from "@tanstack/react-query";

/**
 * SOL/USD from our own cached route (app/api/price/sol). Keyless Pyth Hermes
 * now answers 401 with no CORS header, so the browser no longer calls it.
 */
const PRICE_URL = "/api/price/sol";

interface PythPrice {
  /** USD value with high precision (e.g. 153.42). */
  usd: number;
  /** Confidence interval in USD (0: the public sources don't report one). */
  confidence: number;
  /** When the server fetched the price (unix seconds). */
  publishTime: number;
}

export async function fetchPythSolUsd(): Promise<PythPrice | null> {
  try {
    const res = await fetch(PRICE_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { usd?: unknown; publishTime?: unknown };
    if (typeof json.usd !== "number" || !(json.usd > 0)) return null;
    return {
      usd: json.usd,
      confidence: 0,
      publishTime: typeof json.publishTime === "number" ? json.publishTime : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Polls the SOL/USD route every 30s (its cache window). Returns null until the
 * first fetch lands. Used for the "≈ $X.XX" overlay in BetControls + Vault.
 */
export function usePythSolUsd() {
  return useQuery({
    queryKey: ["pyth", "sol-usd"],
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: fetchPythSolUsd,
  });
}

/** Convert a SOL number to USD using current Pyth price. Returns null if unavailable. */
export function solToUsd(sol: number, price: PythPrice | null | undefined): number | null {
  if (!price) return null;
  return sol * price.usd;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}
