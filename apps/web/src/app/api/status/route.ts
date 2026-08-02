import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  accountDiscriminator,
  decodeGameSession,
  decodeVault,
  decodeVaultV2State,
  deriveVaultPda,
  deriveV2StatePda,
} from "@playkaboom/sdk";
import { getConnection } from "@/server/connection";
import { supabaseAdmin } from "@/server/db/supabase";
import { programId, vrfModeEnabled } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC protocol health. Unauthenticated by design — it is the evidence a
 * player uses to decide whether to trust the table right now.
 *
 * NOTHING SECRET MAY APPEAR IN THIS RESPONSE. In particular the L1 RPC is an
 * Alchemy URL carrying an API key, so only the derived facts (slot, latency)
 * are exposed, never the endpoint. Errors are reduced to a short reason string
 * for the same reason: a raw driver error can carry a connection string.
 */

type Health = "operational" | "degraded" | "down" | "unknown";

interface Component {
  id: string;
  label: string;
  status: Health;
  latencyMs: number | null;
  detail: string;
  meta?: Record<string, string | number | boolean | null>;
}

const ER_RPC = process.env.NEXT_PUBLIC_ER_RPC || "";
const TIMEOUT_MS = 6_000;

/** Bound every probe so one hung dependency cannot hang the whole page. */
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
    ]);
    return { ms: Date.now() - t0, value };
  } catch (e) {
    // Deliberately short + generic: never surface a driver message that could
    // contain a connection string or key.
    const msg = (e as Error)?.message ?? "error";
    return { ms: Date.now() - t0, error: msg.slice(0, 80) };
  }
}

async function checkSolana(): Promise<Component[]> {
  const conn = getConnection();
  const pid = programId();

  const slotProbe = await timed(() => conn.getSlot("confirmed"));
  const rpc: Component = {
    id: "solana-rpc",
    label: "Solana RPC",
    status: slotProbe.error ? "down" : slotProbe.ms > 2_000 ? "degraded" : "operational",
    latencyMs: slotProbe.ms,
    detail: slotProbe.error ? "unreachable" : `slot ${slotProbe.value}`,
  };

  const progProbe = await timed(async () => {
    const info = await conn.getAccountInfo(pid, "confirmed");
    return { exists: !!info, executable: info?.executable ?? false };
  });
  const program: Component = {
    id: "program",
    label: "Mines program",
    status: progProbe.value?.executable ? "operational" : progProbe.error ? "unknown" : "down",
    latencyMs: progProbe.ms,
    detail: progProbe.value?.executable ? "deployed & executable" : "not executable",
    meta: { address: pid.toBase58() },
  };

  const vaultProbe = await timed(async () => {
    const [vaultPda] = deriveVaultPda(pid);
    const [v2Pda] = deriveV2StatePda(pid);
    const [vi, v2i] = await Promise.all([
      conn.getAccountInfo(vaultPda, "confirmed"),
      conn.getAccountInfo(v2Pda, "confirmed"),
    ]);
    if (!vi || !v2i) throw new Error("vault missing");
    const rent = await conn.getMinimumBalanceForRentExemption(vi.data.length);
    const assets = Math.max(0, vi.lamports - rent);
    const vault = decodeVault(vi.data as Buffer);
    const v2 = decodeVaultV2State(v2i.data as Buffer);
    // Mirror calc_health_bps EXACTLY. The program counts pending WITHDRAWAL
    // units as an obligation too; omitting them made this public page report a
    // higher health than the program enforces — so the board could read
    // healthy while start_game was already refusing bets.
    const pendingValue =
      v2.totalUnits > 0n
        ? Number((v2.totalPendingUnits * BigInt(assets)) / v2.totalUnits)
        : 0;
    const obligation = Number(v2.totalOutstandingMaxPayout) + pendingValue;
    const healthBps = assets > 0 ? Math.floor((Math.max(0, assets - obligation) * 10_000) / assets) : 0;
    return {
      assets,
      healthBps,
      paused: vault.paused,
      minHealthBps: v2.minHealthBps,
      vrfArmed: !v2.vrfValidator.equals(PublicKey.default) && v2.vrfMaxPayoutBps > 0,
      vrfMaxPayoutBps: v2.vrfMaxPayoutBps,
    };
  });

  const v = vaultProbe.value;
  const vault: Component = {
    id: "vault",
    label: "Bankroll & solvency",
    status: !v
      ? "unknown"
      : v.paused
        ? "down"
        : v.healthBps < v.minHealthBps
          ? "degraded"
          : "operational",
    latencyMs: vaultProbe.ms,
    detail: !v
      ? "unreadable"
      : v.paused
        ? "PAUSED by operator"
        : `health ${(v.healthBps / 100).toFixed(2)}% (floor ${(v.minHealthBps / 100).toFixed(0)}%)`,
    meta: v
      ? {
          bankrollSol: Number((v.assets / 1e9).toFixed(6)),
          healthBps: v.healthBps,
          paused: v.paused,
        }
      : undefined,
  };

  // Stuck-capital detector. The 0.5488 SOL lock went unnoticed for 77 days
  // because nothing ever ASKED "is any of the bankroll reserved by a game
  // that stopped moving?" Health alone does not answer it — a permanently
  // stuck obligation just looks like permanently lower health.
  const stuckProbe = await timed(async () => {
    const disc = accountDiscriminator("GameSession");
    const accts = await conn.getProgramAccounts(pid, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
    });
    const now = await conn.getSlot("confirmed");
    let stuckLamports = 0;
    let oldestSlots = 0;
    let count = 0;
    for (const { account } of accts) {
      try {
        const g = decodeGameSession(account.data as Buffer);
        if (g.settled) continue;
        const age = now - Number(g.startSlot);
        // GAME_EXPIRY_SLOTS is 300 (~2 min). Anything an hour past that is
        // not a live round, it is capital nobody is coming back for.
        if (age < 9_000) continue;
        count += 1;
        stuckLamports += Number(g.maxPayout);
        oldestSlots = Math.max(oldestSlots, age);
      } catch {
        /* not a GameSession */
      }
    }
    return { count, stuckLamports, oldestSlots };
  });

  const st = stuckProbe.value;
  const stuck: Component = {
    id: "stuck-capital",
    label: "Stuck capital",
    status: !st ? "unknown" : st.count === 0 ? "operational" : "degraded",
    latencyMs: stuckProbe.ms,
    detail: !st
      ? "unreadable"
      : st.count === 0
        ? "no abandoned games holding bankroll"
        : `${st.count} abandoned game${st.count > 1 ? "s" : ""} reserving ${(st.stuckLamports / 1e9).toFixed(4)} SOL · oldest ${((st.oldestSlots * 0.4) / 86_400).toFixed(1)} days`,
    meta: st && st.count > 0 ? { reservedSol: Number((st.stuckLamports / 1e9).toFixed(4)), games: st.count } : undefined,
  };

  const vrf: Component = {
    id: "vrf-gate",
    label: "Per-click VRF mode",
    status: !v ? "unknown" : v.vrfArmed && vrfModeEnabled() ? "operational" : "down",
    latencyMs: null,
    detail: !v
      ? "unknown"
      : !v.vrfArmed
        ? "disabled on-chain"
        : !vrfModeEnabled()
          ? "disabled server-side"
          : `armed · payout cap ${(v.vrfMaxPayoutBps / 100).toFixed(0)}% of bankroll`,
  };

  return [rpc, program, vault, vrf, stuck];
}

