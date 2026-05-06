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
      // GameSettled fires after GameWon or GameLost in the same tx. Update the
      // row written by those handlers with the proof inputs needed for
      // public verification (salt + mine_count + commitment).
      await db
        .from("games")
        .update({
          mine_layout: ev.mineLayout,
          settled_layout: ev.mineLayout,
          mine_count: ev.mineCount,
          commitment: ev.commitment.toString("hex"),
          salt: ev.salt.toString("hex"),
        })
        .eq("signature", tx.signature);
      if (ev.verified) {
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

    // ─── Phase 2: LP vault events ─────────────────────────────────────────
    case "LpDeposited": {
      const userKey = ev.user.toBase58();
      const blockTime = new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();
      const unitValue =
        ev.totalUnitsAfter > 0n
          ? (BigInt(ev.vaultAssetsAfter) * (10n ** 18n)) / ev.totalUnitsAfter
          : 0n;
      await db.from("lp_actions").upsert(
        {
          signature: tx.signature,
          user_address: userKey,
          action: "deposit",
          units_delta: ev.unitsMinted.toString(),
          lamports_delta: Number(ev.amountLamports),
          unit_value_lamports: unitValue.toString(),
          slot,
          block_time: blockTime,
        },
        { onConflict: "signature" },
      );
      const { data: row } = await db
        .from("lp_positions")
        .select("units, pending_units, cumulative_deposited, first_action_at")
        .eq("user_address", userKey)
        .maybeSingle();
      await db.from("lp_positions").upsert(
        {
          user_address: userKey,
          units: ((BigInt(row?.units ?? "0") + ev.unitsMinted)).toString(),
          pending_units: row?.pending_units ?? "0",
          cumulative_deposited:
            (row?.cumulative_deposited ?? 0) + Number(ev.amountLamports),
          first_action_at: row?.first_action_at ?? blockTime,
          last_action_at: blockTime,
        },
        { onConflict: "user_address" },
      );
      break;
    }
    case "LpWithdrawRequested": {
      const userKey = ev.user.toBase58();
      const blockTime = new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();
      await db.from("lp_actions").upsert(
        {
          signature: tx.signature,
          user_address: userKey,
          action: "request_withdraw",
          units_delta: (-ev.units).toString(),
          lamports_delta: 0,
          unit_value_lamports: "0",
          slot,
          block_time: blockTime,
        },
        { onConflict: "signature" },
      );
      const { data: row } = await db
        .from("lp_positions")
        .select("units, pending_units")
        .eq("user_address", userKey)
        .maybeSingle();
      const oldUnits = BigInt(row?.units ?? "0");
      const oldPending = BigInt(row?.pending_units ?? "0");
      await db
        .from("lp_positions")
        .update({
          units: (oldUnits - ev.units).toString(),
          pending_units: (oldPending + ev.units).toString(),
          pending_unlock_slot: Number(ev.unlockSlot),
          last_action_at: blockTime,
        })
        .eq("user_address", userKey);
      break;
    }
    case "LpWithdrawCancelled": {
      const userKey = ev.user.toBase58();
      const blockTime = new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();
      await db.from("lp_actions").upsert(
        {
          signature: tx.signature,
          user_address: userKey,
          action: "cancel_withdraw",
          units_delta: ev.unitsReturned.toString(),
          lamports_delta: 0,
          unit_value_lamports: "0",
          slot,
          block_time: blockTime,
        },
        { onConflict: "signature" },
      );
      const { data: row } = await db
        .from("lp_positions")
        .select("units, pending_units")
        .eq("user_address", userKey)
        .maybeSingle();
      const oldUnits = BigInt(row?.units ?? "0");
      const oldPending = BigInt(row?.pending_units ?? "0");
      await db
        .from("lp_positions")
        .update({
          units: (oldUnits + ev.unitsReturned).toString(),
          pending_units: (oldPending - ev.unitsReturned).toString(),
          pending_unlock_slot: 0,
          last_action_at: blockTime,
        })
        .eq("user_address", userKey);
      break;
    }
    case "LpWithdrawCompleted": {
      const userKey = ev.user.toBase58();
      const blockTime = new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();
      const unitValue =
        ev.totalUnitsAfter > 0n
          ? (BigInt(ev.vaultAssetsAfter) * (10n ** 18n)) / ev.totalUnitsAfter
          : 0n;
      await db.from("lp_actions").upsert(
        {
          signature: tx.signature,
          user_address: userKey,
          action: "complete_withdraw",
          units_delta: (-ev.unitsBurned).toString(),
          lamports_delta: -Number(ev.amountLamports),
          unit_value_lamports: unitValue.toString(),
          slot,
          block_time: blockTime,
        },
        { onConflict: "signature" },
      );
      const { data: row } = await db
        .from("lp_positions")
        .select("pending_units, cumulative_withdrawn")
        .eq("user_address", userKey)
        .maybeSingle();
      const oldPending = BigInt(row?.pending_units ?? "0");
      await db
        .from("lp_positions")
        .update({
          pending_units: (oldPending - ev.unitsBurned).toString(),
          pending_unlock_slot: 0,
          cumulative_withdrawn:
            (row?.cumulative_withdrawn ?? 0) + Number(ev.amountLamports),
          last_action_at: blockTime,
        })
        .eq("user_address", userKey);
      break;
    }
    case "VaultUnitValueUpdated": {
      const blockTime = new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();
      const unitValue =
        ev.totalUnits > 0n
          ? (BigInt(ev.vaultAssets) * (10n ** 18n)) / ev.totalUnits
          : 0n;
      await db.from("vault_unit_value_history").upsert(
        {
          slot,
          vault_assets: Number(ev.vaultAssets),
          total_units: ev.totalUnits.toString(),
          unit_value_e18: unitValue.toString(),
          health_bps: ev.healthBps,
          block_time: blockTime,
        },
        { onConflict: "slot" },
      );
      break;
    }
    case "HouseDeposited":
    case "HouseWithdrawRequested":
    case "HouseWithdrawCancelled":
    case "HouseWithdrawCompleted":
    case "V2Initialized":
    case "LpPositionClosed": {
      // Tracked in actions log only — internal accounting, never returned by
      // public API. Index under sentinel `__house__` for house ops.
      const blockTime = new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();
      const userKey = ev.kind === "LpPositionClosed" ? ev.user.toBase58() : "__house__";
      const action =
        ev.kind === "HouseDeposited"
          ? "house_deposit"
          : ev.kind === "HouseWithdrawRequested"
            ? "house_request_withdraw"
            : ev.kind === "HouseWithdrawCancelled"
              ? "house_cancel_withdraw"
              : ev.kind === "HouseWithdrawCompleted"
                ? "house_complete_withdraw"
                : null;
      if (action) {
        const unitsDelta =
          ev.kind === "HouseDeposited"
            ? ev.unitsMinted
            : ev.kind === "HouseWithdrawCompleted"
              ? -ev.unitsBurned
              : ev.kind === "HouseWithdrawCancelled"
                ? ev.unitsReturned
                : ev.kind === "HouseWithdrawRequested"
                  ? -ev.units
                  : 0n;
        const lamportsDelta =
          ev.kind === "HouseDeposited"
            ? Number(ev.amountLamports)
            : ev.kind === "HouseWithdrawCompleted"
              ? -Number(ev.amountLamports)
              : 0;
        await db.from("lp_actions").upsert(
          {
            signature: tx.signature,
            user_address: userKey,
            action,
            units_delta: unitsDelta.toString(),
            lamports_delta: lamportsDelta,
            unit_value_lamports: "0",
            slot,
            block_time: blockTime,
          },
          { onConflict: "signature" },
        );
      }
      break;
    }
  }
}
