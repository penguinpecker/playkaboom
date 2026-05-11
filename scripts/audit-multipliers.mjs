#!/usr/bin/env node
// Audit: for every settled game in the indexer, recompute expected multiplier_bps
// using on-chain formula (calc_multiplier in programs/kaboom/src/lib.rs:1476)
// and flag rows where stored multiplier_bps disagrees. Also infer the actual
// mine_count from multiplier_bps and compare to stored mine_count.

const SUPABASE_URL = "https://vrxeqgynejlnmwsifvml.supabase.co";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyeGVxZ3luZWpsbm13c2lmdm1sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NjAwNjcsImV4cCI6MjA5MzUzNjA2N30.caEjwDHj3XT9OR_N63bv31RBK7eGnVWomD5PKgn9qWI";
const BPS = 10000n;
const GRID = 16n;
const HOUSE_EDGE_BPS = 200n; // confirmed from vault PDA decode

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

function inferMineCount(safeReveals, multiplierBps) {
  for (let m = 0; m <= 15; m++) {
    if (calcMultiplier(safeReveals, m) === multiplierBps) return m;
  }
  return null;
}

async function fetchAll() {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/games?select=signature,player,bet,mine_count,outcome,payout,multiplier_bps,safe_reveals,mine_layout,settled_layout,commitment,salt,settled_at&order=settled_at.desc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    });
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error("bad response: " + JSON.stringify(batch));
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

(async () => {
  const rows = await fetchAll();
  console.log(`# Total settled-game rows: ${rows.length}`);

  let won = 0,
    lost = 0,
    expired = 0;
  let multMismatches = 0;
  let mineCountMismatches = 0;
  let layoutMineCountMismatches = 0;
  const corruptedRows = [];
  const totals = { totalBet: 0n, totalPayout: 0n };
  const perPlayerOverpay = new Map();

  for (const r of rows) {
    if (r.outcome === "won") won++;
    else if (r.outcome === "lost") lost++;
    else expired++;
    totals.totalBet += BigInt(r.bet);
    totals.totalPayout += BigInt(r.payout);

    if (r.outcome !== "won") continue; // lost/expired have multiplier_bps=0

    const expected = calcMultiplier(r.safe_reveals, r.mine_count);
    const actualMineCount = inferMineCount(r.safe_reveals, r.multiplier_bps);

    if (r.multiplier_bps !== expected) {
      multMismatches++;
    }

    if (actualMineCount !== null && actualMineCount !== r.mine_count) {
      mineCountMismatches++;
      const fairPayout =
        (BigInt(r.bet) * BigInt(calcMultiplier(r.safe_reveals, r.mine_count) ?? 0)) / BPS;
      const overpay = BigInt(r.payout) - fairPayout;
      const prev = perPlayerOverpay.get(r.player) ?? 0n;
      perPlayerOverpay.set(r.player, prev + overpay);
      corruptedRows.push({
        sig: r.signature,
        player: r.player,
        bet: r.bet,
        payout: r.payout,
        safe_reveals: r.safe_reveals,
        stored_mine_count: r.mine_count,
        inferred_mine_count: actualMineCount,
        stored_multiplier_bps: r.multiplier_bps,
        expected_for_stored_mine_count: expected,
        fair_payout_if_stored_mine_count_correct: Number(fairPayout),
        overpay_if_indexer_correct: Number(overpay),
        mine_layout: r.mine_layout,
        layout_count_ones:
          r.mine_layout === null
            ? null
            : r.mine_layout.toString(2).split("").filter((c) => c === "1").length,
      });
    }

    if (
      r.mine_layout !== null &&
      r.mine_count !== null &&
      r.mine_layout
        .toString(2)
        .split("")
        .filter((c) => c === "1").length !== r.mine_count
    ) {
      layoutMineCountMismatches++;
    }
  }

  console.log(`\n# Outcome counts: won=${won} lost=${lost} expired=${expired}`);
  console.log(
    `# Total wagered: ${(Number(totals.totalBet) / 1e9).toFixed(4)} SOL`,
  );
  console.log(
    `# Total paid:    ${(Number(totals.totalPayout) / 1e9).toFixed(4)} SOL`,
  );
  console.log(
    `# Net house:     ${((Number(totals.totalBet) - Number(totals.totalPayout)) / 1e9).toFixed(4)} SOL`,
  );
  console.log(
    `\n# Mismatch counts (won-rows only):\n  multiplier_bps != calc_multiplier(stored_mine_count): ${multMismatches}\n  inferred_mine_count != stored_mine_count: ${mineCountMismatches}\n  popcount(mine_layout) != mine_count: ${layoutMineCountMismatches}`,
  );

  if (corruptedRows.length > 0) {
    console.log(`\n# First 20 rows where DB mine_count disagrees with chain multiplier:`);
    for (const r of corruptedRows.slice(0, 20)) {
      console.log(
        `  ${r.sig.slice(0, 16)}…  player=${r.player.slice(0, 8)}…  bet=${(r.bet / 1e9).toFixed(4)}  payout=${(r.payout / 1e9).toFixed(4)}  safe=${r.safe_reveals}  db_mc=${r.stored_mine_count}  chain_mc=${r.inferred_mine_count}  layout_pop=${r.layout_count_ones}  m_bps=${r.stored_multiplier_bps}`,
      );
    }

    console.log(`\n# Per-player overpay IF stored mine_count were authoritative:`);
    const sorted = [...perPlayerOverpay.entries()].sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [p, o] of sorted.slice(0, 10)) {
      console.log(`  ${p}  ${(Number(o) / 1e9).toFixed(4)} SOL`);
    }
  }
})();
