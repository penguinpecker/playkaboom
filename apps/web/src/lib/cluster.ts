import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_EXPLORERS, EXPLORERS, type SolanaCluster } from "@playkaboom/shared";

const RAW_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";
export const CLUSTER: SolanaCluster =
  RAW_CLUSTER === "mainnet-beta" || RAW_CLUSTER === "devnet" || RAW_CLUSTER === "testnet"
    ? RAW_CLUSTER
    : "devnet";

/**
 * Client-facing RPC URL.
 *
 * Production builds ALWAYS use our same-origin proxy `/api/rpc/<cluster>`
 * so the upstream RPC API key (Alchemy / paid provider) never enters the
 * browser bundle. The proxy enforces a JSON-RPC method allow-list +
 * per-IP rate limit (apps/web/src/app/api/rpc/[cluster]/route.ts) and
 * reads the key from the server-only SOLANA_MAINNET_RPC / SOLANA_RPC env.
 *
 * 2026-05-21 incident: `NEXT_PUBLIC_SOLANA_RPC` had been set to a
 * vendor-key URL in Vercel prod env. Next.js inlines NEXT_PUBLIC_*
 * values at build time, so the API key was shipped in every JS chunk to
 * every visitor for as long as that env var stayed set. Mobile TWA
 * clients also reported "VAULT UNAVAILABLE" because hitting the vendor
 * endpoint directly is flakier on cellular networks than going
 * through the same-origin proxy. Operator must rotate the leaked key
 * AND unset the env var; this code change ensures a future env mistake
 * cannot re-introduce the leak.
 *
 * Dev-only override: `NEXT_PUBLIC_SOLANA_RPC` is honored when
 * NODE_ENV !== "production" (local validator, custom dev endpoint). In
 * prod builds the entire branch is dead code — Next.js tree-shakes
 * `process.env.NODE_ENV !== "production"` to `false` at build time,
 * dropping any inlined NEXT_PUBLIC_SOLANA_RPC value from the bundle.
 *
 * Final SSR fallback: public Solana RPC. Only used during server-side
 * page rendering before hydration; browser code always takes the proxy
 * branch since `typeof window !== "undefined"`.
 */
const PROXY_CLUSTER_PATH =
  CLUSTER === "mainnet-beta" ? "mainnet" : CLUSTER === "testnet" ? "testnet" : "devnet";

const DEV_RPC_OVERRIDE =
  process.env.NODE_ENV !== "production" &&
  process.env.NEXT_PUBLIC_SOLANA_RPC &&
  process.env.NEXT_PUBLIC_SOLANA_RPC.length > 0
    ? process.env.NEXT_PUBLIC_SOLANA_RPC
    : null;

export const RPC_URL =
  DEV_RPC_OVERRIDE !== null
    ? DEV_RPC_OVERRIDE
    : typeof window !== "undefined"
      ? `${window.location.origin}/api/rpc/${PROXY_CLUSTER_PATH}`
      : CLUSTER === "mainnet-beta"
        ? "https://api.mainnet-beta.solana.com"
        : "https://api.devnet.solana.com";

/**
 * WebSocket endpoint for `signatureSubscribe` / `accountSubscribe`.
 *
 * Separate from RPC_URL because the same-origin /api/rpc proxy is HTTP-only
 * (Vercel Serverless Functions don't speak the WS upgrade protocol).
 *
 * 2026-05-21 history:
 *   1. PR #7 pointed RPC_URL at /api/rpc/<cluster> to hide the Alchemy
 *      key. web3.js's Connection derives its WS endpoint by swapping
 *      `https://` → `wss://` on the HTTP endpoint, so it tried
 *      `wss://playkaboom.gg/api/rpc/mainnet` — dead-ends on Vercel.
 *      Every onSignature / onAccountChange silently failed; the post-
 *      cashout Engage lock blew up from 2-3s to 15-20s (polling-only).
 *   2. PR #10 added an explicit wsEndpoint pointing at the free public
 *      Solana WS — restored sub-second confirms but bypassed the paid
 *      Alchemy stack the operator wants to use.
 *   3. THIS commit: WS_URL points at the Railway realtime service's
 *      `/rpc-ws` path. That path is a bidirectional proxy to Alchemy WS
 *      (key stays in Railway env). Same security property as the
 *      same-origin /api/rpc HTTP proxy — key never enters the browser.
 *
 * Dev override: NEXT_PUBLIC_SOLANA_WS is honored only when NODE_ENV !==
 * "production" (e.g. local validator at ws://127.0.0.1:8900). Prod
 * builds tree-shake the override branch.
 */
const RAILWAY_WS_PROXY: Record<"mainnet-beta" | "devnet" | "testnet", string> = {
  // Single Railway service handles all clusters — the upstream Alchemy
  // URL is set per-deploy via ALCHEMY_WS_URL env on Railway.
  "mainnet-beta": "wss://playkaboom-realtime-production.up.railway.app/rpc-ws",
  devnet: "wss://playkaboom-realtime-production.up.railway.app/rpc-ws",
  testnet: "wss://playkaboom-realtime-production.up.railway.app/rpc-ws",
};

const DEV_WS_OVERRIDE =
  process.env.NODE_ENV !== "production" &&
  process.env.NEXT_PUBLIC_SOLANA_WS &&
  process.env.NEXT_PUBLIC_SOLANA_WS.length > 0
    ? process.env.NEXT_PUBLIC_SOLANA_WS
    : null;

