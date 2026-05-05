import { NextResponse, type NextRequest } from "next/server";
import { extractEventsFromLogs, type KaboomEvent } from "@playkaboom/sdk";
import { jsonError } from "@/server/api-helpers";
import { verifyWebhookSignature } from "@/server/webhook-auth";
import { supabaseAdmin } from "@/server/db/supabase";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Helius enhanced-webhook payload shape (subset we use).
 * https://docs.helius.dev/webhooks-and-websockets/enhanced-webhooks
 */
interface HeliusTx {
  signature: string;
  slot: number;
  blockTime?: number;
  meta?: { logMessages?: string[]; err?: unknown };
  transactionError?: unknown;
  // Older webhook variants put the logs at top level
  logMessages?: string[];
}

/**
 * Multi-event ingestion. Idempotent via `processed_events`. Each Anchor event
 * triggers an upsert into the indexer table that mirrors it.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    await verifyWebhookSignature(req, raw);

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const txs: HeliusTx[] = Array.isArray(payload)
      ? (payload as HeliusTx[])
      : ([payload] as HeliusTx[]);

    let processed = 0;
    let skipped = 0;
    const db = supabaseAdmin();

    for (const tx of txs) {
      if (!tx?.signature) continue;
      if (tx.transactionError || tx.meta?.err) {
        skipped++;
        continue;
      }
      const logs = tx.meta?.logMessages ?? tx.logMessages ?? [];
      const events = extractEventsFromLogs(logs);
      if (events.length === 0) {
        skipped++;
        continue;
      }

      // Idempotency — one row per (signature, ix_kind). Skip if already done.
      const { data: existing } = await db
        .from("processed_events")
        .select("signature")
        .eq("signature", tx.signature)
        .maybeSingle();

      if (existing) {
        skipped++;
        continue;
      }

      for (const ev of events) {
        await applyEvent(db, ev, tx);
      }

      await db.from("processed_events").insert({
        signature: tx.signature,
        ix_kind: events.map((e) => e.kind).join(","),
      });

      processed++;
    }

    return NextResponse.json({ ok: true, processed, skipped });
  } catch (err) {
    return jsonError(err);
  }
}

async function applyEvent(
  db: ReturnType<typeof supabaseAdmin>,
  ev: KaboomEvent,
  tx: HeliusTx,
): Promise<void> {
  const slot = Number(ev.slot ?? tx.slot ?? 0);

  switch (ev.kind) {
    case "StatsUpdated": {
      // Pull on-chain referrer separately via PlayerStats account decode is
      // out of scope for the webhook (we'd need an extra RPC). Instead the
      // ReferrerSet event seeds the `referrer` column.
      await db
        .from("player_stats")
        .upsert(
          {
            player: ev.player.toBase58(),
            games_played: Number(ev.gamesPlayed),
            games_won: Number(ev.gamesWon),
            total_wagered: Number(ev.totalWagered),
            total_payouts: Number(ev.totalPayouts),
            biggest_win: Number(ev.biggestWin),
            current_streak: ev.currentStreak,
            best_streak: ev.currentStreak, // server reads max; trigger could improve later
            last_played: new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString(),
          },
          { onConflict: "player" },
        );
      break;
    }
    case "GameSettled": {
      const verified = ev.verified;
      // GameSettled fires after GameWon or GameLost. We update the row written
      // by those handlers with the final layout.
      await db
        .from("games")
        .update({ mine_layout: ev.mineLayout, commitment: ev.commitment.toString("hex") })
        .eq("signature", tx.signature);
      if (verified) {
        logger.info({ sig: tx.signature, player: ev.player.toBase58() }, "settle verified");
      }
      break;
    }
    case "GameWon": {
      await db.from("games").upsert(
        {
          signature: tx.signature,
          player: ev.player.toBase58(),
          bet: Number(ev.bet),
          mine_count: 0, // not in event; filled by GameStarted in P2 if we add it to webhook
          outcome: "won",
          payout: Number(ev.payout),
          multiplier_bps: Number(ev.multiplierBps),
          safe_reveals: ev.safeReveals,
          mine_layout: null,
          commitment: "0".repeat(64),
          settled_at: new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString(),
          slot,
        },
        { onConflict: "signature" },
      );
      break;
    }
    case "GameLost": {
      await db.from("games").upsert(
        {
          signature: tx.signature,
          player: ev.player.toBase58(),
          bet: Number(ev.bet),
          mine_count: 0,
          outcome: "lost",
          payout: 0,
          multiplier_bps: 0,
          safe_reveals: ev.safeReveals,
          mine_layout: null,
          commitment: "0".repeat(64),
          settled_at: new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString(),
          slot,
        },
        { onConflict: "signature" },
      );
      break;
    }
    case "ReferrerSet": {
      await db
        .from("player_stats")
        .upsert(
          { player: ev.player.toBase58(), referrer: ev.referrer.toBase58() },
          { onConflict: "player" },
        );
      // Make sure referrer row exists too (idempotent).
      await db
        .from("referrals")
        .upsert(
          { referrer: ev.referrer.toBase58() },
          { onConflict: "referrer", ignoreDuplicates: true },
        );
      break;
    }
    case "ReferralAccrued": {
      await db.from("referral_events").upsert(
        {
          signature: tx.signature,
          referrer: ev.referrer.toBase58(),
          player: ev.player.toBase58(),
          amount: Number(ev.amount),
          tier: ev.tier,
          occurred_at: new Date(
            (tx.blockTime ?? Date.now() / 1000) * 1000,
          ).toISOString(),
          slot,
        },
        { onConflict: "signature" },
      );
      // Bump aggregates. Doing this via SELECT-then-UPDATE is racy; in
      // production we'd use a stored procedure. Acceptable for P1.
      const { data: row } = await db
        .from("referrals")
        .select("accrued_lamports,total_earned,referred_volume,referred_count,tier")
        .eq("referrer", ev.referrer.toBase58())
        .maybeSingle();
      const amount = Number(ev.amount);
      const next = {
        referrer: ev.referrer.toBase58(),
        accrued_lamports: (row?.accrued_lamports ?? 0) + amount,
        total_earned: (row?.total_earned ?? 0) + amount,
        referred_volume: (row?.referred_volume ?? 0) + amount * 200, // bet ≈ amount / 0.005
        referred_count: row?.referred_count ?? 0,
        tier: ev.tier,
      };
      await db.from("referrals").upsert(next, { onConflict: "referrer" });
      break;
    }
    case "ReferralTierChanged": {
      await db
        .from("referrals")
        .update({ tier: ev.newTier })
        .eq("referrer", ev.referrer.toBase58());
      break;
    }
    case "ReferralClaimed": {
      const { data: row } = await db
        .from("referrals")
        .select("accrued_lamports")
        .eq("referrer", ev.referrer.toBase58())
        .maybeSingle();
      const remaining = Math.max(0, (row?.accrued_lamports ?? 0) - Number(ev.amount));
      await db
        .from("referrals")
        .update({ accrued_lamports: remaining })
        .eq("referrer", ev.referrer.toBase58());
      break;
    }
  }
}
