import { PublicKey } from "@solana/web3.js";
import "server-only";
import { extractEventsFromLogs, type KaboomEvent,
  derivePlayerStatsPda,
  decodePlayerStats
} from "@playkaboom/sdk";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin } from "./db/supabase";
import { getConnection } from "./connection";
import { programId } from "./env";
import { logger } from "./logger";
import { awardPoints } from "./points";

// House edge that was live when this rev of the indexer shipped. Captured
// per-row in `points_ledger.edge_bps`, so historical points stay correct
// even if we change the on-chain edge later via update_vault. If we ever
// change the live edge, bump this constant in the same PR — or better,
// thread the actual edge through the event pipeline. For now both the
// program and this constant are 200.
const POINTS_EDGE_BPS = 200;

class IndexerApplyError extends Error {
  readonly pgCode?: string;
  constructor(message: string, pgCode?: string) {
    super(message);
    this.name = "IndexerApplyError";
    this.pgCode = pgCode;
  }
}

/** Throw on Postgrest errors so they surface in `ingestTransactions`'s catch
 * block (logged + counted) instead of being silently swallowed. The PG error
 * code is preserved on the thrown error so the outer loop can decide
 * whether a retry is meaningful (e.g. 23505 unique-violation will repeat
 * deterministically — keep the claim and skip future retries). */
function check(table: string, ev: string, res: { error: PostgrestError | null }): void {
  if (res.error) {
    throw new IndexerApplyError(
      `[${ev}→${table}] ${res.error.code ?? ""} ${res.error.message}`,
      res.error.code ?? undefined,
    );
  }
}

/** Postgres SQLSTATE codes that are deterministic on replay — retrying just
 * burns RPC quota and spams the log. When we hit one of these we KEEP the
 * processed_events claim so the cron skips the signature on future ticks. */
const TERMINAL_PG_CODES = new Set<string>([
  "23505", // unique_violation
  "23514", // check_violation
  "23502", // not_null_violation
  "23503", // foreign_key_violation
  "22003", // numeric_value_out_of_range
]);

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
  errorDetails: { sig: string; message: string }[];
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
/**
 * Write a settled VRF game into the mirror.
 *
 * WHY THIS EXISTS: `vrf_mode.rs` emits NO Anchor events — zero `emit!` calls in
 * the whole module. Every row in `public.games` is written by the GameWon /
 * GameLost branches below, which are driven by decoded event logs. So a VRF
 * game produces a perfectly good on-chain settle that the indexer cannot see:
 * indexFreshSignature runs, finds no recognised event, writes nothing, and the
 * activity feed silently stops at the last commit-reveal game. No amount of
 * cron tuning fixes that, because there was never an event to index.
 *
 * The durable fix is `emit!(GameWon/GameLost)` inside settle_vrf, which would
 * put VRF on the identical pipeline — but that is a program upgrade behind the
 * Squads authority. This keeps the mirror correct until then, writing the same
 * columns the event branches write so downstream readers cannot tell the
 * difference. Idempotent on `signature`, so a later event-driven re-index of
 * the same transaction is a no-op rather than a duplicate.
 */
