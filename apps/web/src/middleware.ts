import { NextResponse, type NextRequest } from "next/server";
import { apiOrigin } from "@/lib/api-origin.mjs";

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
  const { pathname, search } = req.nextUrl;

  if (host === STATUS_HOST) {
    // Bare subdomain is the canonical URL — serve the status page in place,
    // with no redirect and no visible path.
    if (pathname === "/") {
      return NextResponse.rewrite(new URL("/status", req.url));
    }

    // /status on this host is a duplicate of "/". Collapse it so there is one
    // canonical address for the page.
    if (pathname === "/status") {
      return NextResponse.redirect(new URL("/", req.url), 308);
    }

    // Everything but the machine-readable feed belongs to the game.
    if (pathname !== STATUS_API) {
      return NextResponse.redirect(`${GAME_ORIGIN}${pathname}${search}`, 308);
    }
  }

  return proxyApi(req) ?? NextResponse.next();
}

/**
 * Frontend-only deploy (KABOOM_API_ORIGIN set): proxy /api/* except
 * /api/version (the stale-tab check tracks THIS frontend's deployment) to the
 * Railway server. Railway overwrites X-Forwarded-For with the connecting IP,
 * which here is Vercel's egress, so every player would share one rate-limit
 * bucket. The player's IP rides in x-kaboom-client-ip instead, trusted by
 * clientIp() only alongside the shared KABOOM_PROXY_SECRET. Every other
 * header (Privy cookies, Authorization) is forwarded unchanged.
 */
function proxyApi(req: NextRequest): NextResponse | null {
  const { pathname, search } = req.nextUrl;
  if (!pathname.startsWith("/api/") || pathname === "/api/version") return null;
  let api: string | null;
  try {
    api = apiOrigin();
  } catch {
    // Fail closed: never serve the local API routes on a frontend-only deploy.
    return NextResponse.json({ error: "API origin misconfigured" }, { status: 500 });
  }
  if (!api) return null;

  const headers = new Headers(req.headers);
  headers.delete("x-kaboom-client-ip");
  headers.delete("x-kaboom-proxy-secret");
  // Vercel sets X-Forwarded-For itself (a client-sent value is overwritten).
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) headers.set("x-kaboom-client-ip", ip);
  const secret = process.env.KABOOM_PROXY_SECRET;
  if (secret) headers.set("x-kaboom-proxy-secret", secret);
  const target = new URL(pathname + search, api);
  // The override list carries every header, Host included. Railway routes by
  // Host, so a forwarded "playkaboom.gg" would miss the service: send its own.
  headers.set("host", target.host);

  return NextResponse.rewrite(target, { request: { headers } });
}

export const config = {
  // Skip Next's own asset pipeline and common well-known files: the status
  // page needs its chunks, and rewriting/redirecting them would break the
  // page this middleware exists to serve.
  matcher: ["/((?!_next/static|_next/image|_next/data|favicon.ico|icon.png|apple-icon.png|.well-known).*)"],
};
