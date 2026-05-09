"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Browser-side Supabase singleton — anon key only, used for Realtime
 * subscriptions on tables that have RLS-allowed select policies (games,
 * lp_actions). Never use for writes; the API routes hold the service-
 * role key for that.
 *
 * Returns null when env is missing so callers can fall back to polling
 * gracefully (rather than crashing the page).
 */
export function getSupabaseBrowser(): SupabaseClient | null {
  if (cached) return cached;
  if (typeof window === "undefined") return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  cached = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: {
      params: {
        // 10 events/sec ceiling per channel — cheap, easily under quota.
        eventsPerSecond: 10,
      },
    },
  });
  return cached;
}
