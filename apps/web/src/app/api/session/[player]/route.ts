import { NextResponse, type NextRequest } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeGameSession,
  deriveGamePda,
  deriveVrfClaimPda,
  deriveVrfGamePda,
  decodeVrfClaim,
  decodeVrfGame,
} from "@playkaboom/sdk";
import {
  CLOSE_UNSETTLED_EXPIRY_SLOTS,
  GAME_EXPIRY_SLOTS,
} from "@playkaboom/shared";
import { jsonError } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { getConnection } from "@/server/connection";
import { loadSession } from "@/server/session-store";
import { encryptSession } from "@/server/session";
import { programId } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ player: string }>;
}

/**
 * Resume an in-flight game from any device. Returns:
 *   - active: false               → no on-chain GameSession; player is free to start a new game
 *   - active: true, gameToken     → server has the encrypted session; client can continue revealing
 *   - active: true, gameToken null → on-chain session exists but server-side mirror missing
 *                                     (older game from before session-mirror landed, or row pruned).
 *                                     UX should offer refund_expired after the cooldown.
 *
 * Authed: only the wallet's owner can resume.
 */
/** ~10s at 400ms/slot — mirrors STALL_SLOTS in programs/kaboom/src/vrf_mode.rs. */
const VRF_STALL_SLOTS = 25;

/**
 * Describe an open VRF round in the same shape the legacy path returns, so the
 * recovery banner needs no VRF-specific code.
 *
 * Returns null when there is nothing to recover. `gameToken` is always null:
 * VRF has no server-side session (the session keypair lives in the player's
 * browser), which the client reads as "stuck" and offers Recover for — the
 * correct affordance, since a lost session key is exactly when this matters.
 */
async function vrfSessionState(conn: Connection, pk: PublicKey) {
  if (process.env.VRF_MODE_ENABLED !== "true") return null;
  const [claimPda] = deriveVrfClaimPda(programId(), pk);
  // DO NOT swallow the RPC error here. `.catch(() => null)` made a failed READ
  // indistinguishable from "this player has no game", and the client treats
  // active:false as authoritative — it sets the store to idle. So one transient
  // RPC blip could wipe the UI of a player mid-round. Letting it throw reaches
  // the route's outer catch and returns HTTP 500, which the client already
  // handles by keeping its current state (`if (!res.ok) return`).
  const claimInfo = await conn.getAccountInfo(claimPda, "confirmed");
  if (!claimInfo) return null;
  let claim;
  try {
    claim = decodeVrfClaim(claimInfo.data);
  } catch {
    return null;
  }
  if (claim.settled) return null;

  // While delegated the authoritative game state lives in the rollup; L1 holds
  // a stale copy. Read the rollup when we can, but never fail the whole probe
  // on it — the banner is more useful with partial data than absent.
  let status = "Playing";
  let revealedMask = 0;
  let revealedSafeMask = 0;
  let multiplierBps = "10000";
  const erUrl = process.env.NEXT_PUBLIC_ER_RPC;
  if (erUrl) {
    try {
      const [gPda] = deriveVrfGamePda(programId(), pk);
      const gi = await new Connection(erUrl, "confirmed").getAccountInfo(gPda);
      if (gi) {
        const g = decodeVrfGame(gi.data);
        status = g.status;
        revealedMask = g.revealedMask;
        revealedSafeMask = g.revealedMask & ~g.mineMask;
        multiplierBps = g.multiplierBps.toString();
      }
    } catch {
      /* rollup unreachable — fall through with claim-only data */
    }
  }

  const currentSlot = await conn.getSlot("confirmed");
  const slotsUntilRefund = Number(claim.startSlot) + VRF_STALL_SLOTS - currentSlot;
  const refundable = slotsUntilRefund <= 0;
  return {
    active: true,
    gameToken: null,
    sessionRecovered: false,
    vrf: true,
    currentSlot,
    onChain: {
      bet: claim.bet.toString(),
      mineCount: claim.mineCount,
      revealedMask,
      revealedSafeMask,
      safeReveals: revealedSafeMask.toString(2).split("1").length - 1,
      multiplierBps,
      startSlot: claim.startSlot.toString(),
      status,
      settled: claim.settled,
      commitment: claimPda.toBase58(),
    },
    refund: {
      refundable,
      slotsUntilRefund: Math.max(0, slotsUntilRefund),
      secondsUntilRefund: refundable ? 0 : Math.max(0, Math.ceil(slotsUntilRefund * 0.4)),
    },
  };
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { player } = await ctx.params;
    let pk: PublicKey;
    try {
      pk = new PublicKey(player);
    } catch {
      return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
    }
    await verifyPlayerAuth(req, player);

    const conn = getConnection();
    const [gamePda] = deriveGamePda(programId(), pk);
    const info = await conn.getAccountInfo(gamePda, "confirmed");
    if (!info) {
      // No legacy GameSession — but a VRF round may still be open. This hook
      // drives the recovery banner, and it only ever looked for the legacy
      // PDA, so a player with a stuck VRF game saw no banner and no Recover
      // button at all: the UI reported "no active game" while their bet was
      // locked in a delegated rollup account.
      const vrf = await vrfSessionState(conn, pk);
      if (vrf) return NextResponse.json(vrf);
      return NextResponse.json({ active: false });
    }
    const game = decodeGameSession(info.data);
    const session = await loadSession(player);

    // Compute the recovery window. The program has three distinct ixs depending
    // on game status — each has its own slot timer (mirrored from @playkaboom/shared):
    //   Playing  → refund_expired         (start + GAME_EXPIRY_SLOTS, refunds bet)
    //   Won/Lost → close_unsettled_game   (start + CLOSE_UNSETTLED_EXPIRY_SLOTS, reclaims rent)
    //   Expired  → close_game             (no slot guard — already past expiry)
    const currentSlot = await conn.getSlot("confirmed");
    const startSlot = Number(game.startSlot);
    const expirySlots =
      game.status === "Playing"
        ? GAME_EXPIRY_SLOTS
        : game.status === "Expired"
          ? 0
          : CLOSE_UNSETTLED_EXPIRY_SLOTS;
    const expirySlot = startSlot + expirySlots;
    const slotsUntilRefund = expirySlot - currentSlot;
    const refundable = slotsUntilRefund <= 0;
    const secondsUntilRefund = refundable ? 0 : Math.max(0, Math.ceil(slotsUntilRefund * 0.4));

    return NextResponse.json({
      active: true,
      gameToken: session ? encryptSession(session) : null,
      sessionRecovered: !!session,
      currentSlot,
      onChain: {
        bet: game.bet.toString(),
        mineCount: game.mineCount,
        revealedMask: game.revealedMask,
        revealedSafeMask: game.revealedSafeMask,
        safeReveals: game.safeReveals,
        multiplierBps: game.multiplierBps.toString(),
        startSlot: game.startSlot.toString(),
        status: game.status,
        settled: game.settled,
        commitment: game.commitment.toString("hex"),
      },
      refund: {
        refundable,
        slotsUntilRefund: Math.max(0, slotsUntilRefund),
        secondsUntilRefund,
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
