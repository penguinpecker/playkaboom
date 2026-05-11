#!/usr/bin/env node
// Chain-only proof verifier — verifies a PlayKaboom signature against the
// chain ONLY (no Supabase, no DB). Read these checks as authoritative; if
// they pass and the public /verify/[sig] page disagrees, trust this CLI.
//
// What it verifies depends on which event the signature emits:
//
//   GameSettled event (settle_game / settle_game_er tx):
//     - popcount(mine_layout)            == mine_count                    [chain invariant]
//     - sha256(layout_le || mc || salt)  == commitment                    [chain invariant]
//     - emitted `verified` flag           == true                          [chain assertion]
//
//   GameWon / GameLost event (cash_out / reveal-on-mine tx):
//     - payout                            == bet × multiplier_bps / BPS   [internal arithmetic]
//
// What it CAN'T verify chain-only (requires archive RPC or knowing the game
// instance's start_slot):
//   - multiplier_bps == calcMultiplier(safe_reveals, mine_count, edge)
//     Reason: cashout doesn't emit mine_count, settle doesn't emit safe_reveals.
//     Cross-matching cashout→settle is unreliable when the GameSession PDA is
//     reused across rounds. For that check, use `check-invariants.mjs` against
//     the DB snapshot — that script trusts the indexer's per-row pairing.
//
// Usage:
//   node scripts/verify-sig.mjs <signature> [--rpc <url>]

import { createHash } from "node:crypto";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("usage: node scripts/verify-sig.mjs <signature> [--rpc <url>]");
  process.exit(2);
}
const sig = args[0];
const rpcIdx = args.indexOf("--rpc");
const RPC =
  rpcIdx >= 0 && args[rpcIdx + 1] ? args[rpcIdx + 1] : "https://api.mainnet-beta.solana.com";
const HOUSE_EDGE_BPS = 200n;
const BPS = 10000n;

function disc(name) {
  return createHash("sha256").update("event:" + name).digest().subarray(0, 8);
}
const DISC_GAME_WON = disc("GameWon");
const DISC_GAME_LOST = disc("GameLost");
const DISC_GAME_SETTLED = disc("GameSettled");

function b58encode(buf) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = n % 58n;
    out = A[Number(r)] + out;
    n = n / 58n;
  }
  let leading = 0;
  for (const b of buf) {
    if (b === 0) leading++;
    else break;
  }
  return "1".repeat(leading) + out;
}

async function rpc(method, params, attempt = 0) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) {
    if (
      attempt < 8 &&
      (j.error.code === 429 || j.error.code === -32005 || /too many/i.test(j.error.message ?? ""))
    ) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  }
  return j.result;
}

function extractEventBuffers(logs) {
  const out = [];
  for (const l of logs ?? []) {
    if (l.startsWith("Program data: ")) {
      out.push(Buffer.from(l.slice("Program data: ".length), "base64"));
    }
  }
  return out;
}

function findEvent(logs, wantedDisc) {
  for (const b of extractEventBuffers(logs)) {
    if (b.length >= 8 && b.subarray(0, 8).equals(wantedDisc)) return b;
  }
  return null;
}

function parseGameWon(buf) {
  let o = 8;
  const player = buf.subarray(o, o + 32);
  o += 32;
  const game = buf.subarray(o, o + 32);
  o += 32;
  const bet = buf.readBigUInt64LE(o);
  o += 8;
  const payout = buf.readBigUInt64LE(o);
  o += 8;
  const multiplier_bps = buf.readBigUInt64LE(o);
  o += 8;
  const safe_reveals = buf[o];
  o += 1;
  const slot = buf.readBigUInt64LE(o);
  return { player, game, bet, payout, multiplier_bps, safe_reveals, slot };
}

function parseGameLost(buf) {
  // GameLost layout from lib.rs: player(32) game(32) bet(u64) tile_index(u8)
  //                              safe_reveals(u8) slot(u64)
  let o = 8;
  const player = buf.subarray(o, o + 32);
  o += 32;
  const game = buf.subarray(o, o + 32);
  o += 32;
  const bet = buf.readBigUInt64LE(o);
  o += 8;
  const tile_index = buf[o];
  o += 1;
  const safe_reveals = buf[o];
  o += 1;
  const slot = buf.readBigUInt64LE(o);
  return { player, game, bet, tile_index, safe_reveals, slot };
}

function parseGameSettled(buf) {
  // GameSettled layout from programs/kaboom/src/lib.rs (note: salt before
  // commitment — not the order you might expect):
  //   player(32) game(32) mine_count(u8) mine_layout(u16) salt([u8;32])
  //   commitment([u8;32]) verified(bool) slot(u64)
  let o = 8;
  const player = buf.subarray(o, o + 32);
  o += 32;
  const game = buf.subarray(o, o + 32);
  o += 32;
  const mine_count = buf[o];
  o += 1;
  const mine_layout = buf.readUInt16LE(o);
  o += 2;
  const salt = buf.subarray(o, o + 32).toString("hex");
  o += 32;
  const commitment = buf.subarray(o, o + 32).toString("hex");
  o += 32;
  const verified = buf[o] === 1;
  o += 1;
  const slot = buf.readBigUInt64LE(o);
  return { player, game, mine_count, mine_layout, commitment, salt, verified, slot };
}

