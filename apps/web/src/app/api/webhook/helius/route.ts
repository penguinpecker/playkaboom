import { NextResponse, type NextRequest } from "next/server";
import { ingestTransactions, type IndexableTx } from "@/server/indexer";
import { jsonError } from "@/server/api-helpers";
import { verifyWebhookSignature } from "@/server/webhook-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Helius enhanced-webhook payload (subset). Adapted into IndexableTx and
 * passed to the shared `ingestTransactions` indexer. */
interface HeliusTx {
  signature: string;
  slot: number;
  blockTime?: number;
  meta?: { logMessages?: string[]; err?: unknown };
  transactionError?: unknown;
  logMessages?: string[];
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    await verifyWebhookSignature(req, raw);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const heliusTxs: HeliusTx[] = Array.isArray(payload)
      ? (payload as HeliusTx[])
      : ([payload] as HeliusTx[]);
    const txs: IndexableTx[] = heliusTxs.map((t) => ({
      signature: t.signature,
      slot: t.slot,
      blockTime: t.blockTime,
      logMessages: t.meta?.logMessages ?? t.logMessages ?? [],
      err: t.transactionError ?? t.meta?.err,
    }));
    const result = await ingestTransactions(txs);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(err);
  }
}
