/**
 * Frontend proxy + client IP: behind Vercel, Railway sees Vercel's egress IP in
 * X-Forwarded-For, so the middleware forwards the player's IP in
 * x-kaboom-client-ip and clientIp() trusts it only with the shared secret.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { clientIp } from "@/server/api-helpers";
import { middleware } from "@/middleware";

const SECRET = "s3cret-value-for-tests";

function req(headers: Record<string, string>) {
  return new Request("http://localhost/api/x", { headers });
}

test("clientIp trusts x-kaboom-client-ip only with the matching secret", () => {
  const h = { "x-forwarded-for": "9.9.9.9", "x-kaboom-client-ip": "1.2.3.4" };

  process.env.KABOOM_PROXY_SECRET = SECRET;
  assert.equal(clientIp(req({ ...h, "x-kaboom-proxy-secret": SECRET })), "1.2.3.4");
  // Wrong secret (same and different length) -> ignored.
  assert.equal(clientIp(req({ ...h, "x-kaboom-proxy-secret": SECRET.replace("s", "x") })), "9.9.9.9");
  assert.equal(clientIp(req({ ...h, "x-kaboom-proxy-secret": "short" })), "9.9.9.9");
  // Forged header with no secret at all -> ignored.
  assert.equal(clientIp(req(h)), "9.9.9.9");
  // Matching secret but not an IP -> ignored.
  assert.equal(
    clientIp(req({ ...h, "x-kaboom-client-ip": "evil:bucket", "x-kaboom-proxy-secret": SECRET })),
    "9.9.9.9",
  );

  // Secret env unset: even a matching-looking header is never trusted.
  delete process.env.KABOOM_PROXY_SECRET;
  assert.equal(clientIp(req({ ...h, "x-kaboom-proxy-secret": SECRET })), "9.9.9.9");
  assert.equal(clientIp(req({ ...h, "x-kaboom-proxy-secret": "" })), "9.9.9.9");
});

function mw(url: string, headers: Record<string, string> = {}) {
  // A real request carries Host; one built in node does not.
  return middleware(new NextRequest(url, { headers: { host: new URL(url).host, ...headers } }));
}

test("middleware proxies /api/* with the client IP and secret, headers intact", () => {
  process.env.KABOOM_API_ORIGIN = "https://api.example.com";
  process.env.KABOOM_PROXY_SECRET = SECRET;
  try {
    const res = mw("https://playkaboom.gg/api/game/start?x=1", {
      "x-forwarded-for": "1.2.3.4, 10.0.0.1",
      "x-kaboom-client-ip": "6.6.6.6", // forged by the browser
      "x-kaboom-proxy-secret": "forged",
      authorization: "Bearer tok",
      cookie: "privy-token=abc",
    });
    const h = res.headers;
    assert.equal(h.get("x-middleware-rewrite"), "https://api.example.com/api/game/start?x=1");
    assert.equal(h.get("x-middleware-request-x-kaboom-client-ip"), "1.2.3.4");
    assert.equal(h.get("x-middleware-request-x-kaboom-proxy-secret"), SECRET);
    assert.equal(h.get("x-middleware-request-authorization"), "Bearer tok");
    assert.equal(h.get("x-middleware-request-cookie"), "privy-token=abc");
    assert.equal(h.get("x-middleware-request-host"), "api.example.com");

    // Status host page routing is unchanged by the proxy.
    const statusRoot = mw("https://status.playkaboom.gg/");
    assert.equal(statusRoot.headers.get("x-middleware-rewrite"), "https://status.playkaboom.gg/status");
    const statusDup = mw("https://status.playkaboom.gg/status");
    assert.equal(statusDup.status, 308);
    assert.equal(statusDup.headers.get("location"), "https://status.playkaboom.gg/");

    // /api/version stays local; pages are untouched.
    assert.equal(mw("https://playkaboom.gg/api/version").headers.get("x-middleware-rewrite"), null);
    assert.equal(mw("https://playkaboom.gg/play").headers.get("x-middleware-rewrite"), null);

    // Status host: /api/status is proxied too; other paths still go to the game.
    assert.equal(
      mw("https://status.playkaboom.gg/api/status").headers.get("x-middleware-rewrite"),
      "https://api.example.com/api/status",
    );
    const other = mw("https://status.playkaboom.gg/api/game/start");
    assert.equal(other.status, 308);
    assert.equal(other.headers.get("location"), "https://playkaboom.gg/api/game/start");

    // Invalid origin fails closed instead of serving local API routes.
    process.env.KABOOM_API_ORIGIN = "https://api.example.com/path";
    assert.equal(mw("https://playkaboom.gg/api/game/start").status, 500);
  } finally {
    delete process.env.KABOOM_API_ORIGIN;
    delete process.env.KABOOM_PROXY_SECRET;
  }

  // No origin set (the Railway API itself): nothing is rewritten.
  assert.equal(mw("https://playkaboom.gg/api/game/start").headers.get("x-middleware-rewrite"), null);
});
