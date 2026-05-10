import {
  ComputeBudgetProgram,
  PublicKey,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

/**
 * Dynamic priority-fee helper for client-built game txs.
 *
 * Strategy in priority order:
 *   1. If `NEXT_PUBLIC_HELIUS_API_KEY` is set OR a same-origin proxy at
 *      `/api/priority-fee` is reachable, prefer Helius
 *      `getPriorityFeeEstimate` with `priorityLevel: "High" + recommended`.
 *      It returns a per-write-lock estimate and is materially more accurate
 *      than the cluster-wide fees from the public RPC.
 *   2. Fall back to the public RPC's `getRecentPrioritizationFees`
 *      filtered to txs touching our program; take 75th percentile + 25%
 *      headroom.
 *   3. Final fallback: a static MIN floor — never throw, missing fee data
 *      shouldn't block the user.
 *
 * 5s in-memory cache so consecutive game ixs don't each pay an extra
 * roundtrip; cap at MAX so a runaway market can't drain the player.
 */
const MIN_FEE_MICROLAMPORTS = 1_000;
const MAX_FEE_MICROLAMPORTS = 50_000;
const COMPUTE_LIMIT = 200_000;
const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  fee: number;
  expiresAt: number;
}
let cache: CacheEntry | null = null;

function clamp(n: number): number {
  return Math.max(MIN_FEE_MICROLAMPORTS, Math.min(MAX_FEE_MICROLAMPORTS, Math.ceil(n)));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return MIN_FEE_MICROLAMPORTS;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

async function heliusFee(programId: PublicKey): Promise<number | null> {
  // The browser sees only NEXT_PUBLIC_*; the server has HELIUS_API_KEY.
  // Either path is OK — we go directly to Helius from whichever side has
  // the key. (We deliberately don't proxy the call server-side from the
  // client to keep the round-trip count flat.)
  const key =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? process.env.HELIUS_API_KEY
      : null;
  if (!key) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "kaboom-priority-fee",
        method: "getPriorityFeeEstimate",
        params: [
          {
            accountKeys: [programId.toBase58()],
            options: { priorityLevel: "High", recommended: true },
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { priorityFeeEstimate?: number } };
    const v = body.result?.priorityFeeEstimate;
    return typeof v === "number" && Number.isFinite(v) ? clamp(v) : null;
  } catch {
    return null;
  }
}

async function recentFee(connection: Connection, programId: PublicKey): Promise<number> {
  if (cache && Date.now() < cache.expiresAt) return cache.fee;

  const helius = await heliusFee(programId);
  if (helius !== null) {
    cache = { fee: helius, expiresAt: Date.now() + CACHE_TTL_MS };
    return helius;
  }

  try {
    // The web3.js types lag the Solana RPC spec — the runtime call accepts
    // an array of pubkeys. Cast through unknown to get past the check.
    const rpc = connection as unknown as {
      getRecentPrioritizationFees: (
        keys?: PublicKey[],
      ) => Promise<{ slot: number; prioritizationFee: number }[]>;
    };
    const samples = await rpc.getRecentPrioritizationFees([programId]);
    const fees = samples
      .map((s) => s.prioritizationFee)
      .filter((f) => Number.isFinite(f) && f >= 0);
    const p75 = percentile(fees, 0.75);
    const fee = clamp(p75 * 1.25);
    cache = { fee, expiresAt: Date.now() + CACHE_TTL_MS };
    return fee;
  } catch {
    cache = { fee: MIN_FEE_MICROLAMPORTS, expiresAt: Date.now() + CACHE_TTL_MS };
    return MIN_FEE_MICROLAMPORTS;
  }
}

/** Returns ComputeBudget ixs to prepend to a tx — price + limit. */
export async function buildPriorityIxs(
  connection: Connection,
  programId: PublicKey,
): Promise<TransactionInstruction[]> {
  const microLamports = await recentFee(connection, programId);
  return [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT }),
  ];
}
