/**
 * Server boot hook (Next.js runs it once when the server starts). Validates
 * HOUSE_SECRET_KEY before any request is served, so a missing or malformed key
 * fails the deploy's start instead of the first settle. The error names the
 * problem, never the value. Skipped during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Frontend-only deploy: /api is proxied to the Railway server
  // (src/middleware.ts), so this host never signs and must not hold the house key.
  if (process.env.KABOOM_API_ORIGIN) return;
  const { assertHouseSignerConfig } = await import("./server/house-signer");
  if (process.env.NODE_ENV !== "production" && !process.env.HOUSE_SECRET_KEY) {
    console.warn("[boot] HOUSE_SECRET_KEY is not set: house-signed routes will fail");
    return;
  }
  try {
    console.info(`[boot] house signer ${assertHouseSignerConfig().toBase58()}`);
  } catch (e) {
    // Next would log "Failed to prepare server" and keep serving 500s; exit so
    // the Railway deploy fails visibly instead. The message never holds the key.
    console.error(`[boot] ${(e as Error).message}`);
    process.exit(1);
  }
}
