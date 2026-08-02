/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === "production";

// Content Security Policy. Tightened for production; relaxed in dev for HMR.
//
// allow-list rationale (production) — every entry is scoped to a host we
// actually call from the browser. We re-verified this list 2026-05-06 and
// dropped Helius/Triton/WalletConnect/web3modal which are either server-only
// or unused. Smaller allow-list = smaller blast radius if a third party is
// compromised.
//
//   - script-src/connect-src 'self' for our own assets and API routes
//   - Privy SDK + auth iframe + Cloudflare Turnstile (Privy bundles it for bot defense)
//   - Alchemy Solana RPC (https + wss)
//   - Public Solana RPC fallbacks (mainnet/devnet) — used only if Alchemy is down
//   - Supabase REST + realtime
//   - Pyth Hermes for live price feed
//   - frame-ancestors 'none' blocks clickjacking
//   - object-src 'none' blocks legacy plugins
//   - require-trusted-types-for 'script' opts into Trusted Types where the
//     browser supports it (Chrome 83+); harmless otherwise
const csp = [
  "default-src 'self'",
  // 'unsafe-inline' is required by Next.js's inline runtime hydration script.
  // 'unsafe-eval' is dev-only (Webpack HMR). Production runtime has neither
  // dynamic eval nor third-party inline scripts (audited 2026-05-06: zero
  // <script src=*>, zero dangerouslySetInnerHTML in src/). The next hardening
  // step is nonce-based CSP via middleware to drop 'unsafe-inline' entirely.
  `script-src 'self' 'unsafe-inline' ${isProd ? "" : "'unsafe-eval'"} https://auth.privy.io https://*.privy.io https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  [
    "connect-src 'self'",
    "https://*.privy.io",
    "wss://*.privy.io",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    "https://api.mainnet-beta.solana.com",
    "https://api.devnet.solana.com",
    "https://*.g.alchemy.com",
    "wss://*.g.alchemy.com",
    // Railway realtime relay (apps/realtime). Fans out settle events to every
    // connected browser AND polls /api/cron/index-events every 60s, which is
    // what actually keeps the mirror fresh. MUST match
    // NEXT_PUBLIC_REALTIME_WS_URL exactly — the host changed on 2026-07-29
    // when the service was rebuilt, and a stale entry here blocks the socket
    // silently in the browser with nothing in any server log.
    "wss://kaboom-realtime-production.up.railway.app",
    "https://hermes.pyth.network",
    // MagicBlock Ephemeral Rollup — the VRF game mode talks DIRECTLY to this
    // node from the browser (per-click reveals, cash-out, and the
    // settle-and-undelegate that is the ONLY way out of a delegated game).
    //
    // Omitting it does not degrade gracefully: the browser silently refuses
    // every request, so tile taps do nothing, resume cannot read the rollup
    // state, and recovery cannot undelegate — which then makes the L1 refund
    // refuse too, because refund_stalled_vrf rejects a still-delegated game.
    // Every client-side VRF failure on 2026-07-28 traced back to this line
    // being absent. Keep it in sync with NEXT_PUBLIC_ER_RPC / _ER_WS.
    "https://*.magicblock.app",
    "wss://*.magicblock.app",
    // Privy bundles WalletConnect for wallet picker. Explorer API hosts the
    // wallet list; relay.walletconnect.{com,org} carries the v2 session WS.
    "https://*.walletconnect.com",
    "wss://*.walletconnect.com",
    "https://*.walletconnect.org",
    "wss://*.walletconnect.org",
  ].join(" "),
  "frame-src 'self' https://*.privy.io https://auth.privy.io https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  // Manifest/media kept default-self.
  "manifest-src 'self'",
  "media-src 'self'",
  // Opt into Trusted Types where supported. Forces script-injection sinks to
  // accept only typed objects, blocking common XSS sink patterns.
  isProd ? "require-trusted-types-for 'script'" : "",
  isProd ? "upgrade-insecure-requests" : "",
]
  .filter(Boolean)
  .join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
      "interest-cohort=()",
      "browsing-topics=()",
    ].join(", "),
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  // `same-origin-allow-popups` is required for Coinbase / Base Account
  // wallet SDKs to communicate with their popup. `same-origin` would block
  // the postMessage handshake. Privy's auth iframe is unaffected.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Don't expose timing/origin info to ad networks.
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

if (isProd) {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  });
}

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "1mb" },
  },
  transpilePackages: ["@playkaboom/sdk", "@playkaboom/shared"],
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      // Allow cross-origin font loading from Vercel CDN if assets get hosted there.
      {
        source: "/_next/static/(.*)",
        headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }],
      },
    ];
  },
  // Host routing for status.playkaboom.gg lives in src/middleware.ts, NOT
  // here. A config rewrite can express "/ on this host -> /status" but not
  // "and nothing else on this host is served", which is the part that matters:
  // the subdomain shares this project, so without that rule the entire
  // wallet-connecting game app stays reachable on it.
  //
  // These redirects only collapse the duplicate public URL. The `has` host
  // condition is load-bearing: middleware rewrites status.playkaboom.gg/ into
  // an INTERNAL request for /status, so an unscoped redirect on /status would
  // catch its own rewrite and loop forever.
  async redirects() {
    return [
      {
        source: "/status",
        has: [{ type: "host", value: "playkaboom.gg" }],
        destination: "https://status.playkaboom.gg/",
        permanent: true,
      },
      {
        source: "/status",
        has: [{ type: "host", value: "www.playkaboom.gg" }],
        destination: "https://status.playkaboom.gg/",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
