import { NextResponse, type NextRequest } from "next/server";

/**
 * Host isolation for status.playkaboom.gg.
 *
 * The status subdomain is attached to the SAME Vercel project as the game, so
 * without this every route — /play, /vault, /referrals, the whole wallet app —
 * is reachable on it. That is not acceptable on a real-money product:
 *
 *   - two hostnames serving a wallet-connecting app doubles the phishing
 *     surface and makes "is this the real site?" ambiguous for players,
 *   - it splits origin-scoped state (Privy session, localStorage holding VRF
 *     session keys) across hosts, so a game started on one is invisible to the
 *     other and can look stranded,
 *   - and it duplicates every page for crawlers.
 *
 * So the status host serves EXACTLY the status page and its JSON endpoint.
 * Everything else is redirected to the canonical game host rather than 404'd,
 * so a mistyped or shared link still lands somewhere useful.
 */

const STATUS_HOST = "status.playkaboom.gg";
const GAME_ORIGIN = "https://playkaboom.gg";

/** The only paths that may be served from the status host. */
const STATUS_API = "/api/status";

export function middleware(req: NextRequest) {
  // Host header carries the port in local dev; compare on the hostname only.
  const host = (req.headers.get("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (host !== STATUS_HOST) return NextResponse.next();

  const { pathname, search } = req.nextUrl;

  // Bare subdomain is the canonical URL — serve the status page in place, with
  // no redirect and no visible path.
  if (pathname === "/") {
    return NextResponse.rewrite(new URL("/status", req.url));
  }

  // /status on this host is a duplicate of "/". Collapse it so there is one
  // canonical address for the page.
  if (pathname === "/status") {
    return NextResponse.redirect(new URL("/", req.url), 308);
  }

  // The machine-readable feed is part of the status product.
  if (pathname === STATUS_API) return NextResponse.next();

  // Everything else belongs to the game.
  return NextResponse.redirect(`${GAME_ORIGIN}${pathname}${search}`, 308);
}

export const config = {
  // Skip Next's own asset pipeline and common well-known files: the status
  // page needs its chunks, and rewriting/redirecting them would break the
  // page this middleware exists to serve.
  matcher: ["/((?!_next/static|_next/image|_next/data|favicon.ico|icon.png|apple-icon.png|.well-known).*)"],
};
