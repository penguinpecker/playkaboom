/**
 * status.playkaboom.gg (F2): the shell's links must leave for the game host
 * unprefetched, and the logo must be served on the status host while every
 * other path still redirects to the game.
 *
 *   npm run test --workspace=@playkaboom/web
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { gameLink } from "./status-host";

test("shell links point at the game on the status host only", () => {
  assert.deepEqual(gameLink("/", "status.playkaboom.gg"), { href: "https://playkaboom.gg/", prefetch: false });
  assert.deepEqual(gameLink("/terms", "status.playkaboom.gg"), {
    href: "https://playkaboom.gg/terms",
    prefetch: false,
  });
  for (const host of ["playkaboom.gg", "www.playkaboom.gg", "localhost", null]) {
    assert.deepEqual(gameLink("/play", host), { href: "/play" });
  }
});

function mw(url: string) {
  return middleware(new NextRequest(url, { headers: { host: new URL(url).host } }));
}

test("status host serves the logo but still redirects pages that end in .png", () => {
  const logo = mw("https://status.playkaboom.gg/kaboom-logo.png");
  assert.equal(logo.headers.get("x-middleware-next"), "1");
  assert.equal(logo.headers.get("location"), null);

  for (const path of ["/r/x.png", "/profile/x.png", "/og.png", "/play"]) {
    const res = mw(`https://status.playkaboom.gg${path}`);
    assert.equal(res.status, 308, path);
    assert.equal(res.headers.get("location"), `https://playkaboom.gg${path}`);
  }
});
