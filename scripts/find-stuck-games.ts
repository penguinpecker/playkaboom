/**
 * Scan all program accounts for the kaboom program, decode any GameSessions,
 * print their state. Useful for diagnosing "Active game exists" 409s.
 *
 *   PROGRAM_ID=4rPEGz... npx tsx --env-file=apps/web/.env.local \
 *     scripts/find-stuck-games.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeGameSession } from "@playkaboom/sdk";

async function main() {
  const programId = new PublicKey(process.env.PROGRAM_ID!);
  const conn = new Connection(process.env.SOLANA_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const accounts = await conn.getProgramAccounts(programId, { commitment: "confirmed" });
  console.log("scanned", accounts.length, "program accounts");
  const slot = await conn.getSlot("confirmed");
  console.log("current slot:", slot, "\n");

  let n = 0;
  for (const { pubkey, account } of accounts) {
    try {
      const g = decodeGameSession(account.data);
      n++;
      const slotsAhead = Number(g.startSlot) + 300 - slot;
      const ageSec = (slot - Number(g.startSlot)) * 0.4;
      console.log("─── GameSession", pubkey.toBase58(), "───");
      console.log("  player    :", g.player.toBase58());
      console.log("  status    :", g.status);
      console.log(
        "  bet       :",
        g.bet.toString(),
        `(${(Number(g.bet) / 1e9).toFixed(4)} SOL)`,
      );
      console.log("  mineCount :", g.mineCount);
      console.log("  reveals   :", g.safeReveals, "(mask=", g.revealedSafeMask, ")");
      console.log("  multiplier:", `${(Number(g.multiplierBps) / 10000).toFixed(2)}x`);
      console.log("  age       :", ageSec.toFixed(0) + "s");
      console.log("  settled   :", g.settled);
      console.log(
        "  refundable:",
        slotsAhead <= 0 ? "YES (refund_expired works now)" : `in ${Math.ceil(slotsAhead * 0.4)}s`,
      );
      console.log();
    } catch {
      /* not a GameSession */
    }
  }
  if (n === 0) console.log("no active GameSessions on-chain.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
