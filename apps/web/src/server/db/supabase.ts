import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedAdmin: SupabaseClient | null = null;
let cachedPublic: SupabaseClient | null = null;

/**
 * Service-role client — bypasses RLS, can write everything.
 * Use ONLY in server-side code (API routes, cron, webhook handlers).
 */
export function supabaseAdmin(): SupabaseClient {
  if (cachedAdmin) return cachedAdmin;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL not set");
  if (!serviceRole) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  cachedAdmin = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
  return cachedAdmin;
}

/**
 * Public/anon client — RLS enforced. Safe to use in API routes that only
 * need to read public data (leaderboards, game history).
 */
export function supabasePublic(): SupabaseClient {
  if (cachedPublic) return cachedPublic;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("SUPABASE_URL not set");
  if (!anon) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
  cachedPublic = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
  return cachedPublic;
}
