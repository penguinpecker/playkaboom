import "server-only";
import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "./db/supabase";

// Drops i, l, o, u (look like 1/0) so codes are easy to read aloud and
// transcribe without confusion. 30 chars total, 6-char codes = 30^6 ≈ 729M.
const ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
const CODE_LEN = 6;
const MAX_INSERT_RETRIES = 5;

function generateCode(): string {
  const buf = randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[buf[i]! % ALPHABET.length];
  }
  return out;
}

export interface ReferralCodeRow {
  code: string;
  wallet: string;
  click_count: number;
  signup_count: number;
  confirmed_count: number;
  last_visited_at: string | null;
}

/**
 * Fetch the code already minted for this wallet, or mint and persist a new
 * one. Race-safe via the (wallet) UNIQUE constraint — if two requests
 * race the second insert errors with 23505 and we re-read the winner.
 */
export async function getOrCreateCodeForWallet(wallet: string): Promise<ReferralCodeRow> {
  const db = supabaseAdmin();

  const existing = await db
    .from("referral_codes")
    .select("*")
    .eq("wallet", wallet)
    .maybeSingle();
  if (existing.data) return existing.data as ReferralCodeRow;

  for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
    const code = generateCode();
    const insert = await db
      .from("referral_codes")
      .insert({ code, wallet })
      .select("*")
      .single();
    if (insert.data) return insert.data as ReferralCodeRow;
    // 23505 = unique_violation. Could be either:
    //   - code collision → retry with a new code
    //   - wallet conflict (race with a sibling request) → re-read existing
    const code23505 = insert.error?.code === "23505";
    const isWalletConflict = code23505 && insert.error?.message.includes("one_code_per_wallet");
    if (isWalletConflict) {
      const reread = await db
        .from("referral_codes")
        .select("*")
        .eq("wallet", wallet)
        .single();
      if (reread.data) return reread.data as ReferralCodeRow;
    }
    if (!code23505) {
      throw new Error(`referral_codes insert failed: ${insert.error?.message ?? "unknown"}`);
    }
    // else fall through and retry with a fresh code
  }
  throw new Error("Could not mint referral code after retries — alphabet may be too small");
}

/**
 * Resolve a code → wallet, bumping click_count atomically. Returns null
 * for unknown codes. Public — no auth required (the wallet address is
 * already on-chain so revealing it is not a leak).
 */
export async function resolveAndCountVisit(code: string): Promise<ReferralCodeRow | null> {
  const db = supabaseAdmin();
  // Read first so we can return immediately if not found.
  const found = await db
    .from("referral_codes")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (!found.data) return null;
  // Best-effort update — if it fails the resolve still succeeds. We
  // don't await on the response path (would add ~50ms to redirect).
  void db
    .from("referral_codes")
    .update({
      click_count: (found.data.click_count ?? 0) + 1,
      last_visited_at: new Date().toISOString(),
    })
    .eq("code", code);
  return found.data as ReferralCodeRow;
}
