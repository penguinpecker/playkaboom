import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./db/supabase";
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
  const db = supabaseAdmin();
  // We don't bump click_count here — the existing resolveAndCountVisit
  // handler in /api/ref/[code] already does that. This insert is purely
  // for the per-visit attribution row.
  const { error } = await db.from("referral_visits").insert({ code, session_id: sessionId });
  if (error) {
    logger.warn(
      { code, err: error.message },
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
  const db = supabaseAdmin();
  // 1. Find the visit. If it's already attributed (wallet IS NOT NULL),
  //    we no-op — never overwrite an earlier signup.
  const { data: visit, error: lookupErr } = await db
    .from("referral_visits")
    .select("id, code, wallet")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupErr || !visit) return false;
  if (visit.wallet) return false;

  // 2. Update the row + bump signup_count on the code in a single rpc-like
  //    sequence. We accept a small race here — if two updates land in the
  //    same millisecond signup_count could double-count by 1; the
  //    referral_visits row is the source of truth so the dashboard can
  //    re-derive the real number any time.
  const { error: updErr } = await db
    .from("referral_visits")
    .update({ wallet, signed_up_at: new Date().toISOString() })
    .eq("id", visit.id)
    .is("wallet", null);
  if (updErr) {
    logger.warn(
      { sessionId, wallet, err: updErr.message },
      "referral_visits signup update failed",
    );
    return false;
  }

  // 3. Increment signup_count on referral_codes.
  const { data: code } = await db
    .from("referral_codes")
    .select("signup_count")
    .eq("code", visit.code)
    .single();
  if (code) {
    await db
      .from("referral_codes")
      .update({ signup_count: (code.signup_count ?? 0) + 1 })
      .eq("code", visit.code);
  }
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
  const db = supabaseAdmin();
  const { data: visit } = await db
    .from("referral_visits")
    .select("id, code, set_referrer_signature")
    .eq("wallet", wallet)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!visit) return false;
  if (visit.set_referrer_signature) return false; // already confirmed

  const { error: updErr } = await db
    .from("referral_visits")
    .update({
      set_referrer_signature: signature,
      set_referrer_at: new Date().toISOString(),
    })
    .eq("id", visit.id)
    .is("set_referrer_signature", null);
  if (updErr) return false;

  const { data: code } = await db
    .from("referral_codes")
    .select("confirmed_count")
    .eq("code", visit.code)
    .single();
  if (code) {
    await db
      .from("referral_codes")
      .update({ confirmed_count: (code.confirmed_count ?? 0) + 1 })
      .eq("code", visit.code);
  }
  return true;
}