function popcount16(n) {
  let c = 0;
  for (let i = 0; i < 16; i++) if (n & (1 << i)) c++;
  return c;
}

function commitmentOf(layout, mineCount, saltHex) {
  const lo = layout & 0xff;
  const hi = (layout >> 8) & 0xff;
  const preimage = Buffer.concat([
    Buffer.from([lo, hi, mineCount]),
    Buffer.from(saltHex, "hex"),
  ]);
  return createHash("sha256").update(preimage).digest("hex");
}

const tx = await rpc("getTransaction", [
  sig,
  { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
]);
if (!tx) {
  console.error("ERROR: signature not found / not confirmed");
  process.exit(1);
}
const logs = tx.meta.logMessages;

let anyChecked = false;
let allOk = true;

const wonBuf = findEvent(logs, DISC_GAME_WON);
if (wonBuf) {
  anyChecked = true;
  const won = parseGameWon(wonBuf);
  console.log(`# GameWon event (slot ${won.slot})`);
  console.log(`  player        = ${b58encode(won.player)}`);
  console.log(`  game PDA      = ${b58encode(won.game)}`);
  console.log(`  bet           = ${won.bet} lamports`);
  console.log(`  payout        = ${won.payout} lamports`);
  console.log(`  multiplier_bps= ${won.multiplier_bps}`);
  console.log(`  safe_reveals  = ${won.safe_reveals}`);
  const expectedPayout = (won.bet * won.multiplier_bps) / BPS;
  const payoutOk = BigInt(won.payout) === expectedPayout;
  console.log(
    `  ${payoutOk ? "✓" : "✗"} payout == bet × multiplier_bps / 10000  (chain=${won.payout}, expected=${expectedPayout})`,
  );
  if (!payoutOk) allOk = false;
}

const lostBuf = findEvent(logs, DISC_GAME_LOST);
if (lostBuf) {
  anyChecked = true;
  const lost = parseGameLost(lostBuf);
  console.log(`\n# GameLost event (slot ${lost.slot})`);
  console.log(`  player        = ${b58encode(lost.player)}`);
  console.log(`  game PDA      = ${b58encode(lost.game)}`);
  console.log(`  bet           = ${lost.bet} lamports`);
  console.log(`  tile_index    = ${lost.tile_index}`);
  console.log(`  safe_reveals  = ${lost.safe_reveals}`);
  console.log(`  (no on-chain arithmetic to verify; payout was 0)`);
}

const setBuf = findEvent(logs, DISC_GAME_SETTLED);
if (setBuf) {
  anyChecked = true;
  const set = parseGameSettled(setBuf);
  console.log(`\n# GameSettled event (slot ${set.slot})`);
  console.log(`  player        = ${b58encode(set.player)}`);
  console.log(`  game PDA      = ${b58encode(set.game)}`);
  console.log(`  mine_count    = ${set.mine_count}`);
  console.log(`  mine_layout   = 0x${set.mine_layout.toString(16).padStart(4, "0")}`);
  console.log(`  commitment    = ${set.commitment}`);
  console.log(`  salt          = ${set.salt}`);
  console.log(`  on-chain verified flag = ${set.verified}`);

  const pop = popcount16(set.mine_layout);
  const popOk = pop === set.mine_count;
  console.log(
    `  ${popOk ? "✓" : "✗"} popcount(mine_layout) == mine_count  (${pop} vs ${set.mine_count})`,
  );
  if (!popOk) allOk = false;

  const computedCommit = commitmentOf(set.mine_layout, set.mine_count, set.salt);
  const commitOk = computedCommit === set.commitment;
  console.log(
    `  ${commitOk ? "✓" : "✗"} sha256(layout_le || mine_count || salt) == commitment`,
  );
  if (!commitOk) {
    console.log(`        chain    = ${set.commitment}`);
    console.log(`        computed = ${computedCommit}`);
    allOk = false;
  }

  const verifiedOk = set.verified === true;
  console.log(`  ${verifiedOk ? "✓" : "✗"} on-chain verified flag is true`);
  if (!verifiedOk) allOk = false;
}

if (!anyChecked) {
  console.error("ERROR: signature contains no GameWon, GameLost, or GameSettled event");
  process.exit(1);
}

console.log("\n# What this CLI does NOT verify:");
console.log("  - multiplier_bps vs calcMultiplier(safe_reveals, mine_count, edge):");
console.log("    Requires safe_reveals (in GameWon) + mine_count (in GameSettled), which");
console.log("    are emitted by different transactions. Cross-matching is unsafe when the");
console.log("    GameSession PDA is reused. For that invariant, run check-invariants.mjs");
console.log("    against the DB snapshot.");

if (!allOk) {
  console.error("\nFAIL — at least one chain-internal invariant broken");
  process.exit(1);
}
console.log("\nPASS — all chain-internal invariants for events in this tx hold");
