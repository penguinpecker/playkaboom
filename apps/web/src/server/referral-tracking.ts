import "server-only";
import { randomUUID } from "node:crypto";
import { query } from "./db/pg";
import { logger } from "./logger";

/** Cookie names — kept short to minimize header bloat. Both are non-HttpOnly
 *  so the client can also see the active code, e.g. for dashboards. */
export const REF_SESSION_COOKIE = "kb.ref.sid";
export const REF_CODE_COOKIE = "kb.ref.code";

/** Cookie shelf-life. Long enough to survive a few-day delay between click
 *  and wallet creation; short enough that an old test code doesn't follow
 *  the same browser forever. */
export const REF_COOKIE_TTL_DAYS = 30;

export interface VisitInsertResult {
  sessionId: string;
  wallet: string | null;
}

/**
 * Records a fresh /r/<code> click. Inserts a row into referral_visits keyed
 * by a freshly-generated session_id, returns that session_id so the route
 * can write it to the cookie. Best-effort — never throws; if the insert
 * fails the redirect still works, we just lose tracking on that visit.
 */
export async function recordVisitClick(code: string): Promise<VisitInsertResult> {
  const sessionId = randomUUID();
  // We don't bump click_count here — the existing resolveAndCountVisit
  // handler in /api/ref/[code] already does that. This insert is purely
  // for the per-visit attribution row.
  try {
    await query("insert into public.referral_visits (code, session_id) values ($1, $2)", [
      code,
      sessionId,
    ]);
  } catch (error) {
    logger.warn(
      { code, err: error instanceof Error ? error.message : String(error) },
      "referral_visits insert failed — visit tracking degraded for this click",
    );
  }
  return { sessionId, wallet: null };
}

/**
 * Marks a visit as having converted to a signup. Called when a wallet
 * first connects on a browser that has an unattributed kb.ref.sid cookie.
 *
 * Returns true if we attributed the signup (idempotent — second calls for
 * the same session return false without error). The unique partial index
 * on (session_id) WHERE wallet IS NOT NULL is the race-safety mechanism.
 */
export async function recordSignup(sessionId: string, wallet: string): Promise<boolean> {
  // 1. Find the visit. If it's already attributed (wallet IS NOT NULL),
  //    we no-op — never overwrite an earlier signup.
  const visit = await query<{ id: string; code: string; wallet: string | null }>(
    "select id, code, wallet from public.referral_visits where session_id = $1 order by created_at desc limit 1",
    [sessionId],
  ).then(
    (rows) => rows[0] ?? null,
    () => null,
  );
  if (!visit) return false;
  if (visit.wallet) return false;

  // 2. Update the row + bump signup_count on the code. We accept a small
  //    race here — if two updates land in the same millisecond signup_count
  //    could double-count by 1; the referral_visits row is the source of
  //    truth so the dashboard can re-derive the real number any time.
  try {
    await query(
      "update public.referral_visits set wallet = $1, signed_up_at = $3 where id = $2 and wallet is null",
      [wallet, visit.id, new Date().toISOString()],
    );
  } catch (updErr) {
    logger.warn(
      { sessionId, wallet, err: updErr instanceof Error ? updErr.message : String(updErr) },
      "referral_visits signup update failed",
    );
    return false;
  }

  // 3. Increment signup_count on referral_codes (in SQL; errors ignored as before).
  await query(
    "update public.referral_codes set signup_count = coalesce(signup_count, 0) + 1 where code = $1",
    [visit.code],
  ).catch(() => undefined);
  return true;
}

/**
 * Marks a visit as having confirmed the referrer on-chain. Called from the
 * client after their set_referrer tx confirms. Updates the latest visit row
 * for this wallet (we don't ask the client which visit — we just take the
 * most recent unconfirmed one since a wallet can only set_referrer once).
 */
export async function recordSetReferrerConfirmation(
  wallet: string,
  signature: string,
): Promise<boolean> {
  const visit = await query<{ id: string; code: string; set_referrer_signature: string | null }>(
    "select id, code, set_referrer_signature from public.referral_visits where wallet = $1 order by created_at desc limit 1",
    [wallet],
  ).then(
    (rows) => rows[0] ?? null,
    () => null,
  );
  if (!visit) return false;
  if (visit.set_referrer_signature) return false; // already confirmed

  try {
    await query(
      "update public.referral_visits set set_referrer_signature = $1, set_referrer_at = $3 where id = $2 and set_referrer_signature is null",
      [signature, visit.id, new Date().toISOString()],
    );
  } catch {
    return false;
  }

  await query(
    "update public.referral_codes set confirmed_count = coalesce(confirmed_count, 0) + 1 where code = $1",
    [visit.code],
  ).catch(() => undefined);
  return true;
}
