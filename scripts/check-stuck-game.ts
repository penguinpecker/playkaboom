import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { decodeGameSession } from "@playkaboom/sdk";

async function main() {
  const rpc = process.env.SOLANA_RPC!;
  const conn = new Connection(rpc, "confirmed");
  const gamePda = new PublicKey("FjBED4g2VsNMK16cWDGZy337YsEykPn4pE3QY85ViCsX");
  const player = new PublicKey("GXNjvVbDFGtkFEqW6RCW5DYHhqj8GLRCRxBNsvFtw6iC");

  const info = await conn.getAccountInfo(gamePda, "confirmed");
  if (!info) {
    console.log("GameSession account: CLOSED (player already ran close_game and reclaimed rent)");
  } else {
    const g = decodeGameSession(info.data);
    console.log("GameSession still open:");
    console.log("  status         :", g.status);
    console.log("  settled        :", g.settled);
    console.log("  bet            :", (Number(g.bet) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
    console.log("  multiplier_bps :", g.multiplierBps);
    console.log("  payout (bet*mult/bps):",
      ((Number(g.bet) * Number(g.multiplierBps)) / 10000 / LAMPORTS_PER_SOL).toFixed(6), "SOL");
    console.log("  max_payout     :", (Number(g.maxPayout) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
    console.log("  safe_reveals   :", g.safeReveals);
  }

  const sigs = await conn.getSignaturesForAddress(gamePda, { limit: 20 }, "confirmed");
  console.log("\nGameSession tx history (most recent first):");
  for (const s of sigs) {
    console.log(`  ${s.signature.slice(0, 32)}…  slot=${s.slot}  ${s.blockTime ? new Date(s.blockTime * 1000).toISOString() : "?"}  err=${s.err ? "X" : "ok"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
