import { Connection } from "@solana/web3.js";
import { erRpc, solanaRpc } from "./env";

let cached: Connection | null = null;
export function getConnection(): Connection {
  if (!cached) {
    cached = new Connection(solanaRpc(), {
      commitment: "confirmed",
      disableRetryOnRateLimit: false,
    });
  }
  return cached;
}

let cachedEr: Connection | null = null;
/** MagicBlock ephemeral rollup (pinned validator's node), for house ER txs and reads. */
export function getErConnection(): Connection {
  if (!cachedEr) cachedEr = new Connection(erRpc(), { commitment: "confirmed" });
  return cachedEr;
}

/**
 * Measured milliseconds per slot, from the last ~10 min of performance samples,
 * cached 10 min. Mainnet slots run well under the nominal 400 ms (214 ms
 * measured 2026-11-05), so a hard-coded 400 roughly halved every slot-counted
 * window and doubled every ETA. On RPC failure the last measurement stands;
 * before any measurement, FALLBACK_MS_PER_SLOT, rounded DOWN from mainnet so
 * slot-counted waits err long, never short.
 */
export const FALLBACK_MS_PER_SLOT = 200;
const SLOT_MS_TTL_MS = 10 * 60_000;
let slotMsCache: { ms: number; at: number } | null = null;
export async function msPerSlot(conn: Pick<Connection, "getRecentPerformanceSamples"> = getConnection()): Promise<number> {
  if (slotMsCache && Date.now() - slotMsCache.at < SLOT_MS_TTL_MS) return slotMsCache.ms;
  try {
    const samples = await conn.getRecentPerformanceSamples(10);
    let slots = 0;
    let secs = 0;
    for (const s of samples) {
      slots += s.numSlots;
      secs += s.samplePeriodSecs;
    }
    if (slots > 0 && secs > 0) slotMsCache = { ms: (secs * 1000) / slots, at: Date.now() };
  } catch {
    /* keep the last measurement */
  }
  return slotMsCache?.ms ?? FALLBACK_MS_PER_SLOT;
}