export async function recordVrfGame(args: {
  signature: string;
  gamePda: string;
  player: string;
  betLamports: bigint;
  payoutLamports: bigint;
  multiplierBps: number;
  safeReveals: number;
  mineCount: number;
  won: boolean;
  slot: number;
  blockTime: string;
}): Promise<void> {
  const db = supabaseAdmin();
  const res = await db.from("games").upsert(
    {
      signature: args.signature,
      game: args.gamePda,
      player: args.player,
      bet: args.betLamports.toString(),
      // VRF knows its real mine_count at settle time, so unlike the event path
      // there is no sentinel to backfill.
      mine_count: args.mineCount,
      outcome: args.won ? "won" : "lost",
      payout: args.payoutLamports.toString(),
      multiplier_bps: args.won ? args.multiplierBps : 0,
      safe_reveals: args.safeReveals,
      // VRF has no pre-committed layout — randomness comes from the oracle per
      // click, so there is nothing to reveal or verify against.
      mine_layout: null,
      commitment: "0".repeat(64),
      settled_at: args.blockTime,
      slot: args.slot,
    },
    { onConflict: "signature" },
  );
  check("games", "recordVrfGame.upsert", res);

  // MIRROR PLAYER STATS TOO.
  //
  // Leaderboard and profile totals are driven by player_stats, which the event
  // path fills from a StatsUpdated event. VRF emits no events, so VRF games
  // updated `games` but never player_stats — leaderboard and profiles drifted
  // from chain, and a VRF-only player was absent entirely.
  //
  // settle_vrf DOES maintain the on-chain PlayerStats account (vrf_mode.rs:593),
  // so the cumulative truth exists; it just was never read. Pull that snapshot
  // and push it through the same slot-guarded RPC the event path uses, so a
  // late write can never revert newer counters. Non-fatal: a stats mirror
  // failure must not fail a settle that already moved money.
  try {
    const [statsPda] = derivePlayerStatsPda(programId(), new PublicKey(args.player));
    const info = await getConnection().getAccountInfo(statsPda, "confirmed");
    if (info) {
      const st = decodePlayerStats(info.data as Buffer);
      const rpc = await db.rpc("idx_apply_stats", {
        p_player: args.player,
        p_games_played: st.gamesPlayed.toString(),
        p_games_won: st.gamesWon.toString(),
        p_total_wagered: st.totalWagered.toString(),
        p_total_payouts: st.totalPayouts.toString(),
        p_biggest_win: st.biggestWin.toString(),
        p_current_streak: st.currentStreak,
        p_best_streak: st.bestStreak,
        p_last_played: args.blockTime,
        p_event_slot: args.slot,
      });
      check("player_stats", "recordVrfGame.stats", rpc);
    }
  } catch (e) {
    logger.error({ err: e, player: args.player }, "vrf player_stats mirror failed");
  }

  await awardPoints({
    player: args.player,
    sourceKey: args.signature,
    source: args.won ? "game_won" : "game_lost",
    betLamports: args.betLamports,
    edgeBps: POINTS_EDGE_BPS,
  });
}

