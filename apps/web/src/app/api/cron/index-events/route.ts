import { NextResponse, type NextRequest } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { jsonError } from "@/server/api-helpers";
import { programId, solanaRpc } from "@/server/env";
import { supabaseAdmin } from "@/server/db/supabase";
import { ingestTransactions, type IndexableTx } from "@/server/indexer";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hard cap on signatures fetched per run — keeps within Vercel function limits.
 * At 1 cron-min cadence this means we can absorb ~bursts of 600/min before
 * falling behind. Plenty for devnet and early mainnet. */
const MAX_SIGNATURES_PER_RUN = 600;
const PAGE_SIZE = 100;

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

    const conn = new Connection(solanaRpc(), "confirmed");
    const program = programId();
    const db = supabaseAdmin();

    const { data: cursor } = await db
      .from("cron_indexer_state")
      .select("last_signature, last_slot")
      .eq("program", program.toBase58())
      .maybeSingle();

    const until = cursor?.last_signature ?? undefined;

    // Page through getSignaturesForAddress until we hit `until` or the cap.
    const newSignatures: { signature: string; slot: number; blockTime?: number; err?: unknown }[] = [];
    let before: string | undefined;
    pages: for (let page = 0; page < Math.ceil(MAX_SIGNATURES_PER_RUN / PAGE_SIZE); page++) {
      const sigs = await conn.getSignaturesForAddress(
        program,
        { limit: PAGE_SIZE, before, until },
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
      if (sigs.length < PAGE_SIZE) break;
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