async function checkRollup(): Promise<Component> {
  if (!ER_RPC) {
    return {
      id: "magicblock",
      label: "MagicBlock rollup",
      status: "down",
      latencyMs: null,
      detail: "no endpoint configured",
    };
  }
  const probe = await timed(async () => {
    const call = async (method: string) => {
      const r = await fetch(ER_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
        cache: "no-store",
      });
      const j = await r.json();
      return j.result;
    };
    const [health, slot, version] = await Promise.all([
      call("getHealth"),
      call("getSlot"),
      call("getVersion"),
    ]);
    return { health, slot, core: version?.["magicblock-core"] ?? "?" };
  });
  const ok = probe.value?.health === "ok";
  return {
    id: "magicblock",
    label: "MagicBlock rollup",
    status: probe.error ? "down" : ok ? (probe.ms > 2_000 ? "degraded" : "operational") : "degraded",
    latencyMs: probe.ms,
    detail: probe.error ? "unreachable" : `slot ${probe.value?.slot} · core ${probe.value?.core}`,
    // Host only — never a URL that could carry credentials. This one is public
    // by nature, but the rule is uniform.
    meta: { node: ER_RPC.replace(/^https?:\/\//, "").replace(/\/$/, "") },
  };
}

async function checkDatabase(): Promise<Component[]> {
  const conn = getConnection();
  const pid = programId();
  const probe = await timed(async () => {
    const db = supabaseAdmin();
    const [state, game, newestOnChain] = await Promise.all([
      db
        .from("cron_indexer_state")
        .select("last_slot")
        .eq("program", pid.toBase58())
        .maybeSingle(),
      db.from("games").select("settled_at").order("slot", { ascending: false }).limit(1).maybeSingle(),
      conn.getSignaturesForAddress(pid, { limit: 1 }),
    ]);
    if (state.error) throw new Error("query failed");
    return {
      indexedSlot: state.data?.last_slot ? Number(state.data.last_slot) : null,
      chainSlot: newestOnChain?.[0]?.slot ?? null,
      lastGameAt: game.data?.settled_at ? new Date(game.data.settled_at).getTime() : null,
    };
  });

  const db: Component = {
    id: "database",
    label: "Database",
    status: probe.error ? "down" : "operational",
    latencyMs: probe.ms,
    detail: probe.error ? "unreachable" : "reachable",
  };

  // MEASURE THE INDEXER AGAINST PROGRAM ACTIVITY, NOT WALL-CLOCK.
  //
  // Two wrong versions preceded this. Comparing the newest GAME row to the
  // current chain slot, and comparing the last run timestamp to now, BOTH
  // conflate "nobody has played" with "the indexer is broken" — on a quiet
  // table they climb forever and the page cries outage while everything is
  // healthy. (`cron_indexer_state` has no updated_at trigger either, so the
  // timestamp read as 68 days stale on a cursor being written every minute.)
  //
  // The honest question is: has the indexer consumed everything the PROGRAM
  // has emitted? Compare its cursor to the newest program signature on chain.
  // Quiet program → both sit at the same slot → healthy. Indexer stalls while
  // games are being played → the gap grows immediately.
  const indexedSlot = probe.value?.indexedSlot ?? null;
  const newestSlot = probe.value?.chainSlot ?? null;
  const behind = indexedSlot !== null && newestSlot !== null ? Math.max(0, newestSlot - indexedSlot) : null;
  const behindMin = behind !== null ? (behind * 0.4) / 60 : null;
  const indexer: Component = {
    id: "indexer",
    label: "Indexer",
    status:
      behindMin === null
        ? "unknown"
        : behindMin < 5
          ? "operational"
          : behindMin < 30
            ? "degraded"
            : "down",
    latencyMs: null,
    detail:
      behindMin === null
        ? "no cursor recorded"
        : behind === 0
          ? "caught up with the program"
          : behindMin < 2
            ? "caught up (within a block or two)"
            : `${behindMin < 60 ? `${Math.round(behindMin)} min` : `${(behindMin / 60).toFixed(1)} h`} behind program activity`,
    meta: {
      // Reported for context, NEVER used for status: this is player activity,
      // not system health.
      lastGameMinutesAgo: probe.value?.lastGameAt
        ? Math.round((Date.now() - probe.value.lastGameAt) / 60_000)
        : null,
      slotsBehind: behind,
    },
  };
  return [db, indexer];
}

async function checkRealtime(): Promise<Component> {
  const url = process.env.NEXT_PUBLIC_REALTIME_WS_URL || "";
  if (!url) {
    return {
      id: "realtime",
      label: "Realtime relay",
      status: "down",
      latencyMs: null,
      detail: "not configured — feed falls back to polling",
    };
  }
  // Probe /health, NOT the root. The relay serves no GET route at "/", so
  // hitting the root returns 404 — indistinguishable from Railway's
  // "no service bound" 404, which made a perfectly healthy relay report DOWN.
  const httpUrl = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "") + "/health";
  const probe = await timed(async () => {
    const r = await fetch(httpUrl, { method: "GET", cache: "no-store" });
    const body = r.ok ? ((await r.json()) as { ok?: boolean; clients?: number; upstream?: boolean }) : null;
    return { code: r.status, body };
  });
  const code = probe.value?.code;
  const body = probe.value?.body;
  // `upstream` is the relay's own Supabase Realtime connection. Reachable but
  // upstream-down means it is running and fanning out nothing — degraded, not
  // healthy, and worth distinguishing.
  const healthy = code === 200 && body?.ok === true;
  return {
    id: "realtime",
    label: "Realtime relay",
    status: probe.error || code === 404 ? "down" : healthy ? (body?.upstream ? "operational" : "degraded") : "degraded",
    latencyMs: probe.ms,
    detail: probe.error
      ? "unreachable"
      : code === 404
        ? "no service bound (feed falls back to polling)"
        : healthy
          ? `live · ${body?.clients ?? 0} connected${body?.upstream ? "" : " · upstream disconnected"}`
          : `unexpected response (HTTP ${code})`,
  };
}

