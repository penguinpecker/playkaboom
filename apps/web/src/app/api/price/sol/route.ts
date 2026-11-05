import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SOL/USD for the "≈ $" hints on /play. Keyless Pyth Hermes now answers 401
 * with no CORS header, so the server reads a keyless public price instead,
 * trying each source in order, and every caller shares one fetch per 30 s.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOURCES: Array<{ url: string; read: (json: unknown) => unknown }> = [
  {
    url: `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
    read: (j) => (j as Record<string, { usdPrice?: number }> | null)?.[SOL_MINT]?.usdPrice,
  },
  {
    url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    read: (j) => (j as { data?: { amount?: string } } | null)?.data?.amount,
  },
];
const TTL_MS = 30_000;

async function fetchSolUsd(): Promise<number | null> {
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
      if (!res.ok) continue;
      const usd = Number(s.read(await res.json()));
      if (Number.isFinite(usd) && usd > 0) return usd;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

// ponytail: per-process cache; Railway runs one replica (railway.json).
let cached: { at: number; usd: Promise<number | null> } | null = null;

export async function GET() {
  if (!cached || Date.now() - cached.at >= TTL_MS) cached = { at: Date.now(), usd: fetchSolUsd() };
  const { at, usd: pending } = cached;
  const usd = await pending;
  if (usd === null) {
    return NextResponse.json({ error: "price unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    { usd, publishTime: Math.floor(at / 1000) },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}
