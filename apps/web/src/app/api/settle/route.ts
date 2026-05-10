import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildCashOut, buildSettleGame, serializeIx } from "@playkaboom/sdk";
import { SettleInput } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { saltBuffer } from "@/server/game";
import { loadSession, deleteSession } from "@/server/session-store";
import { sendHouseTx } from "@/server/solana";
import { housePubkey, programId } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";
import { fetchPlayerReferrer } from "@/server/player";
import { indexFreshSignature } from "@/server/inline-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, SettleInput);

    // Auth + ratelimit + session-load in parallel (see reveal/route.ts).
    const [, rl, session] = await Promise.all([
      verifyPlayerAuth(req, body.player),
      enforceRateLimit(`settle:${clientIp(req)}:${body.player}`),
      loadSession(body.player, body.gameToken),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");
    if (!session) throw new ApiError(404, "No active session — start a new game");
    if (session.player !== body.player) {
      throw new ApiError(403, "Player mismatch");
    }

    const playerPk = new PublicKey(body.player);
    const ctx = { programId: programId() };

    if (body.phase === "settle") {
      const referrer = await fetchPlayerReferrer(playerPk);
      const sig = await sendHouseTx([
        buildSettleGame({
          ctx,
          player: playerPk,
          houseAuthority: housePubkey(),
          mineLayout: session.mineLayout,
          salt: saltBuffer(session),
          referrer: referrer ?? undefined,
        }),
      ]);
      logger.info({ player: body.player, sig }, "settle");
      // Background-index the fresh sig (see reveal/route.ts). Awaiting was
      // adding 1.3s p50 / 5.2s p99 to settle response time. Cron + dedup
      // covers the same ground without blocking the player.
      void indexFreshSignature(sig);
      // Game is closed on chain; clear server-side session.
      await deleteSession(body.player);
      return NextResponse.json({ signature: sig, mineLayout: session.mineLayout, verified: true });
    }

    // Phase 1: hand the player their cash_out instruction to sign.
    const ix = buildCashOut({ ctx, player: playerPk });
    return NextResponse.json({ phase: "cashout", instruction: serializeIx(ix) });
  } catch (err) {
    return jsonError(err);
  }
}
