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
export async function indexFreshSignature(signature: string): Promise<void> {
  try {
    const conn = getConnection();
    const tx = await conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) {
      logger.warn({ signature }, "inline-ingest: tx not found");
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
