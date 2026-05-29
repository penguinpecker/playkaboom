/**
 * One-shot repair of the Supabase indexer mirror from on-chain truth.
 *
 * Fixes the drift documented 2026-05-30: the inline/cron indexer dropped
 * LP deposits + withdrawals (so lp_positions.cumulative_deposited/withdrawn
 * are wrong → bogus −100% P&L), double-counted referral accruals
 * (referrals rollup inflated 1.0–1.8× vs chain), and under-recorded winning
 * games (games table ~24% of on-chain payouts). The blockchain is correct;
 * this rewrites the mirror to match it.
 *
 *   # dry-run (prints every change, writes nothing) — DEFAULT
 *   npx tsx --env-file=apps/web/.env.local scripts/repair-vault-mirror.ts
 *
 *   # apply LP + referral repairs (cheap, ~handful of accounts)
 *   npx tsx --env-file=apps/web/.env.local scripts/repair-vault-mirror.ts --apply
 *
 *   # also backfill missing game rows (heavy: scans full program history)
 *   npx tsx --env-file=apps/web/.env.local scripts/repair-vault-mirror.ts --apply --games
 *
 * Reads go through the configured RPC (SOLANA_MAINNET_RPC / SOLANA_RPC).
 * Writes use SUPABASE_SERVICE_ROLE_KEY. Idempotent: re-running converges.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import {
  accountDiscriminator,
  decodeLpPosition,
  decodeReferralAccount,
  deriveLpPositionPda,
  extractEventsFromLogs,
} from "@playkaboom/sdk";

const APPLY = process.argv.includes("--apply");
const DO_GAMES = process.argv.includes("--games");

const RPC =
  process.env.SOLANA_MAINNET_RPC ??
  process.env.SOLANA_RPC ??
  "https://api.mainnet-beta.solana.com";
// Optional separate endpoint for signature/transaction reads. Defaults to RPC.
// (Lets a local run enumerate accounts on a full RPC while fetching txs through
// a non-rate-limited endpoint; in prod both are the same Alchemy URL.)
const TX_RPC = process.env.SOLANA_TX_RPC ?? RPC;
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh",
);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
}

const conn = new Connection(RPC, "confirmed"); // getProgramAccounts / getAccountInfo
const txConn = new Connection(TX_RPC, "confirmed"); // getSignaturesForAddress / getTransaction
const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (b: bigint | number) => (Number(b) / 1e9).toFixed(6);
const tag = APPLY ? "APPLY" : "DRY-RUN";

/** Walk every signature touching `addr`, oldest→newest, decoding events. */
async function* eventsFor(addr: PublicKey) {
  const sigs = await txConn.getSignaturesForAddress(addr, { limit: 1000 }, "confirmed");
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    await sleep(120);
    const tx = await txConn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) continue;
    const slot = tx.slot;
    const blockTime = new Date((tx.blockTime ?? 0) * 1000).toISOString();
    for (const ev of extractEventsFromLogs(tx.meta?.logMessages ?? [])) {
      yield { ev: ev as any, signature: s.signature, slot, blockTime };
    }
  }
}