export const WS_URL = DEV_WS_OVERRIDE !== null ? DEV_WS_OVERRIDE : RAILWAY_WS_PROXY[CLUSTER];

const RAW_PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID;
export const PROGRAM_ID = RAW_PROGRAM_ID
  ? new PublicKey(RAW_PROGRAM_ID)
  : new PublicKey("Kab1TestProgam11111111111111111111111111111");

// ── MagicBlock Ephemeral-Rollup (VRF mode) config ────────────────────────────
//
// The ER RPC is a PUBLIC MagicBlock endpoint (no API key), so — unlike the L1
// RPC — it is used directly, not through the /api/rpc proxy.
//
// ⚠️ THE ENDPOINT AND THE ON-CHAIN PIN MUST NAME THE SAME NODE.
// `v2_state.vrf_validator` pins the one validator allowed to take delegation of
// a game, and only that identity can ever commit or undelegate it. If the app
// talks to a DIFFERENT node than the pin, delegation still SUCCEEDS — the
// delegation program does not validate the validator at delegate time, it just
// records it — and the game is then stranded: no validator will clone, commit
// or undelegate it, so the bet sits locked until the owner-gated 24h release.
// It fails silently, per game, with real money. Endpoint and pin change TOGETHER.
//
// These are regional nodes, NOT routers. `mainnet.magicblock.app` is an
// unlabelled DNS alias for the Singapore node (`as.magicblock.app`); if
// MagicBlock ever repoints that alias, a defaulted client would silently start
// talking to a node that is not the pinned one. So on mainnet the endpoint must
// be set EXPLICITLY — there is deliberately no default to fall back on.
// Current mainnet roster (from `getRoutes` on https://router.magicblock.app):
//   MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57 -> https://as.magicblock.app/          (Singapore)
//   MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo -> https://mainnet-tee.magicblock.app/ (Singapore, TEE-attested)
//   MEUG… -> EU, MUS3… -> US
const ER_DEFAULTS: Record<"devnet" | "testnet", { rpc: string; ws: string }> = {
  devnet: { rpc: "https://devnet.magicblock.app/", ws: "wss://devnet.magicblock.app/" },
  testnet: { rpc: "https://devnet.magicblock.app/", ws: "wss://devnet.magicblock.app/" },
};

/** Mainnet has no default: the endpoint must be pinned alongside vrf_validator. */
function erEndpoint(kind: "rpc" | "ws"): string {
  const explicit = kind === "rpc" ? process.env.NEXT_PUBLIC_ER_RPC : process.env.NEXT_PUBLIC_ER_WS;
  if (explicit && explicit.length > 0) return explicit;
  if (CLUSTER === "mainnet-beta") {
    // Empty string rather than a throw: this module is imported during the
    // build. VRF_MODE_ENABLED below is what actually gates use, and an unset
    // endpoint makes the mode unusable rather than silently misrouted.
    return "";
  }
  return ER_DEFAULTS[CLUSTER as "devnet" | "testnet"][kind];
}

export const ER_RPC_URL = erEndpoint("rpc");
export const ER_WS_URL = erEndpoint("ws");

/**
 * Ephemeral VRF oracle queue. This is a PROGRAM-WIDE MagicBlock account, not
 * cluster-specific — the same address is live on both devnet and mainnet
 * (verified on-chain 2026-07-18: owned by the delegation program on mainnet).
 * Overridable via NEXT_PUBLIC_VRF_QUEUE only if MagicBlock rotates it.
 *
 * ⚠️ The program now PINS this same address on chain (VRF_ORACLE_QUEUE in
 * vrf_mode.rs) so a game cannot be pointed at an attacker-run queue. Overriding
 * it here without shipping a matching program upgrade makes every reveal fail.
 * Keep the two in lockstep.
 */
const EPHEMERAL_VRF_QUEUE = "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc";
export const VRF_QUEUE: PublicKey = new PublicKey(
  process.env.NEXT_PUBLIC_VRF_QUEUE && process.env.NEXT_PUBLIC_VRF_QUEUE.length > 0
    ? process.env.NEXT_PUBLIC_VRF_QUEUE
    : EPHEMERAL_VRF_QUEUE,
);

/**
 * Client-side kill switch for the VRF game mode. When false the app drives the
 * existing commit-reveal flow only. Pairs with the on-chain `vrf_mode_enabled`
 * flag and the backend routing — any of the three being off disables VRF.
 */
/**
 * Client-side VRF mode switch. Requires an explicit ER endpoint too: without
 * one the app cannot reach the rollup, and starting a game in that state would
 * lock a bet with no way to play it out. Both must be set deliberately.
 *
 * This is a UI-routing flag only — the server flag VRF_MODE_ENABLED gates the
 * money routes, and the on-chain vrf_validator / vrf_max_payout_bps gate the
 * program itself.
 */
export const VRF_MODE_ENABLED =
  process.env.NEXT_PUBLIC_VRF_MODE_ENABLED === "true" && ER_RPC_URL.length > 0;

export const txExplorer = (sig: string) => EXPLORERS[CLUSTER](sig);
export const accountExplorer = (addr: string) => ACCOUNT_EXPLORERS[CLUSTER](addr);

export const CLUSTER_LABEL: Record<SolanaCluster, string> = {
  "mainnet-beta": "Solana Mainnet",
  devnet: "Solana Devnet",
  testnet: "Solana Testnet",
  localnet: "Solana Localnet",
};
