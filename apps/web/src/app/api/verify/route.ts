import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { extractEventsFromLogs } from "@playkaboom/sdk";
import { getConnection } from "@/server/connection";
import { supabasePublic } from "@/server/db/supabase";
import { jsonError } from "@/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public verifier — chain-direct since 2026-05-11.
 *
 * Accepts either a cashout sig (the player's GameWon/GameLost tx) OR a
 * settle sig (the house's settle_game tx). Either way, returns the
 * provable-fair bundle reconstructed from on-chain event data. The
 * Supabase `games` row is consulted ONLY to resolve cashout→settle
 * pairing (via the `settle_signature` column set by the indexer) — it
 * is never trusted for the (mine_layout, mine_count, commitment, salt)
 * quartet that goes into the SHA-256 check.
 *
 * Older callers of `?sig=...` get the same response shape; the consuming
 * page checks `verified` and the bundle fields.
 */
export async function GET(req: NextRequest) {
  try {
    const sig = req.nextUrl.searchParams.get("sig");
    if (!sig) {
      return NextResponse.json({ error: "Missing sig" }, { status: 400 });
    }

    // Decode events directly from chain for whichever sig the caller gave.
    const conn = getConnection();
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      // Caller's sig might be a recent settle still propagating. We don't
      // have anything to verify yet — return found:false to match the old
      // response shape used by /verify/[sig]/page.tsx.
      return NextResponse.json({ found: false });
    }

    const events = extractEventsFromLogs(tx.meta?.logMessages ?? []);
    const won = events.find((e) => e.kind === "GameWon");
    const lost = events.find((e) => e.kind === "GameLost");
    const settled = events.find((e) => e.kind === "GameSettled");

    if (!won && !lost && !settled) {
      return NextResponse.json(
        {
          error: "No GameWon, GameLost, or GameSettled event in this tx",
          eventsFound: events.map((e) => e.kind),
        },
        { status: 400 },
      );
    }

    // Build a unified game-row-shaped response. Either branch fills in
    // whichever fields the input tx provided.
    const out: Record<string, unknown> = { found: true };
    const game: Record<string, unknown> = {
      signature: sig,
      bet: null,
      mine_count: null,
      outcome: null,
      payout: null,
      multiplier_bps: null,
      safe_reveals: null,
      mine_layout: null,
      settled_layout: null,
      commitment: null,
      salt: null,
      settled_at: new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString(),
      slot: tx.slot,
      player: null as string | null,
      verified: false as boolean,
      verifySource: "chain" as "chain" | "pending",
    };

    // Capture the cashout's game PDA for cross-check against the settle event.
    // Same-player PDA reuse can cause settle_signature to point at a different
    // game instance whose player matches but whose game PDA doesn't.
    let cashoutGamePda: string | null = null;
    if (won) {
      game.player = won.player.toBase58();
      game.bet = Number(won.bet);
      game.payout = Number(won.payout);
      game.multiplier_bps = Number(won.multiplierBps);
      game.safe_reveals = won.safeReveals;
      game.outcome = "won";
      cashoutGamePda = won.game.toBase58();
    } else if (lost) {
      game.player = lost.player.toBase58();
      game.bet = Number(lost.bet);
      game.payout = 0;
      game.multiplier_bps = 0;
      game.safe_reveals = lost.safeReveals;
      game.outcome = "lost";
      cashoutGamePda = lost.game.toBase58();
    }

    // If the input sig is itself a settle, fold in the settle event fields
    // and run the chain-direct SHA-256 check.
    let settleSource: "input" | "lookup" | "missing" = "missing";
    let settleEv = settled;
    if (settleEv) {
      settleSource = "input";
    } else if (won || lost) {
      // Caller gave us a cashout sig. Look up the paired settle signature
      // from the indexer (this column is INDEXER-WRITTEN, used here only
      // as a pointer; the actual proof comes from chain).
      const db = supabasePublic();
      const { data } = await db
        .from("games")
        .select("settle_signature, player")
        .eq("signature", sig)
        .maybeSingle();
      if (data?.settle_signature) {
        const settleTx = await conn.getTransaction(data.settle_signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (settleTx) {
          const settleEvents = extractEventsFromLogs(settleTx.meta?.logMessages ?? []);
          const s = settleEvents.find((e) => e.kind === "GameSettled");
          if (s && s.kind === "GameSettled") {
            settleEv = s;
            settleSource = "lookup";
          }
        }
      }
    }

    if (settleEv && settleEv.kind === "GameSettled") {
      // Reconstruct the commitment from on-chain settle event data ONLY.
      const layoutBytes = Buffer.alloc(2);
      layoutBytes.writeUInt16LE(settleEv.mineLayout, 0);
      const computed = createHash("sha256")
        .update(layoutBytes)
        .update(Buffer.from([settleEv.mineCount]))
        .update(settleEv.salt)
        .digest();
      const verified = computed.equals(settleEv.commitment);

      // Two cross-checks before declaring chain-direct verified:
      //  1) settle event's player matches cashout's player
      //  2) settle event's game PDA matches cashout's game PDA
      // PDA reuse can cause #1 to pass while #2 fails (same player, different
      // game instance). Both must hold — otherwise the indexer pointer is
      // pointing at a sibling game's settle, not this one's.
      const playerMismatch =
        !!game.player && settleEv.player.toBase58() !== game.player;
      const pdaMismatch =
        !!cashoutGamePda && settleEv.game.toBase58() !== cashoutGamePda;

      if (playerMismatch || pdaMismatch) {
        game.verified = false;
        game.verifySource = "pending";
        out.warning = playerMismatch
          ? "Settle event belongs to a different player — verifier link mismatch"
          : "Settle event belongs to a different game instance at this PDA — verifier link mismatch";
      } else {
        game.player = settleEv.player.toBase58();
        game.mine_count = settleEv.mineCount;
        game.mine_layout = settleEv.mineLayout;
        game.settled_layout = settleEv.mineLayout;
        game.salt = settleEv.salt.toString("hex");
        game.commitment = settleEv.commitment.toString("hex");
        game.verified = verified;
      }
      out.settleSource = settleSource;
    } else {
      // Cashout-only path with no settle linked yet. Page can show partial
      // info and prompt the user to wait for settle to be observed.
      game.verifySource = "pending";
      out.settleSource = settleSource;
    }

    out.game = game;
    return NextResponse.json(out);
  } catch (err) {
    return jsonError(err);
  }
}
