import {
  ComputeBudgetProgram,
  PublicKey,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

/**
 * Dynamic priority-fee helper for client-built game txs. Without these, our
 * txs go in at 0 micro-lamports and get evicted under congestion (memecoin
 * launches, NFT mints, anything that pumps the network). Adding a modest
 * fee keeps us in the leader's queue while not turning into a fee race.
 *
 * Strategy:
 *   1. `getRecentPrioritizationFees(programId)` returns the fees paid by
 *      recent txs touching our program in the last 150 slots.
 *   2. Take the 75th percentile + 25% headroom as our floor.
 *   3. Cap at MAX_FEE_MICROLAMPORTS so a runaway fee market doesn't drain
 *      the player's wallet — at this cap and our 200k CU limit, a tx costs
 *      at most ~1000 lamports extra (≈ $0.0002 at $200/SOL).
 *   4. Hold a 5s in-memory cache so consecutive game ixs don't each cost
 *      one extra RPC roundtrip.
 *
 * If the RPC errors, fall back to a static MIN floor — never throw, since
 * a missing priority fee shouldn't block the user from playing.
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return MIN_FEE_MICROLAMPORTS;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

async function recentFee(connection: Connection, programId: PublicKey): Promise<number> {
  if (cache && Date.now() < cache.expiresAt) return cache.fee;
  try {
    // The web3.js types lag the Solana RPC spec — the runtime call is fine
    // and accepts an array of pubkeys, but the .d.ts on older versions
    // doesn't list it. Cast through unknown to get past the check.
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
    const headroom = Math.ceil(p75 * 1.25);
    const fee = Math.max(MIN_FEE_MICROLAMPORTS, Math.min(MAX_FEE_MICROLAMPORTS, headroom));
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