// Module-scope memo for the SAME 10s the cache-control header advertises.
// The CDN caches by full URL, so /api/status?x=1,2,3… each reached the origin
// and re-ran getProgramAccounts on the paid RPC key. Returning a memoized body
// makes the cache-bust free regardless of IP, which the per-instance rate
// limiter could not guarantee.
const MEMO_MS = 10_000;
let memo: { at: number; body: unknown } | null = null;

export async function GET() {
  if (memo && Date.now() - memo.at < MEMO_MS) {
    return NextResponse.json(memo.body, {
      headers: { "cache-control": "public, max-age=10, s-maxage=10, stale-while-revalidate=30" },
    });
  }
  const [solana, rollup, realtime] = await Promise.all([
    checkSolana(),
    checkRollup(),
    checkRealtime(),
  ]);
  const dbComponents = await checkDatabase();

  const components = [...solana, rollup, ...dbComponents, realtime];

  // Worst-of rollup, but weighted: a down dependency that only affects
  // freshness must not read the same as one that stops play.
  const CRITICAL = new Set(["solana-rpc", "program", "vault"]);
  const anyCriticalDown = components.some((c) => CRITICAL.has(c.id) && c.status === "down");
  const anyDown = components.some((c) => c.status === "down");
  const anyDegraded = components.some((c) => c.status === "degraded");
  const overall: Health = anyCriticalDown
    ? "down"
    : anyDown || anyDegraded
      ? "degraded"
      : "operational";

  const body = { overall, checkedAt: new Date().toISOString(), components };
  memo = { at: Date.now(), body };
  return NextResponse.json(
    body,
    {
      headers: {
        // Short public cache: enough to blunt refresh spam, short enough that
        // an incident is visible within seconds.
        "cache-control": "public, max-age=10, s-maxage=10, stale-while-revalidate=30",
      },
    },
  );
}
