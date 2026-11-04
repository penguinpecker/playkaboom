import "server-only";
import { PublicKey } from "@solana/web3.js";
import { decodePlayerStats, derivePlayerStatsPda } from "@playkaboom/sdk";
import { getConnection } from "./connection";
import { programId } from "./env";

/**
 * Fetches a player's referrer from their on-chain `PlayerStats`. Returns null
 * if no stats account or no referrer set. Cached for 60s in memory to avoid
 * an extra RPC on every settle in the same session.
 *
 * An RPC failure THROWS and is never cached (F5): settle_vrf now fails 6022
 * when a referred player's referral PDA is missing, so reading an error as
 * "no referrer" would block that player's settles for the cache lifetime.
 */
const cache = new Map<string, { value: PublicKey | null; expires: number }>();

export async function fetchPlayerReferrer(player: PublicKey): Promise<PublicKey | null> {
  const key = player.toBase58();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.value;

  const [pda] = derivePlayerStatsPda(programId(), player);
  const info = await getConnection().getAccountInfo(pda, "confirmed");
  const value = info ? decodePlayerStats(info.data).referrer : null;
  cache.set(key, { value, expires: now + 60_000 });
  return value;
}

/** Drop the cached value, e.g. after a 6022 ReferralMismatch from settle_vrf. */
export function bustPlayerReferrer(player: PublicKey): void {
  cache.delete(player.toBase58());
}
