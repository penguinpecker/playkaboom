/**
 * The Railway API origin a frontend-only deploy proxies /api/* to, or null when
 * this server answers /api itself. Shared by next.config.mjs (a bad value fails
 * the build) and src/middleware.ts (fails closed at request time), so an
 * invalid value can never fall through to the local API routes.
 *
 * @returns {string | null}
 */
export function apiOrigin() {
  const api = process.env.KABOOM_API_ORIGIN;
  if (!api) return null;
  if (!/^https:\/\/[^/]+$/.test(api)) {
    throw new Error("KABOOM_API_ORIGIN must be https://<host> with no path");
  }
  return api;
}
