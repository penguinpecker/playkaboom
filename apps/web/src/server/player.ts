import { PublicKey } from "@solana/web3.js";
import { decodePlayerStats, derivePlayerStatsPda } from "@playkaboom/sdk";
import { getConnection } from "./connection";
import { programId } from "./env";

/**
 * Fetches a player's referrer from their on-chain `PlayerStats`. Returns null
 * if no stats account or no referrer set. Cached for 60s in memory to avoid
 * an extra RPC on every reveal in the same session.
 */
const cache = new Map<string, { value: PublicKey | null; expires: number }>();

export async function fetchPlayerReferrer(player: PublicKey): Promise<PublicKey | null> {
  const key = player.toBase58();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.value;

  let value: PublicKey | null = null;
  try {
    const [pda] = derivePlayerStatsPda(programId(), player);
    const info = await getConnection().getAccountInfo(pda, "confirmed");
    if (info) {
      const stats = decodePlayerStats(info.data);
      value = stats.referrer;
    }
  } catch {
    /* swallow — caller treats null as "no referrer" */
  }
  cache.set(key, { value, expires: now + 60_000 });
  return value;
}
