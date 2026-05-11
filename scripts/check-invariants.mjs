#!/usr/bin/env node
// PlayKaboom indexer invariant check.
//
// Pulls every settled game row from the live indexer and asserts:
//   1. multiplier_bps == calcMultiplier(safe_reveals, mine_count, house_edge_bps)
//   2. For rows with mine_layout set: popcount(mine_layout) == mine_count
//   3. For rows with salt + commitment set:
//        sha256(layout_le || mine_count || salt) == commitment
//
// Exits with code 0 if all invariants hold, code 1 otherwise. Designed to
// run as a nightly cron — pages on any drift between chain math and DB cache.
//
// Env:
//   SUPABASE_URL                       (required)
//   SUPABASE_ANON_KEY                  (required, anon-readable on `games`)
//   HOUSE_EDGE_BPS                     (default 200)
//   ALLOWED_MISMATCH_SIGNATURES_PATH   (optional path to a newline list of sigs
//                                       that are KNOWN to be DB-corrupted from
//                                       the 2026-05-11 GameSettled race, kept
//                                       as-is per the team's "for record" call)
//
// Usage:
//   node scripts/check-invariants.mjs
//   node scripts/check-invariants.mjs --verbose

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const HOUSE_EDGE_BPS = BigInt(process.env.HOUSE_EDGE_BPS ?? "200");
const VERBOSE = process.argv.includes("--verbose");

if (!SUPABASE_URL || !ANON) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON_KEY are required");
  process.exit(2);
}

const BPS = 10000n;
const GRID = 16n;

function calcMultiplier(safeReveals, mineCount) {
  if (safeReveals === 0) return Number(BPS);
  if (BigInt(mineCount) + BigInt(safeReveals) > GRID) return null;
  let num = 1n;
  let den = 1n;
  for (let i = 0n; i < BigInt(safeReveals); i++) {
    const tiles = GRID - i;
    const safe = GRID - BigInt(mineCount) - i;
    if (safe <= 0n) return null;
    num *= tiles;
    den *= safe;
  }
  const raw = (num * BPS) / den;
  const final = (raw * (BPS - HOUSE_EDGE_BPS)) / BPS;
  return Number(final);
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

async function fetchAll() {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/games?select=signature,player,bet,mine_count,outcome,multiplier_bps,safe_reveals,mine_layout,settled_layout,commitment,salt&order=settled_at.desc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    });
    if (!res.ok) {
      throw new Error(`Supabase REST ${res.status}: ${await res.text()}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error("bad response: " + JSON.stringify(batch));
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

const allowedSet = new Set();
if (process.env.ALLOWED_MISMATCH_SIGNATURES_PATH) {
  const p = process.env.ALLOWED_MISMATCH_SIGNATURES_PATH;
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (s && !s.startsWith("#")) allowedSet.add(s);
    }
  }
}

const rows = await fetchAll();
let checked = 0;
let multBad = 0;
let popBad = 0;
let commitBad = 0;
const failures = [];

for (const r of rows) {
  if (r.outcome === "won") {
    checked++;
    // Invariant 1: chain math matches DB-stored multiplier.
    const expected = calcMultiplier(r.safe_reveals, r.mine_count);
    if (expected !== r.multiplier_bps) {
      if (!allowedSet.has(r.signature)) {
        multBad++;
        failures.push({
          kind: "MULT",
          sig: r.signature,
          have: r.multiplier_bps,
          expected,
          safe_reveals: r.safe_reveals,
          mine_count: r.mine_count,
        });
      }
    }
  }
  // Invariant 2: layout popcount matches mine_count.
  if (r.mine_layout !== null && r.mine_layout !== undefined) {
    const pop = popcount16(r.mine_layout);
    if (pop !== r.mine_count && !allowedSet.has(r.signature)) {
      popBad++;
      failures.push({
        kind: "POP",
        sig: r.signature,
        layout: r.mine_layout,
        pop,
        mine_count: r.mine_count,
      });
    }
  }
  // Invariant 3: SHA-256 commitment matches.
  if (
    r.mine_layout !== null &&
    r.salt &&
    r.commitment &&
    r.commitment !== "0".repeat(64)
  ) {
    const computed = commitmentOf(r.mine_layout, r.mine_count, r.salt);
    if (computed !== r.commitment && !allowedSet.has(r.signature)) {
      commitBad++;
      failures.push({
        kind: "COMMIT",
        sig: r.signature,
        have: r.commitment,
        computed,
      });
    }
  }
}

console.log(`# rows scanned: ${rows.length}`);
console.log(`# won rows checked for multiplier: ${checked}`);
console.log(`# allowed (legacy 2026-05-11 corruption): ${allowedSet.size}`);
console.log(`# multiplier mismatches: ${multBad}`);
console.log(`# popcount mismatches:   ${popBad}`);
console.log(`# commitment mismatches: ${commitBad}`);

if (VERBOSE || failures.length > 0) {
  for (const f of failures.slice(0, 50)) {
    console.log(JSON.stringify(f));
  }
  if (failures.length > 50) console.log(`# … and ${failures.length - 50} more`);
}

if (multBad + popBad + commitBad > 0) {
  console.error(`\nFAIL: ${multBad + popBad + commitBad} invariant violations`);
  process.exit(1);
}
console.log("\nPASS");
