import "server-only";
import { extractEventsFromLogs, type KaboomEvent } from "@playkaboom/sdk";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin } from "./db/supabase";
import { logger } from "./logger";
import { awardPoints } from "./points";

// House edge that was live when this rev of the indexer shipped. Captured
// per-row in `points_ledger.edge_bps`, so historical points stay correct
// even if we change the on-chain edge later via update_vault. If we ever
// change the live edge, bump this constant in the same PR — or better,
// thread the actual edge through the event pipeline. For now both the
// program and this constant are 200.
const POINTS_EDGE_BPS = 200;

/** Throw on Postgrest errors so they surface in `ingestTransactions`'s catch
 * block (logged + counted) instead of being silently swallowed. */
function check(table: string, ev: string, res: { error: PostgrestError | null }): void {
  if (res.error) {
    throw new Error(`[${ev}→${table}] ${res.error.code ?? ""} ${res.error.message}`);
  }
}

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
 * event, and apply to indexer tables. Returns counts for caller logging.
 *
 * Dedupe is INSERT-FIRST (insert into processed_events with the signature PK;
 * if the row already existed, the insert is a no-op and we skip — closing the
 * 2026-05-11 TOCTOU where two concurrent Helius deliveries of the same sig
 * both passed a SELECT check and both applied their events).
 *
 * 2026-05-11 hardening: if applyEvent throws mid-loop, we DELETE the
 * processed_events claim before rethrowing. Without this, a transient DB
 * error after the claim but before all events applied would leave the sig
 * marked processed with some of its events permanently dropped (retry from
 * Helius/cron would be dedup-skipped). The DELETE is best-effort; if it
 * itself fails, we still report the apply error — the sig stays claimed,
 * which is the conservative side: at-most-once for the unapplied events
 * vs at-least-once if we re-applied on retry (the atomic idx_apply_* RPCs
 * already make every handler commutative, so at-least-once is safe). */
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
      // Attempt to claim this signature. If another concurrent ingest already
      // inserted it, `inserted` will be empty array — skip without applying.
      // The `.select()` after `.insert(..., { ignoreDuplicates: true })` returns
      // the inserted rows (empty on conflict). This is the atomic claim.
      const { data: inserted, error: insErr } = await db
        .from("processed_events")
        .insert(
          { signature: tx.signature, ix_kind: events.map((e) => e.kind).join(",") },
          { count: "exact" },
        )
        .select("signature");
      if (insErr) {
        // Unique-violation = already claimed by another ingest, skip silently.
        if (insErr.code === "23505") {
          skipped++;
          continue;
        }
        throw new Error(`[processed_events.insert] ${insErr.code ?? ""} ${insErr.message}`);
      }
      if (!inserted || inserted.length === 0) {
        skipped++;
        continue;
      }
      // Apply events; on ANY throw, release the claim so a retry can re-attempt.
      try {
        for (const ev of events) {
          await applyEvent(ev, tx);
        }
      } catch (applyErr) {
        const del = await db
          .from("processed_events")
          .delete()
          .eq("signature", tx.signature);
        if (del.error) {
          logger.error(
            { sig: tx.signature, err: del.error.message },
            "[indexer] FAILED to release processed_events claim after apply error — sig will be skipped on retry",
          );
        }
        throw applyErr;
      }
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
      // Slot-monotonic upsert via idx_apply_stats — late-arriving older events
      // no-op instead of reverting newer counters. biggest_win + best_streak
      // are GREATEST'd inside the function so they stay monotonic even if a
      // later event has a smaller absolute value (shouldn't happen on chain
      // but the function is defensive).
      const rpc = await db.rpc("idx_apply_stats", {
        p_player: ev.player.toBase58(),
        p_games_played: Number(ev.gamesPlayed),
        p_games_won: Number(ev.gamesWon),
        p_total_wagered: Number(ev.totalWagered),
        p_total_payouts: Number(ev.totalPayouts),
        p_biggest_win: Number(ev.biggestWin),
        p_current_streak: ev.currentStreak,
        p_best_streak: ev.currentStreak,
        p_last_played: blockTime,
        p_event_slot: slot,
      });
      check("player_stats", "StatsUpdated.rpc", rpc);
      break;
    }
    case "GameSettled": {
      // 2026-05-11 fix: the old "match by PDA + null mine_layout" pattern
      // still mis-targeted when multiple in-flight rows for the same PDA
      // existed simultaneously (player cashes out game A, starts game B,
      // game A's settle then matched BOTH rows). idx_apply_game_settled
      // picks the SINGLE most-recent unsettled row at slot <= settle slot.
      // Also records this settle tx's signature so the public verifier
      // page can chain-direct verify from a cashout sig URL.
      const game = ev.game.toBase58();
      const rpc = await db.rpc("idx_apply_game_settled", {
        p_game: game,
        p_mine_layout: ev.mineLayout,
        p_mine_count: ev.mineCount,
        p_commitment: ev.commitment.toString("hex"),
        p_salt: ev.salt.toString("hex"),
        p_settle_signature: tx.signature,
        p_event_slot: slot,
      });
      check("games", "GameSettled.rpc", rpc);
      if (ev.verified) {
        logger.info({ sig: tx.signature, game, player: ev.player.toBase58() }, "settle verified");
      }
      break;
    }
    case "GameWon": {
      const res = await db.from("games").upsert(
        {
          signature: tx.signature,
          game: ev.game.toBase58(),
          player: ev.player.toBase58(),
          bet: Number(ev.bet),
          mine_count: 0, // sentinel — filled in by GameSettled handler keyed on `game`
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
      check("games", "GameWon.upsert", res);
      // Award XP. Idempotent on (sourceKey, source) — replaying this event
      // never double-credits. tier/streak/event multipliers default to 1.0×
      // until those feeders ship; we still capture the bet+edge in the row.
      await awardPoints({
        player: ev.player.toBase58(),
        sourceKey: tx.signature,
        source: "game_won",
        betLamports: BigInt(ev.bet),
        edgeBps: POINTS_EDGE_BPS,
      });
      break;
    }
    case "GameLost": {
      const res = await db.from("games").upsert(
        {
          signature: tx.signature,
          game: ev.game.toBase58(),
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
      check("games", "GameLost.upsert", res);
      await awardPoints({
        player: ev.player.toBase58(),
        sourceKey: tx.signature,
        source: "game_lost",
        betLamports: BigInt(ev.bet),
        edgeBps: POINTS_EDGE_BPS,
      });
      break;
    }
    case "ReferrerSet": {
      // On-chain set_referrer can only fire once per player (stats.referrer is
      // immutable after first set), so the RPC is first-write-wins.
      const r1 = await db.rpc("idx_apply_referrer_set", {
        p_player: ev.player.toBase58(),
        p_referrer: ev.referrer.toBase58(),
      });
      check("player_stats", "ReferrerSet.rpc", r1);
      // Make sure the referrer row exists; ignore conflicts.
      await db
        .from("referrals")
        .upsert(
          { referrer: ev.referrer.toBase58() },
          { onConflict: "referrer", ignoreDuplicates: true },
        );
      break;
    }
    case "ReferralAccrued": {
      // Event log table — keyed on signature PK, safe to upsert.
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
      // Atomic SQL increment via RPC — no read-modify-write race. The function
      // computes referred_volume from the tier bps (50/60/70), replacing the
      // old hard-coded × 200 (only correct for tier 0).
      const rpc = await db.rpc("idx_apply_referral_accrued", {
        p_referrer: ev.referrer.toBase58(),
        p_amount: Number(ev.amount),
        p_tier: ev.tier,
        p_event_slot: slot,
      });
      check("referrals", "ReferralAccrued.rpc", rpc);
      break;
    }
    case "ReferralTierChanged": {
      // Slot-guarded inside the RPC — older deliveries no-op.
      const rpc = await db.rpc("idx_apply_referral_tier", {
        p_referrer: ev.referrer.toBase58(),
        p_new_tier: ev.newTier,
        p_event_slot: slot,
      });
      check("referrals", "ReferralTierChanged.rpc", rpc);
      break;
    }
    case "ReferralClaimed": {
      // Atomic decrement, clamped at 0 inside the RPC.
      const rpc = await db.rpc("idx_apply_referral_claimed", {
        p_referrer: ev.referrer.toBase58(),
        p_amount: Number(ev.amount),
        p_event_slot: slot,
      });
      check("referrals", "ReferralClaimed.rpc", rpc);
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
      // Atomic SQL increment — no RMW race even under concurrent webhook delivery.
      const rpc = await db.rpc("idx_apply_lp_deposit", {
        p_user_address: userKey,
        p_units_delta: ev.unitsMinted.toString(),
        p_lamports_delta: Number(ev.amountLamports),
        p_block_time: blockTime,
        p_event_slot: slot,
      });
      check("lp_positions", "LpDeposited.rpc", rpc);
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
      const rpc = await db.rpc("idx_apply_lp_request", {
        p_user_address: userKey,
        p_units: ev.units.toString(),
        p_unlock_slot: Number(ev.unlockSlot),
        p_block_time: blockTime,
        p_event_slot: slot,
      });
      check("lp_positions", "LpWithdrawRequested.rpc", rpc);
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
      const rpc = await db.rpc("idx_apply_lp_cancel", {
        p_user_address: userKey,
        p_units_returned: ev.unitsReturned.toString(),
        p_block_time: blockTime,
        p_event_slot: slot,
      });
      check("lp_positions", "LpWithdrawCancelled.rpc", rpc);
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
      const rpc = await db.rpc("idx_apply_lp_complete", {
        p_user_address: userKey,
        p_units_burned: ev.unitsBurned.toString(),
        p_lamports_out: Number(ev.amountLamports),
        p_block_time: blockTime,
        p_event_slot: slot,
      });
      check("lp_positions", "LpWithdrawCompleted.rpc", rpc);
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
