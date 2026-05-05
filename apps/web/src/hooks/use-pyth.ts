"use client";
import { useQuery } from "@tanstack/react-query";

/**
 * Pyth Hermes — SOL/USD price feed.
 * https://docs.pyth.network/price-feeds/contract-addresses/solana
 */
const SOL_USD_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_URL = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${SOL_USD_FEED}&parsed=true`;

interface PythPrice {
  /** USD value with high precision (e.g. 153.42). */
  usd: number;
  /** Confidence interval in USD. */
  confidence: number;
  /** Pyth publish time (unix seconds). */
  publishTime: number;
}

/**
 * Polls Pyth Hermes every 15s for SOL/USD. Returns null until the first
 * fetch lands. Used for the "≈ $X.XX" overlay in BetControls + Vault.
 */
export function usePythSolUsd() {
  return useQuery({
    queryKey: ["pyth", "sol-usd"],
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PythPrice | null> => {
      try {
        const res = await fetch(HERMES_URL, { cache: "no-store" });
        if (!res.ok) return null;
        const json = (await res.json()) as {
          parsed?: Array<{
            price?: { price: string; expo: number; conf: string; publish_time: number };
          }>;
        };
        const p = json.parsed?.[0]?.price;
        if (!p) return null;
        const scale = Math.pow(10, p.expo); // expo is negative for USD prices
        return {
          usd: Number(p.price) * scale,
          confidence: Number(p.conf) * scale,
          publishTime: p.publish_time,
        };
      } catch {
        return null;
      }
    },
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
