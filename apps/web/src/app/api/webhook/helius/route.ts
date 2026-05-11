import { NextResponse, type NextRequest } from "next/server";
import { ingestTransactions, type IndexableTx } from "@/server/indexer";
import { jsonError } from "@/server/api-helpers";
import { verifyWebhookSignature } from "@/server/webhook-auth";
import { logger } from "@/server/logger";

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

/** Hard cap on the request body size we'll process. Vercel platform caps at
 *  ~4.5MB anyway; this is a defensive belt before we allocate. Helius's
 *  enhanced webhook payloads typically batch up to ~25 txs with full logs;
 *  1MB is plenty of headroom and rejects clearly-malicious oversized bodies. */
const MAX_BODY_BYTES = 1_000_000;

/** Lightweight runtime validator that doesn't pull zod into the webhook hot
 *  path. Returns null on the first malformed entry. */
function validateHeliusBatch(payload: unknown): HeliusTx[] | null {
  const arr = Array.isArray(payload) ? payload : [payload];
  const out: HeliusTx[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") return null;
    const t = item as Record<string, unknown>;
    if (typeof t.signature !== "string" || t.signature.length < 64 || t.signature.length > 130) {
      return null;
    }
    if (typeof t.slot !== "number" || !Number.isFinite(t.slot) || t.slot < 0) {
      return null;
    }
    out.push(t as unknown as HeliusTx);
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    // Read with explicit size guard. `req.text()` consumes the stream once;
    // we check Content-Length first as a cheap upfront filter.
    const cl = parseInt(req.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    await verifyWebhookSignature(req, raw);

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const heliusTxs = validateHeliusBatch(payload);
    if (!heliusTxs) {
      logger.warn({ rawLen: raw.length }, "[helius] malformed payload shape");
      return NextResponse.json({ error: "Invalid payload shape" }, { status: 400 });
    }

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
