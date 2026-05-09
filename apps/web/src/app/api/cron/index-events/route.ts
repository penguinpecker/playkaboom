import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { jsonError } from "@/server/api-helpers";
import { programId } from "@/server/env";
import { getConnection } from "@/server/connection";
import { supabaseAdmin } from "@/server/db/supabase";
import { ingestTransactions, type IndexableTx } from "@/server/indexer";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hard cap on signatures fetched per run — keeps within Vercel's 60s
 * maxDuration ceiling on the Hobby plan. The Railway cron tickler runs
 * this endpoint every 60s, so at this cap we can absorb ~bursts of
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
 * Vercel Cron entry point. Polls Solana for any new signatures touching the
 * program, fetches each tx, decodes events via SDK, applies via shared
 * `ingestTransactions`. Idempotent — relies on `processed_events` for dedupe.
 *
 * Auth: Vercel Cron sets `Authorization: Bearer <CRON_SECRET>` if CRON_SECRET
 * is set. We accept either that or the existing HELIUS_WEBHOOK_AUTH (so the
 * Helius webhook auth doubles as the cron secret if you only want one).
 */
export async function GET(req: NextRequest) {
  try {
    if (!authorise(req)) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const conn = getConnection();
    const program = programId();
    const db = supabaseAdmin();

    const { data: cursor } = await db
      .from("cron_indexer_state")
      .select("last_signature, last_slot")
      .eq("program", program.toBase58())
      .maybeSingle();

    // ?reset=1 forces a full re-scan from the most recent sig back to
    // MAX_SIGNATURES_PER_RUN. Use this once after the cursor has been
    // advanced past a failed-ingest sig — `processed_events` dedupe
    // guarantees no double-write. Behind CRON_SECRET, no public access.
    const url = new URL(req.url);
    const reset = url.searchParams.get("reset") === "1";
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
      await db.from("cron_indexer_state").upsert(
        {
          program: program.toBase58(),
          last_signature: cursor?.last_signature ?? null,
          last_slot: cursor?.last_slot ?? 0,
          last_run_at: new Date().toISOString(),
        },
        { onConflict: "program" },
      );
      return NextResponse.json({ ok: true, fetched: 0, processed: 0 });
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
    await db.from("cron_indexer_state").upsert(
      {
        program: program.toBase58(),
        last_signature: newest.signature,
        last_slot: newest.slot,
        last_run_at: new Date().toISOString(),
      },
      { onConflict: "program" },
    );

    return NextResponse.json({
      ok: true,
      fetched: newSignatures.length,
      processed: result.processed,
      skipped: result.skipped,
      errors: result.errors,
      newestSignature: newest.signature,
      newestSlot: newest.slot,
    });
  } catch (err) {
    return jsonError(err);
  }
}

function authorise(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : auth;
  const accepted = [process.env.CRON_SECRET, process.env.HELIUS_WEBHOOK_AUTH].filter(Boolean) as string[];
  return accepted.some((s) => s === token);
}