export async function ingestTransactions(txs: IndexableTx[]): Promise<IndexResult> {
  const db = supabaseAdmin();
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const errorDetails: { sig: string; message: string }[] = [];

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
      // Apply events. On a TRANSIENT error, release the claim so the next
      // cron tick retries. On a TERMINAL error (deterministic Postgres
      // constraint violations — they will fail the same way forever),
      // KEEP the claim so we stop retrying and surface the failure once.
      try {
        for (const ev of events) {
          await applyEvent(ev, tx);
        }
      } catch (applyErr) {
        const pgCode =
          applyErr instanceof IndexerApplyError ? applyErr.pgCode : undefined;
        const isTerminal = pgCode !== undefined && TERMINAL_PG_CODES.has(pgCode);
        if (!isTerminal) {
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
        } else {
          logger.error(
            { sig: tx.signature, pgCode, err: (applyErr as Error).message },
            "[indexer] terminal PG constraint violation — keeping claim, will not retry",
          );
        }
        throw applyErr;
      }
      processed++;
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      // Cap to first 5 to keep response body bounded under burst conditions.
      if (errorDetails.length < 5) {
        errorDetails.push({ sig: tx.signature, message: message.slice(0, 300) });
      }
      logger.error({ err: message, sig: tx.signature }, "indexer apply error");
    }
  }
  return { processed, skipped, errors, errorDetails };
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
      // 2026-05-21: pass lamport totals as decimal strings (bigint) rather
      // than Number(). Postgres `bigint` accepts JSON strings and parses
      // them exactly; Number() silently rounds anything above 2^53
      // (~9007 SOL). At realistic mainnet usage `total_wagered` /
      // `total_payouts` cross 2^53 over the lifetime of a player.
      const rpc = await db.rpc("idx_apply_stats", {
        p_player: ev.player.toBase58(),
        p_games_played: ev.gamesPlayed.toString(),
        p_games_won: ev.gamesWon.toString(),
        p_total_wagered: ev.totalWagered.toString(),
        p_total_payouts: ev.totalPayouts.toString(),
        p_biggest_win: ev.biggestWin.toString(),
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
      //
      // 2026-05-11 part 2: the RPC now returns the affected-row count.
      // If 0, the cashout row hasn't been inserted yet (Helius delivered
      // events out of order). Throwing here trips the outer try/catch
      // which DELETEs the processed_events claim, so a future cron pass
      // re-tries this settle once the cashout row exists. Without this,
      // the settle was silently lost and the verifier showed PENDING
      // forever even though the chain settled correctly.
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
      const updated = (rpc.data as number | null) ?? 0;
      if (updated === 0) {
        // The cashout row doesn't exist yet — usually because the GameWon/
        // GameLost event in a SEPARATE earlier tx hasn't been ingested yet.
        // Retry is correct in that window. But if the settle event is more
        // than RETRY_WINDOW_MS old, the row will never appear (either it was
        // settled and is now a redelivery, or the win/loss row was lost),
        // and we'd retry every 60s forever. After the window, log + skip.
        const RETRY_WINDOW_MS = 5 * 60_000;
        const ageMs = tx.blockTime ? Date.now() - tx.blockTime * 1000 : 0;
        if (ageMs > RETRY_WINDOW_MS) {
          logger.warn(
            { sig: tx.signature, game, slot, ageSec: Math.round(ageMs / 1000) },
            "[GameSettled] no matching unsettled row + outside retry window — skipping",
          );
          break;
        }
        throw new Error(
          `[GameSettled] no matching unsettled cashout row found for game=${game} at slot<=${slot} — will retry (age=${Math.round(ageMs / 1000)}s)`,
        );
      }
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
          bet: ev.bet.toString(),
          mine_count: 0, // sentinel — filled in by GameSettled handler keyed on `game`
          outcome: "won",
          payout: ev.payout.toString(),
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
        betLamports: ev.bet,
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
          bet: ev.bet.toString(),
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
        betLamports: ev.bet,
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
          amount: ev.amount.toString(),
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
        p_amount: ev.amount.toString(),
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
        p_amount: ev.amount.toString(),
        p_event_slot: slot,
      });
      check("referrals", "ReferralClaimed.rpc", rpc);
      break;
    }
    // ─── Phase 2: LP vault events ─────────────────────────────────────────
    case "LpDeposited": {
      const userKey = ev.user.toBase58();
      const unitValue =
        ev.totalUnitsAfter > 0n ? (ev.vaultAssetsAfter * 10n ** 18n) / ev.totalUnitsAfter : 0n;
      await db.from("lp_actions").upsert(
        {
          signature: tx.signature,
          user_address: userKey,
          action: "deposit",
          units_delta: ev.unitsMinted.toString(),
          lamports_delta: ev.amountLamports.toString(),
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
        p_lamports_delta: ev.amountLamports.toString(),
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
        p_unlock_slot: ev.unlockSlot.toString(),
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
        ev.totalUnitsAfter > 0n ? (ev.vaultAssetsAfter * 10n ** 18n) / ev.totalUnitsAfter : 0n;
      await db.from("lp_actions").upsert(
        {
          signature: tx.signature,
          user_address: userKey,
          action: "complete_withdraw",
          units_delta: (-ev.unitsBurned).toString(),
          // Negative bigint as a JSON-stringified decimal — Postgres
          // bigint column parses signed strings exactly. Number() would
          // round on cumulative LP volumes >2^53.
          lamports_delta: (-ev.amountLamports).toString(),
          unit_value_lamports: unitValue.toString(),
          slot,
          block_time: blockTime,
        },
        { onConflict: "signature" },
      );
      const rpc = await db.rpc("idx_apply_lp_complete", {
        p_user_address: userKey,
        p_units_burned: ev.unitsBurned.toString(),
        p_lamports_out: ev.amountLamports.toString(),
        p_block_time: blockTime,
        p_event_slot: slot,
      });
      check("lp_positions", "LpWithdrawCompleted.rpc", rpc);
      break;
    }
    case "VaultUnitValueUpdated": {
      const unitValue =
        ev.totalUnits > 0n ? (ev.vaultAssets * 10n ** 18n) / ev.totalUnits : 0n;
      await db.from("vault_unit_value_history").upsert(
        {
          slot,
          // vault_assets at SOL-scale TVL exceeds 2^53 lamports (9007 SOL).
          // Always carry as a decimal string into the bigint column.
          vault_assets: ev.vaultAssets.toString(),
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
            ? ev.amountLamports.toString()
            : ev.kind === "HouseWithdrawCompleted"
              ? (-ev.amountLamports).toString()
              : "0";
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