// ── 1. LP positions: recompute cumulative_deposited/withdrawn + units ───────
async function repairLpPositions() {
  console.log(`\n[${tag}] === LP POSITIONS ===`);
  const disc = accountDiscriminator("LpPosition");
  const accs = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: disc.toString("base64"), encoding: "base64" } }],
  });
  for (const a of accs) {
    const pos = decodeLpPosition(a.account.data as Buffer);
    const user = pos.user.toBase58();
    const [pda] = deriveLpPositionPda(PROGRAM_ID, pos.user);
    let deposited = 0n;
    let withdrawn = 0n;
    let firstAt: string | null = null;
    let lastAt: string | null = null;
    let lastSlot = 0;
    for await (const { ev, slot, blockTime } of eventsFor(pda)) {
      if (ev.user?.toBase58?.() !== user) continue;
      if (ev.kind === "LpDeposited") deposited += ev.amountLamports;
      else if (ev.kind === "LpWithdrawCompleted") withdrawn += ev.amountLamports;
      else continue;
      firstAt ??= blockTime;
      lastAt = blockTime;
      if (slot > lastSlot) lastSlot = slot;
    }
    console.log(
      `  ${user}: deposited=${sol(deposited)} withdrawn=${sol(withdrawn)} ` +
        `net=${sol(deposited - withdrawn)} units(chain)=${pos.units} pending=${pos.pendingUnits}`,
    );
    if (APPLY) {
      const { error } = await db.from("lp_positions").upsert(
        {
          user_address: user,
          units: pos.units.toString(),
          pending_units: pos.pendingUnits.toString(),
          pending_unlock_slot: pos.pendingUnlockSlot.toString(),
          cumulative_deposited: deposited.toString(),
          cumulative_withdrawn: withdrawn.toString(),
          first_action_at: firstAt,
          last_action_at: lastAt,
          last_event_slot: lastSlot,
        },
        { onConflict: "user_address" },
      );
      if (error) console.error(`    write failed: ${error.message}`);
    }
  }
}

// ── 2. Referrals: mirror the on-chain ReferralAccount exactly ───────────────
async function repairReferrals() {
  console.log(`\n[${tag}] === REFERRALS ===`);
  const disc = accountDiscriminator("ReferralAccount");
  const accs = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: disc.toString("base64"), encoding: "base64" } }],
  });
  for (const a of accs) {
    const r = decodeReferralAccount(a.account.data as Buffer);
    const referrer = r.referrer.toBase58();
    console.log(
      `  ${referrer}: accrued=${sol(r.accruedLamports)} totalEarned=${sol(r.totalEarned)} ` +
        `tier=${r.tier} count=${r.referredCount} vol=${sol(r.referredVolume)}`,
    );
    if (APPLY) {
      const { error } = await db.from("referrals").upsert(
        {
          referrer,
          accrued_lamports: r.accruedLamports.toString(),
          total_earned: r.totalEarned.toString(),
          referred_count: r.referredCount,
          referred_volume: r.referredVolume.toString(),
          tier: r.tier,
        },
        { onConflict: "referrer" },
      );
      if (error) console.error(`    write failed: ${error.message}`);
    }
  }
}

// ── 3. Games: backfill missing won/lost rows from on-chain (opt-in) ─────────
async function repairGames() {
  console.log(`\n[${tag}] === GAMES (full program scan) ===`);
  let won = 0;
  let lost = 0;
  for await (const { ev, signature, slot, blockTime } of eventsFor(PROGRAM_ID)) {
    if (ev.kind !== "GameWon" && ev.kind !== "GameLost") continue;
    const isWon = ev.kind === "GameWon";
    const row = {
      signature,
      game: ev.game.toBase58(),
      player: ev.player.toBase58(),
      bet: ev.bet.toString(),
      mine_count: 0,
      outcome: isWon ? "won" : "lost",
      payout: isWon ? ev.payout.toString() : "0",
      multiplier_bps: isWon ? Number(ev.multiplierBps) : 0,
      safe_reveals: ev.safeReveals,
      mine_layout: null,
      commitment: "0".repeat(64),
      settled_at: blockTime,
      slot,
    };
    if (isWon) won++;
    else lost++;
    if (APPLY) {
      const { error } = await db
        .from("games")
        .upsert(row, { onConflict: "signature", ignoreDuplicates: true });
      if (error) console.error(`    ${signature.slice(0, 10)} write failed: ${error.message}`);
    }
  }
  console.log(`  scanned on-chain: won=${won} lost=${lost} (upsert ignores existing rows)`);
}

async function main() {
  console.log(`repair-vault-mirror [${tag}]  rpc=${RPC.replace(/(api-key=|\/v2\/)[^&/]+/, "$1<k>")}`);
  await repairLpPositions();
  await repairReferrals();
  if (DO_GAMES) await repairGames();
  else console.log(`\n(skip games backfill — pass --games to include it)`);
  console.log(`\nDone (${tag}).${APPLY ? "" : " No writes performed; re-run with --apply."}`);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
