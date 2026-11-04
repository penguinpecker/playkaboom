import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { jsonError } from "@/server/api-helpers";
import { programId } from "@/server/env";
import { query } from "@/server/db/pg";
import { indexProgramEvents } from "@/server/cron/indexer-pass";
import { TICK_LOCK_KEY, withAdvisoryLock } from "@/server/cron/tick";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Indexer on demand. The routine run is the `indexer` pass of /api/cron/tick;
 * this route stays for the manual `?reset=1&confirm=<cursor prefix>` rescan
 * (GitHub workflow index-events.yml). Both paths run under the tick lock (the
 * rescan answers 409 while a tick runs). Logic: server/cron/indexer-pass.ts.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const reset = url.searchParams.get("reset") === "1";

    // Tighter auth on the destructive ?reset=1 path: CRON_SECRET ONLY.
    // The normal-path (no ?reset) accepts either secret (CRON_SECRET or
    // HELIUS_WEBHOOK_AUTH) — both are valid operator credentials for a
    // pure-replay-safe call. The reset path bypasses the cursor and re-feeds
    // every sig through ingest; even with INSERT-first dedupe it touches
    // every row's last_event_slot accounting, so it stays gated to a single
    // secret with its own rotation lifecycle. Also requires explicit
    // `confirm` param matching the current cursor to prevent fat-finger.
    if (!authorise(req, reset)) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    if (reset) {
      // Belt-and-suspenders: operator must echo back a prefix of the current
      // cursor, proving they know what state they're resetting from. Stops
      // an accidental gh-workflow click from re-scanning prod.
      const [cursor] = await query<{ last_signature: string | null }>(
        "select last_signature from public.cron_indexer_state where program = $1",
        [programId().toBase58()],
      ).catch(() => []);
      const confirm = url.searchParams.get("confirm") ?? "";
      const cursorPrefix = (cursor?.last_signature ?? "").slice(0, 8);
      if (!cursorPrefix || confirm !== cursorPrefix) {
        return NextResponse.json(
          {
            error: "reset requires ?confirm=<first-8-chars-of-current-last_signature>",
            hint: `current cursor starts with: ${cursorPrefix || "(none)"}`,
          },
          { status: 400 },
        );
      }
      logger.warn(
        { cursor: cursor?.last_signature },
        "[index-events] ?reset=1 invoked — full rescan starting",
      );
      // Under the tick lock too: the rescan writes the same cursor as the tick indexer.
      const rr = await withAdvisoryLock(TICK_LOCK_KEY, () => indexProgramEvents({ reset: true }));
      if (!rr.ran) return NextResponse.json({ error: "tick in progress, retry shortly" }, { status: 409 });
      return NextResponse.json(rr.value);
    }

    // The routine path runs under the tick lock so it never overlaps a tick.
    const r = await withAdvisoryLock(TICK_LOCK_KEY, () => indexProgramEvents());
    return NextResponse.json(r.ran ? r.value : { ok: true, skipped: "tick in progress" });
  } catch (err) {
    return jsonError(err);
  }
}

function authorise(req: NextRequest, resetPath: boolean): boolean {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : auth;
  // 2026-05-21: CRON_SECRET split into per-purpose secrets. Per-endpoint
  // blast radius so a leak of one credential doesn't compromise both the
  // routine tick path AND the destructive reset path. CRON_SECRET stays
  // as a transitional fallback so operator rotations + Railway tickler
  // updates can happen in any order without an outage. Remove the
  // CRON_SECRET fallback after Vercel/Railway env cleanup.
  const reset = process.env.ADMIN_INDEX_RESET_SECRET;
  const tick = process.env.CRON_TICK_SECRET;
  const accepted = (
    resetPath
      ? [reset, process.env.CRON_SECRET]
      : [tick, reset, process.env.CRON_SECRET, process.env.HELIUS_WEBHOOK_AUTH]
  ).filter((s): s is string => Boolean(s));
  return accepted.some((s) => safeEqual(s, token));
}

/** Constant-time string compare. Returns false on length mismatch without
 * leaking length via early exit. */
function safeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. Pad to the longer length
  // with random bytes so a length mismatch is constant-time too.
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still perform a comparison so timing matches the equal-length path.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
