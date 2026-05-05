/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === "production";

// Content Security Policy. Tightened for production; relaxed in dev for HMR.
//
// allow-list rationale (production):
//   - script-src/connect-src 'self' for our own assets and API routes
//   - Privy SDK + auth iframe + Cloudflare Turnstile (Privy bundles it for bot defense)
//   - Solana RPCs (mainnet, devnet, Helius, Triton) over https + wss
//   - Supabase REST + realtime
//   - Pyth Hermes for live price feed
//   - WalletConnect relay for non-Privy wallets
//   - frame-ancestors 'none' blocks clickjacking
//   - object-src 'none' blocks legacy plugins
const csp = [
  "default-src 'self'",
  // 'unsafe-inline' + 'unsafe-eval' are required by Next.js inline runtime + Privy until we move to strict nonces.
  `script-src 'self' 'unsafe-inline' ${isProd ? "" : "'unsafe-eval'"} https://auth.privy.io https://*.privy.io https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  [
    "connect-src 'self'",
    "https://*.privy.io",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    "https://api.mainnet-beta.solana.com",
    "https://api.devnet.solana.com",
    "https://*.helius-rpc.com",
    "https://*.helius.xyz",
    "wss://*.helius-rpc.com",
    "https://*.triton.one",
    "wss://*.triton.one",
    "https://hermes.pyth.network",
    "wss://relay.walletconnect.com",
    "https://explorer-api.walletconnect.com",
    "https://api.web3modal.com",
  ].join(" "),
  "frame-src 'self' https://*.privy.io https://auth.privy.io https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
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
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
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
