import { NextResponse, type NextRequest } from "next/server";
import { clientIp, jsonError } from "@/server/api-helpers";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";

// A live VRF round polls balances, the claim/game accounts and tx statuses
// through this proxy; 30 per 10 s (the default) throttled real players and
// web3.js's 429 retries made it a storm. Each call in a batch still costs one.
const RPC_MAX_HITS = 300;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ cluster: string }>;
}

/**
 * Server-side proxy to the Solana RPC, so the Alchemy API key never
 * touches the client bundle. Replaces NEXT_PUBLIC_SOLANA_RPC for the
 * browser-side Connection — the client now points at /api/rpc/<cluster>
 * and we forward to whichever paid provider is configured server-side.
 *
 * Defenses:
 *   1. JSON-RPC method allow-list. Mutating / introspective methods
 *      that don't make sense from a browser (`requestAirdrop`,
 *      `getProgramAccounts` against arbitrary programs, etc.) are
 *      rejected with -32601. Limits the blast radius if someone
 *      enumerates the proxy.
 *   2. Per-IP rate limit via enforceRateLimit. Free Upstash tier is
 *      enough for casual mainnet load; if it ever isn't, swap in the
 *      paid tier.
 *   3. Body size cap (1MB) — the route handler enforces request size
 *      so a misbehaving client can't push a 100MB JSON.
 *   4. Request logged sans body — we count methods for analytics but
 *      don't log params (user wallets, signatures, etc).
 *   5. Batches capped at RPC_MAX_BATCH (same as the relay's WS proxy) and
 *      every call in a batch is charged to the limiter, so one request can't
 *      buy thousands of upstream calls on the paid key.
 */
const RPC_MAX_BATCH = 10;

const ALLOWED_METHODS = new Set<string>([
  // Reads — what the dApp actually uses.
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getBlockHeight",
  "getSlot",
  "getLatestBlockhash",
  "getRecentBlockhash",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getMinimumBalanceForRentExemption",
  "simulateTransaction",
  "getEpochInfo",
  "getVersion",
  "getHealth",
  "getGenesisHash",
  // Writes — only sendTransaction. Player builds + signs client-side,
  // we just forward the bytes. Server-built ixs have their own server-
  // side send path via sendHouseTx and don't go through the proxy.
  "sendTransaction",
  // Subscription methods would require a WS proxy — explicitly NOT
  // allowlisted. The client falls back to polling (already in use via
  // confirmByPolling — see apps/web/src/lib/confirm.ts).
]);

function clusterToRpcUrl(cluster: string): string | null {
  // Cluster URL is server-only env. We DO NOT fall back to public RPCs
  // here — if it isn't set, return null and 503; explicit errors beat
  // silently degrading to a slow public endpoint that will rate-limit
  // under load.
  if (cluster === "devnet") {
    return process.env.SOLANA_RPC ?? null;
  }
  if (cluster === "mainnet" || cluster === "mainnet-beta") {
    return process.env.SOLANA_MAINNET_RPC ?? process.env.SOLANA_RPC ?? null;
  }
  return null;
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { cluster } = await ctx.params;
    // SOLANA_RPC is this deploy's own cluster, so on a mainnet (or testnet)
    // deploy /api/rpc/devnet would quietly proxy to mainnet. Serve devnet
    // only from a devnet deploy (same default as lib/cluster.ts).
    if (cluster === "devnet" && process.env.NEXT_PUBLIC_SOLANA_CLUSTER !== "devnet") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const upstream = clusterToRpcUrl(cluster);
    if (!upstream) {
      return NextResponse.json(
        { error: `RPC not configured for cluster '${cluster}'` },
        { status: 503 },
      );
    }

    // 60 RPC calls per IP per 10 seconds — a chatty wallet hitting the
    // page only sends ~5/sec at peak (blockhash + slot + balance + tx
    // + sigStatuses). Over-quota buys a 429 with retry headers.
    const rlKey = `rpc:${cluster}:${clientIp(req)}`;
    const tooMany = () =>
      NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": "10" } },
      );
    const rl = await enforceRateLimit(rlKey, 1, RPC_MAX_HITS);
    if (!rl.ok) return tooMany();

    const raw = await req.text();
    if (raw.length > 1_000_000) {
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Standard JSON-RPC payloads are { jsonrpc, id, method, params }.
    // web3.js sometimes sends batches as an array of those.
    const calls = Array.isArray(body) ? body : [body];
    if (calls.length === 0 || calls.length > RPC_MAX_BATCH) {
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: `Batch must hold 1-${RPC_MAX_BATCH} calls` },
        },
        { status: 400 },
      );
    }
    // One hit was charged above; charge the rest of the batch too.
    if (calls.length > 1 && !(await enforceRateLimit(rlKey, calls.length - 1, RPC_MAX_HITS)).ok) {
      return tooMany();
    }
    for (const c of calls) {
      const m = (c as { method?: unknown })?.method;
      if (typeof m !== "string" || !ALLOWED_METHODS.has(m)) {
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: (c as { id?: unknown })?.id ?? null,
            error: { code: -32601, message: `Method not allowed by proxy: ${m}` },
          },
          { status: 400 },
        );
      }
    }

    // Proxy. Forward Content-Type but no other client headers — we don't
    // want a leaky Authorization or cookie following the request upstream.
    const upstreamRes = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    const respBody = await upstreamRes.text();
    logger.debug(
      { cluster, methods: calls.map((c) => (c as { method?: string })?.method) },
      "rpc proxy",
    );
    return new NextResponse(respBody, {
      status: upstreamRes.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonError(err);
  }
}
