import { useSyncExternalStore } from "react";

// Mirrors src/middleware.ts: status.playkaboom.gg serves only the status page
// and 308s every other path to the game host. There the shell's relative links
// loop back to the status page ("/") or bounce cross-origin, where CSP refuses
// Next's RSC prefetch. So on that host they point at the game, unprefetched.
const STATUS_HOST = "status.playkaboom.gg";
const GAME_ORIGIN = "https://playkaboom.gg";

/** Link props for an internal page path, given the current hostname (null on the server). */
export function gameLink(href: string, host: string | null): { href: string; prefetch?: false } {
  return host === STATUS_HOST ? { href: `${GAME_ORIGIN}${href}`, prefetch: false } : { href };
}

const noSubscribe = () => () => {};

/** Server render and hydration use the plain path; the client then swaps in the host-aware one. */
export function useGameLink() {
  const host = useSyncExternalStore(noSubscribe, () => window.location.hostname, () => null);
  return (href: string) => gameLink(href, host);
}
