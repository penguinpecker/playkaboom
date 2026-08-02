import { Connection, PublicKey } from "@solana/web3.js";
import { decodeGameSession } from "@playkaboom/sdk";

// Proxy blocks getProgramAccounts. Use public Solana RPC for this enumeration.
const RPC = "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey("9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh");

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const slot = await conn.getSlot("confirmed");
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 180 }],
    commitment: "confirmed",
  });

  console.log(`scanned ${accounts.length} GameSession PDAs at slot ${slot}\n`);

  const buckets: Record<string, any[]> = { Playing: [], Won: [], Lost: [], Expired: [] };
  for (const a of accounts) {
    try {
      const g = decodeGameSession(a.account.data);
      const ageSlots = slot - Number(g.startSlot);
      const ageSec = Math.round(ageSlots * 0.4);
      buckets[g.status]?.push({
        pda: a.pubkey.toBase58(),
        player: g.player.toBase58(),
        status: g.status,
        settled: g.settled,
        bet_sol: Number(g.bet) / 1e9,
        maxPayout_sol: Number(g.maxPayout) / 1e9,
        ageSec,
        startSlot: Number(g.startSlot),
      });
    } catch {}
  }

  let totalLocked = 0n;
  for (const [status, rows] of Object.entries(buckets)) {
    if (!rows.length) continue;
    const sum = rows.reduce((s: number, r: any) => s + r.maxPayout_sol, 0);
    totalLocked += BigInt(Math.round(sum * 1e9));
    console.log(`=== ${status} (${rows.length} games, ${sum.toFixed(3)} SOL locked) ===`);
    rows.sort((a: any, b: any) => b.maxPayout_sol - a.maxPayout_sol);
    for (const r of rows) {
      const settledFlag = r.settled ? "settled" : "!settled";
      const m = Math.floor(r.ageSec / 60);
      const s = r.ageSec % 60;
      console.log(
        `  player ${r.player}  bet=${r.bet_sol.toFixed(3)} maxPay=${r.maxPayout_sol.toFixed(3)}  ${settledFlag}  age=${m}m${s}s  startSlot=${r.startSlot}`,
      );
    }
    console.log();
  }
  console.log(`TOTAL on-chain obligation locked: ${(Number(totalLocked) / 1e9).toFixed(3)} SOL`);
}

void main();
