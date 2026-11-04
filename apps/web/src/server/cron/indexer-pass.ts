import "server-only";
import { programId } from "../env";
import { getConnection } from "../connection";
import { query, upsert } from "../db/pg";
import { ingestTransactions, type IndexableTx } from "../indexer";
import { logger } from "../logger";

/** Hard cap on signatures fetched per run. Sized for the old 60 s serverless
 * ceiling and kept: the relay ticks every 60 s, so at this cap we can absorb ~bursts of
 * 300/min before falling behind. Lowered from 600 on 2026-05-09 because
 * the manual `?reset=1` rescue (which fetches a fresh batch from head)
 * was hitting the 60s timeout when processed_events was empty — at
 * ~150ms per getTransaction RPC call on Alchemy mainnet, 300 sigs
 * comfortably finishes in ~45s. If we ever bump to Vercel Pro
 * (300s maxDuration) this can go back up. */
const MAX_SIGNATURES_PER_RUN = 300;
const PAGE_SIZE = 100;
/** Safety window: every cron run also re-fetches the last N sigs even if
 * they're "before" the cursor, then relies on `processed_events` dedupe to
 * skip ones already indexed. Without this, an inline-ingest race (RPC
 * confirmation lag → getTransaction returns null → silent skip) becomes
 * permanent because the next cron run uses `until: <cursor>` which excludes
 * the missed sig forever. 100 sig overlap covers ~1h of bursty mainnet
 * activity — well past any plausible RPC propagation delay. */
const SAFETY_WINDOW_SIGNATURES = 100;

/**
 * Indexer pass: poll Solana for new signatures touching the program, fetch each
 * tx, decode events via the SDK and apply them with `ingestTransactions`.
 * Idempotent (processed_events dedupe). `reset` rescans from the head,
 * ignoring the cursor (the route gates it behind its own secret + confirm).
 */
export async function indexProgramEvents(opts: { reset?: boolean } = {}) {
  const reset = opts.reset ?? false;
  const conn = getConnection();
  const program = programId();
  // A failed read means "no cursor", as it did with supabase-js.
  const [cursor] = await query<{ last_signature: string | null; last_slot: number | null }>(
    "select last_signature, last_slot from public.cron_indexer_state where program = $1",
    [program.toBase58()],
  ).catch(() => []);

  const until = reset ? undefined : (cursor?.last_signature ?? undefined);

  // Page through getSignaturesForAddress until we hit `until` or the cap.
  // After hitting `until`, ALSO fetch SAFETY_WINDOW_SIGNATURES sigs
  // immediately before it — handles the inline-ingest race-condition
  // failure mode where a sig was already past the cursor but was never
  // actually written to the DB. processed_events dedup means re-running
  // is safe (already-indexed sigs become a no-op).
  const newSignatures: { signature: string; slot: number; blockTime?: number; err?: unknown }[] = [];
  let before: string | undefined;
  let hitCursor = false;
  pages: for (let page = 0; page < Math.ceil(MAX_SIGNATURES_PER_RUN / PAGE_SIZE); page++) {
    // Apply `until` only on pages BEFORE we hit it. After we've hit it,
    // drop the constraint so we can dredge the safety window.
    const sigs = await conn.getSignaturesForAddress(
      program,
      { limit: PAGE_SIZE, before, ...(hitCursor ? {} : { until }) },
      "confirmed",
    );
    if (sigs.length === 0) break;
    for (const s of sigs) {
      newSignatures.push({
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime ?? undefined,
        err: s.err,
      });
      if (newSignatures.length >= MAX_SIGNATURES_PER_RUN) break pages;
    }
    before = sigs[sigs.length - 1]?.signature;
    // If the page returned fewer than PAGE_SIZE, getSignaturesForAddress
    // hit `until` (or end-of-history). Switch into safety-window mode
    // and pull SAFETY_WINDOW_SIGNATURES more before terminating.
    if (sigs.length < PAGE_SIZE && !reset) {
      if (hitCursor) break;
      hitCursor = true;
      // Now refresh max budget to the safety window and keep paging.
      for (let k = 0; k < Math.ceil(SAFETY_WINDOW_SIGNATURES / PAGE_SIZE); k++) {
        const safetySigs = await conn.getSignaturesForAddress(
          program,
          { limit: PAGE_SIZE, before },
          "confirmed",
        );
        if (safetySigs.length === 0) break pages;
        for (const s of safetySigs) {
          newSignatures.push({
            signature: s.signature,
            slot: s.slot,
            blockTime: s.blockTime ?? undefined,
            err: s.err,
          });
        }
        before = safetySigs[safetySigs.length - 1]?.signature;
        if (safetySigs.length < PAGE_SIZE) break pages;
      }
      break pages;
    }
  }

  if (newSignatures.length === 0) {
    // Cursor writes were never error-checked (supabase-js returned them).
    await upsert(
      "cron_indexer_state",
      {
        program: program.toBase58(),
        last_signature: cursor?.last_signature ?? null,
        last_slot: cursor?.last_slot ?? 0,
        last_run_at: new Date().toISOString(),
      },
      ["program"],
    ).catch(() => undefined);
    return { ok: true, fetched: 0, processed: 0 };
  }

  // Order oldest → newest for in-order indexing (events depend on prior state).
  newSignatures.reverse();

  // Fetch full transactions in batches to get logs.
  const txs: IndexableTx[] = [];
  for (let i = 0; i < newSignatures.length; i += 25) {
    const batch = newSignatures.slice(i, i + 25);
    const results = await Promise.all(
      batch.map((s) =>
        conn
          .getTransaction(s.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })
          .catch((err: unknown) => {
            logger.warn(
              { sig: s.signature, err: err instanceof Error ? err.message : err },
              "getTransaction failed",
            );
            return null;
          }),
      ),
    );
    for (let j = 0; j < batch.length; j++) {
      const meta = results[j]?.meta;
      const sigInfo = batch[j]!;
      txs.push({
        signature: sigInfo.signature,
        slot: sigInfo.slot,
        blockTime: sigInfo.blockTime ?? results[j]?.blockTime ?? undefined,
        logMessages: meta?.logMessages ?? [],
        err: sigInfo.err ?? meta?.err,
      });
    }
  }

  const result = await ingestTransactions(txs);

  // Advance the cursor — the LAST element of newSignatures (already
  // reversed, so it's the newest) is what we'll mark as done.
  const newest = newSignatures[newSignatures.length - 1]!;
  await upsert(
    "cron_indexer_state",
    {
      program: program.toBase58(),
      last_signature: newest.signature,
      last_slot: newest.slot,
      last_run_at: new Date().toISOString(),
    },
    ["program"],
  ).catch(() => undefined);

  return {
    ok: true,
    fetched: newSignatures.length,
    processed: result.processed,
    skipped: result.skipped,
    errors: result.errors,
    errorDetails: result.errorDetails,
    newestSignature: newest.signature,
    newestSlot: newest.slot,
  };
}
