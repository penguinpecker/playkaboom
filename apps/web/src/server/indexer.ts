import "server-only";
import { extractEventsFromLogs, type KaboomEvent } from "@playkaboom/sdk";
import { supabaseAdmin } from "./db/supabase";
import { logger } from "./logger";

/** Minimal payload shape needed to apply an event — works for both Helius
 * webhook payloads and our own cron-fetched transactions. */
export interface IndexableTx {
  signature: string;
  slot: number;
  blockTime?: number;
  logMessages?: string[];
  err?: unknown;
}

export interface IndexResult {
  processed: number;
  skipped: number;
  errors: number;
}

/** Process a batch of transactions: dedupe via processed_events, decode each
 * event, and apply to indexer tables. Returns counts for caller logging. */
export async function ingestTransactions(txs: IndexableTx[]): Promise<IndexResult> {
  const db = supabaseAdmin();
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const tx of txs) {
    try {
      if (!tx.signature || tx.err) {
        skipped++;
        continue;
      }
      const events = extractEventsFromLogs(tx.logMessages ?? []);
      if (events.length === 0) {
        skipped++;
        continue;
      }
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
        await applyEvent(ev, tx);
      }
      await db.from("processed_events").insert({
        signature: tx.signature,
        ix_kind: events.map((e) => e.kind).join(","),
      });
      processed++;
    } catch (err) {
      errors++;
      logger.error(
        { err: err instanceof Error ? err.message : err, sig: tx.signature },
        "indexer apply error",
      );
    }
  }
  return { processed, skipped, errors };
}

async function applyEvent(ev: KaboomEvent, tx: IndexableTx): Promise<void> {
  const db = supabaseAdmin();
  const slot = Number(ev.slot ?? tx.slot ?? 0);
  const blockTime = new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();

  switch (ev.kind) {
    case "StatsUpdated": {
      await db.from("player_stats").upsert(
        {
          player: ev.player.toBase58(),
          games_played: Number(ev.gamesPlayed),
          games_won: Number(ev.gamesWon),
          total_wagered: Number(ev.totalWagered),
          total_payouts: Number(ev.totalPayouts),
          biggest_win: Number(ev.biggestWin),
          current_streak: ev.currentStreak,
          best_streak: ev.currentStreak,
          last_played: blockTime,
        },
        { onConflict: "player" },
      );
      break;
    }
    case "GameSettled": {
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
          mine_count: 0,
          outcome: "won",
          payout: Number(ev.payout),
          multiplier_bps: Number(ev.multiplierBps),
          safe_reveals: ev.safeReveals,
          mine_layout: null,
          commitment: "0".repeat(64),
          settled_at: blockTime,
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
          settled_at: blockTime,
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
          occurred_at: blockTime,
          slot,
        },
        { onConflict: "signature" },
      );
      const { data: row } = await db
        .from("referrals")
        .select("accrued_lamports,total_earned,referred_volume,referred_count,tier")
        .eq("referrer", ev.referrer.toBase58())
        .maybeSingle();
      const amount = Number(ev.amount);
      await db.from("referrals").upsert(
        {
          referrer: ev.referrer.toBase58(),
          accrued_lamports: (row?.accrued_lamports ?? 0) + amount,
          total_earned: (row?.total_earned ?? 0) + amount,
          referred_volume: (row?.referred_volume ?? 0) + amount * 200,
          referred_count: row?.referred_count ?? 0,
          tier: ev.tier,
        },
        { onConflict: "referrer" },
      );
      break;
    }
    case "ReferralTierChanged": {
      await db.from("referrals").update({ tier: ev.newTier }).eq("referrer", ev.referrer.toBase58());
      break;
    }
    case "ReferralClaimed": {
      const { data: row } = await db
        .from("referrals")
        .select("accrued_lamports")
        .eq("referrer", ev.referrer.toBase58())
        .maybeSingle();
      const remaining = Math.max(0, (row?.accrued_lamports ?? 0) - Number(ev.amount));
      await db.from("referrals").update({ accrued_lamports: remaining }).eq("referrer", ev.referrer.toBase58());
      break;
    }
    // ─── Phase 2: LP vault events ─────────────────────────────────────────
    case "LpDeposited": {
      const userKey = ev.user.toBase58();
      const unitValue =
        ev.totalUnitsAfter > 0n ? (BigInt(ev.vaultAssetsAfter) * 10n ** 18n) / ev.totalUnitsAfter : 0n;
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
          units: (BigInt(row?.units ?? "0") + ev.unitsMinted).toString(),
          pending_units: row?.pending_units ?? "0",
          cumulative_deposited: (row?.cumulative_deposited ?? 0) + Number(ev.amountLamports),
          first_action_at: row?.first_action_at ?? blockTime,
          last_action_at: blockTime,
        },
        { onConflict: "user_address" },
      );
      break;
    }
    case "LpWithdrawRequested": {
      const userKey = ev.user.toBase58();
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
      const unitValue =
        ev.totalUnitsAfter > 0n ? (BigInt(ev.vaultAssetsAfter) * 10n ** 18n) / ev.totalUnitsAfter : 0n;
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
          cumulative_withdrawn: (row?.cumulative_withdrawn ?? 0) + Number(ev.amountLamports),
          last_action_at: blockTime,
        })
        .eq("user_address", userKey);
      break;
    }
    case "VaultUnitValueUpdated": {
      const unitValue =
        ev.totalUnits > 0n ? (BigInt(ev.vaultAssets) * 10n ** 18n) / ev.totalUnits : 0n;
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
