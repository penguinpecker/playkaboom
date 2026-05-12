import { Connection, PublicKey } from "@solana/web3.js";
import { decodePlayerStats } from "@playkaboom/sdk";

const PROGRAM_ID = new PublicKey("9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh");
const PLAYER_STATS_SIZE = 203;

async function main() {
  const target = new PublicKey(process.argv[2] ?? "3aCVhAHwZ6FfJn1UR7CzeuPUXxYbsyiJ193UvDRweg4N");
  const rpc = process.env.SOLANA_RPC;
  if (!rpc) throw new Error("SOLANA_RPC not set");
  const conn = new Connection(rpc, "confirmed");

  console.log("scanning PlayerStats with referrer ==", target.toBase58());

  // memcmp at offset 107 (Option<Pubkey> data byte starts here; tag is at 106).
  // Use combined filter for efficiency on Alchemy.
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: PLAYER_STATS_SIZE },
      { memcmp: { offset: 107, bytes: target.toBase58() } },
    ],
    commitment: "confirmed",
  });

  console.log("candidate accounts:", accounts.length);
  const referred: { player: string; gamesPlayed: string; totalWagered: bigint; lastPlayed: number }[] = [];
  for (const a of accounts) {
    let s;
    try { s = decodePlayerStats(a.account.data); } catch { continue; }
    if (!s.referrer || !s.referrer.equals(target)) continue;
    referred.push({
      player: s.player.toBase58(),
      gamesPlayed: s.gamesPlayed.toString(),
      totalWagered: s.totalWagered,
      lastPlayed: Number(s.lastPlayed),
    });
  }
  referred.sort((a, b) => Number(b.totalWagered - a.totalWagered));
  console.log("confirmed referrals:", referred.length);
  console.log();
  console.log("address                                       gamesPlayed   totalWagered(SOL)   lastPlayed");
  for (const r of referred) {
    const sol = (Number(r.totalWagered) / 1e9).toFixed(6);
    const when = r.lastPlayed > 0 ? new Date(r.lastPlayed * 1000).toISOString() : "never";
    console.log(`${r.player.padEnd(46)} ${r.gamesPlayed.padStart(11)} ${sol.padStart(18)}   ${when}`);
  }
  const totalSol = referred.reduce((s, r) => s + r.totalWagered, 0n);
  console.log();
  console.log("total referred wagered:", (Number(totalSol) / 1e9).toFixed(6), "SOL across", referred.length, "wallets");
}

main().catch((e) => { console.error(e); process.exit(1); });
