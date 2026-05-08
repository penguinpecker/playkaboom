import "server-only";
import { getConnection } from "@/server/connection";
import { ingestTransactions, type IndexableTx } from "@/server/indexer";
import { logger } from "@/server/logger";

/**
 * Fetch a freshly-confirmed signature from RPC and feed it through the
 * shared indexer so the global activity feed (and player_stats, referrals,
 * lp_*, etc.) reflect the new on-chain state within a few seconds — instead
 * of waiting up to 5 min for the next cron tick.
 *
 * Idempotent via `processed_events` dedup inside `ingestTransactions`, so
 * a later cron run that re-fetches the same sig is a no-op.
 *
 * Errors are swallowed: indexing is best-effort and must NEVER block the
 * gameplay path. Cron will catch up if this call fails.
 */
/** Retry getTransaction up to N times with backoff, because the RPC node we
 *  query can lag the cluster by 1–3s after a settle tx confirms. Without
 *  this retry, the first call frequently returns null, inline-ingest
 *  silently no-ops, and the game disappears until the next cron sweep. */
const RPC_RETRIES = 4;
const RPC_BACKOFF_MS = [400, 800, 1500, 2500];

export async function indexFreshSignature(signature: string): Promise<void> {
  try {
    const conn = getConnection();
    let tx = null;
    for (let i = 0; i < RPC_RETRIES; i++) {
      tx = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) break;
      // RPC hasn't seen the sig yet; wait and retry. Total worst-case
      // 5.2s — well within the per-request budget; the user's UI is
      // already in "settling..." state at this point.
      await new Promise((r) => setTimeout(r, RPC_BACKOFF_MS[i] ?? 2500));
    }
    if (!tx) {
      logger.warn({ signature, retries: RPC_RETRIES }, "inline-ingest: tx not found after retries");
      return;
    }
    const indexable: IndexableTx = {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? undefined,
      logMessages: tx.meta?.logMessages ?? [],
      err: tx.meta?.err ?? null,
    };
    const result = await ingestTransactions([indexable]);
    logger.info({ signature, ...result }, "inline-ingest: done");
  } catch (err) {
    logger.warn({ err: (err as Error).message, signature }, "inline-ingest: failed (cron will catch up)");
  }
}
