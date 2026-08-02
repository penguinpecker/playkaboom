import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import {
  accountDiscriminator,
  buildSettleVrf,
  decodeVrfGame,
  deriveReferralPda,
  buildRefundStalledVrf,
  deriveVrfClaimPda,
  deriveVrfGamePda,
  decodeVrfClaim
} from "@playkaboom/sdk";
import { jsonError } from "@/server/api-helpers";
import { getConnection } from "@/server/connection";
import { sendHouseTx } from "@/server/solana";
import { housePubkey, programId, treasuryPubkey, vrfModeEnabled } from "@/server/env";
import { fetchPlayerReferrer } from "@/server/player";
import { indexFreshSignature } from "@/server/inline-ingest";
import { recordVrfGame } from "@/server/indexer";
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
        // MIRROR IT. settle_vrf emits no Anchor events, so indexFreshSignature
        // finds nothing to decode — a game settled by this fallback worker
        // would never reach the activity feed or leaderboard at all. The
        // client-driven /api/vrf/settle already does this; the worker that
        // exists precisely for disconnected players did not.
        try {
          const [cPda] = deriveVrfClaimPda(pid, player);
          const cInfo = await conn.getAccountInfo(cPda, "confirmed");
          const g = decodeVrfGame(account.data as Buffer);
          if (cInfo) {
            const cl = decodeVrfClaim(cInfo.data as Buffer);
            const won = g.status === "Won";
            await recordVrfGame({
              signature: sig,
              gamePda: deriveVrfGamePda(pid, player)[0].toBase58(),
              player: player.toBase58(),
              betLamports: cl.bet,
              payoutLamports: won ? (cl.bet * BigInt(g.multiplierBps)) / 10_000n : 0n,
              multiplierBps: Number(g.multiplierBps),
              safeReveals: g.safeReveals,
              mineCount: cl.mineCount,
              won,
              slot: await conn.getSlot("confirmed").catch(() => 0),
              blockTime: new Date().toISOString(),
            });
          }
        } catch (e) {
          logger.error({ err: e, sig }, "vrf cron mirror write failed");
        }
        settled += 1;
      } catch (e) {
        errors.push(`${player.toBase58().slice(0, 8)}: ${(e as Error)?.message ?? "err"}`);
      }
    }

    // ── SECOND PASS: refund games the player walked away from ──────────────
    //
    // Why this exists: a legacy v1 GameSession sat Playing for 77 DAYS holding
    // 0.5488 SOL of the bankroll hostage, because refund_expired is
    // player-signed and the player never came back. VRF does NOT have that
    // flaw — refund_stalled_vrf explicitly accepts the house authority — but
    // nothing was actually exercising that right, so the same rot could set in.
    //
    // Deliberately conservative:
    //   * 24h, not the program's 25-slot minimum. A player mid-session on a
    //     flaky connection must never have their round pulled out from under
    //     them; this is for genuine abandonment.
    //   * safe_reveals == 0 ONLY. A refund returns the bet and destroys any
    //     accrued multiplier, and the house cannot cash out on the player's
    //     behalf (cash_out_vrf takes session_key or player, never house). So
    //     a game holding real winnings is left alone and surfaced instead —
    //     silently converting someone's 5x into a bet refund would be theft.
    const ABANDON_SLOTS = 216_000; // ~24h at 400ms
    const nowSlot = await conn.getSlot("confirmed");
    let refunded = 0;
    const needsReview: string[] = [];
    for (const { account } of accounts) {
      if (refunded >= MAX_SETTLE_PER_RUN) break;
      let game;
      try {
        game = decodeVrfGame(account.data as Buffer);
      } catch {
        continue;
      }
      if (game.status !== "Playing") continue;
      const [claimPda] = deriveVrfClaimPda(pid, game.player);
      const ci = await conn.getAccountInfo(claimPda, "confirmed").catch(() => null);
      if (!ci) continue;
      let claim;
      try {
        claim = decodeVrfClaim(ci.data as Buffer);
      } catch {
        continue;
      }
      if (claim.settled) continue;
      if (nowSlot - Number(claim.startSlot) < ABANDON_SLOTS) continue;
      if (game.safeReveals > 0) {
        // Has earned value — never auto-refund. Flag for a human.
        needsReview.push(game.player.toBase58());
        continue;
      }
      try {
        const sig = await sendHouseTx([
          buildRefundStalledVrf({ ctx: { programId: pid }, player: game.player, caller: housePubkey() }),
        ]);
        void indexFreshSignature(sig);
        refunded += 1;
        logger.info({ player: game.player.toBase58(), sig }, "swept abandoned vrf game");
      } catch (e) {
        errors.push(`refund ${game.player.toBase58().slice(0, 8)}: ${(e as Error)?.message ?? "err"}`);
      }
    }
    if (needsReview.length) {
      logger.warn({ players: needsReview }, "abandoned vrf games WITH winnings — manual review");
    }

    logger.info(
      { scanned: accounts.length, settled, refunded, needsReview: needsReview.length, errors: errors.length },
      "vrf-settle cron",
    );
    return NextResponse.json({ scanned: accounts.length, settled, refunded, needsReview, errors });
  } catch (err) {
    return jsonError(err);
  }
}
