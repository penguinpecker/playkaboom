import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import {
  accountDiscriminator,
  buildSettleVrf,
  decodeVrfGame,
  deriveReferralPda,
} from "@playkaboom/sdk";
import { jsonError } from "@/server/api-helpers";
import { getConnection } from "@/server/connection";
import { sendHouseTx } from "@/server/solana";
import { housePubkey, programId, treasuryPubkey, vrfModeEnabled } from "@/server/env";
import { fetchPlayerReferrer } from "@/server/player";
import { indexFreshSignature } from "@/server/inline-ingest";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Bounded per run to stay within Vercel's 60s ceiling. */
const MAX_SETTLE_PER_RUN = 15;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
function authorise(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : auth;
  const accepted = [process.env.CRON_TICK_SECRET, process.env.CRON_SECRET].filter(
    (s): s is string => Boolean(s),
  );
  return accepted.some((s) => safeEqual(s, token));
}

/**
 * Fallback settle worker. The client normally drives settle_vrf right after the
 * ER commits (see /api/vrf/settle). This cron catches games whose player
 * disconnected before that: it scans program-owned VrfGame accounts (a
 * still-delegated game is DLP-owned and won't appear here) and settles any that
 * committed a terminal status. settle_vrf closes the game+claim, so a settled
 * game vanishes from this scan — no dedupe table needed.
 */
export async function GET(req: NextRequest) {
  try {
    if (!authorise(req)) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    if (!vrfModeEnabled()) return NextResponse.json({ skipped: "vrf mode disabled" });

    const conn = getConnection();
    const pid = programId();
    const disc = accountDiscriminator("VrfGame");
    const accounts = await conn.getProgramAccounts(pid, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
    });

    let settled = 0;
    const errors: string[] = [];
    for (const { account } of accounts) {
      if (settled >= MAX_SETTLE_PER_RUN) break;
      let player: PublicKey;
      try {
        const game = decodeVrfGame(account.data as Buffer);
        if (game.status === "Playing") continue; // not committed / not-yet-delegated
        player = game.player;
      } catch {
        continue;
      }
      try {
        const referrer = await fetchPlayerReferrer(player);
        const referralPda = referrer ? deriveReferralPda(pid, referrer)[0] : undefined;
        const sig = await sendHouseTx([
          buildSettleVrf({
            ctx: { programId: pid },
            player,
            payer: housePubkey(),
            treasury: treasuryPubkey(),
            referralPda,
          }),
        ]);
        void indexFreshSignature(sig);
        settled += 1;
      } catch (e) {
        errors.push(`${player.toBase58().slice(0, 8)}: ${(e as Error)?.message ?? "err"}`);
      }
    }

    logger.info({ scanned: accounts.length, settled, errors: errors.length }, "vrf-settle cron");
    return NextResponse.json({ scanned: accounts.length, settled, errors });
  } catch (err) {
    return jsonError(err);
  }
}
