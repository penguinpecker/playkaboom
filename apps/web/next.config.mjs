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
    // Helius — client posts player txs through Sender for fast landing,
    // and (when NEXT_PUBLIC_HELIUS_API_KEY is set) hits the RPC for
    // getPriorityFeeEstimate. Server-side WS subscribe runs from Node
    // and isn't subject to browser CSP.
    "https://sender.helius-rpc.com",
    "https://mainnet.helius-rpc.com",
    "wss://mainnet.helius-rpc.com",
    // Railway realtime relay — fans out public.games settle events to
    // every connected browser. Wired in apps/realtime/. Has been silently
    // CSP-blocked since the worker shipped 2026-05-09.
    "wss://playkaboom-realtime-production.up.railway.app",
    "https://hermes.pyth.network",
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
};

export default nextConfig;
