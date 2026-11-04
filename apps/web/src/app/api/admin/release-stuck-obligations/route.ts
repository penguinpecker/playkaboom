import { NextResponse, type NextRequest } from "next/server";
import { ApiError, jsonError } from "@/server/api-helpers";
import { releaseStuckObligations } from "@/server/cron/legacy-passes";
import { TICK_LOCK_KEY, withAdvisoryLock } from "@/server/cron/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-shot admin endpoint to release leaked
 * `total_outstanding_max_payout` obligations on the on-chain Vault.
 *
 * Background: every game increments `total_outstanding_max_payout` by
 * `worst_case_payout` at start_game. It's only decremented at
 * settle_game / refund_expired / close_unsettled_game. If any of those
 * fail to fire (e.g. perfect-game trap pre-G1, server-side settle that
 * RPC-failed without retry), the obligation accumulates on chain and
 * suppresses vault health. As of this commit there's ~5.77 SOL of
 * leaked obligations on production.
 *
 * Only fixable case from server-side: GameSession in Won/Lost + !settled
 * state where the encrypted server session row is still in Postgres
 * (so we can decrypt the layout+salt and build a valid settle_game).
 *
 * Other stuck cases need player signatures and can't be cleaned by the
 * operator alone:
 *   - Playing past slot+300:        player must sign refund_expired
 *   - Won/Lost + !settled, no session: player must sign close_unsettled_game
 *   - Won/Lost + settled (rent only): player must sign close_game
 *
 * The house cron runs the same logic every 5 min (tick pass `legacy`, e), now
 * WITH the referrer and deleting the session row only after the settle
 * confirms (server/cron/legacy-passes.ts). This route is the manual trigger.
 *
 * Auth: ADMIN_RELEASE_SECRET-gated. Run with:
 *   curl -X POST https://playkaboom.gg/api/admin/release-stuck-obligations \
 *     -H "Authorization: Bearer $CRON_SECRET"
 */
function requireCronAuth(req: NextRequest): void {
  // 2026-05-21: ADMIN_RELEASE_SECRET is the per-purpose secret for this
  // endpoint; CRON_SECRET kept as a transitional fallback during rotation.
  // Remove the CRON_SECRET branch once GitHub Actions + operator clients
  // are migrated and the legacy value is rotated out.
  const accepted = [process.env.ADMIN_RELEASE_SECRET, process.env.CRON_SECRET].filter(
    (s): s is string => Boolean(s),
  );
  if (accepted.length === 0) {
    throw new ApiError(503, "ADMIN_RELEASE_SECRET not configured");
  }
  const provided = req.headers.get("authorization");
  if (!provided || !provided.startsWith("Bearer ")) {
    throw new ApiError(401, "Missing bearer token");
  }
  const token = provided.slice(7);
  if (!accepted.some((s) => s === token)) throw new ApiError(401, "Bad token");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    requireCronAuth(req);
    // Same body as the tick's legacy pass: never run it alongside a tick.
    const r = await withAdvisoryLock(TICK_LOCK_KEY, () => releaseStuckObligations());
    if (!r.ran) return NextResponse.json({ error: "tick in progress, retry shortly" }, { status: 409 });
    return NextResponse.json(r.value);
  } catch (err) {
    return jsonError(err);
  }
}
