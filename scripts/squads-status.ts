/**
 * Read-only inspection of the Squads multisig backing PlayKaboom's
 * owner / treasury / upgrade authority. Run any time to see:
 *   - members and threshold
 *   - per-member voting power
 *   - latest transactionIndex (last vault tx slot used)
 *   - last N vault transactions with their proposal status + approvals
 *
 * Run:
 *   npx tsx scripts/squads-status.ts
 *
 * Read-only — no signatures required. Safe to run on prod.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

async function main() {
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const squads = JSON.parse(
    readFileSync(resolve(process.cwd(), "keypairs/squads-devnet.json"), "utf8"),
  ) as { vaultPda: string; multisigPda: string };
  const multisigPda = new PublicKey(squads.multisigPda);
  const vaultPda = new PublicKey(squads.vaultPda);

  console.log("─ Squads multisig status ─");
  console.log("  RPC          :", rpc);
  console.log("  multisigPda  :", multisigPda.toBase58());
  console.log("  vaultPda     :", vaultPda.toBase58());
  console.log();

  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);

  console.log("Threshold     :", ms.threshold, "/", ms.members.length);
  console.log("Time-lock     :", ms.timeLock, "seconds");
  console.log("Tx index head :", ms.transactionIndex.toString());
  console.log("Stale index   :", ms.staleTransactionIndex.toString(), "(approvals before this index don't carry forward after threshold/member changes)");
  console.log();
  console.log("Members:");
  for (const m of ms.members) {
    // mask is a bitset: bit 0 = Propose, bit 1 = Vote, bit 2 = Execute.
    const mask = m.permissions.mask;
    const flags = [
      mask & 1 ? "Propose" : null,
      mask & 2 ? "Vote" : null,
      mask & 4 ? "Execute" : null,
    ].filter(Boolean).join(" / ");
    console.log(`  ${m.key.toBase58()}  →  ${flags}`);
  }

  // Last few vault transactions
  const head = BigInt(ms.transactionIndex.toString());
  const SHOW = 5n;
  const start = head > SHOW ? head - SHOW + 1n : 1n;
  if (head === 0n) {
    console.log("\nNo vault transactions yet.");
    return;
  }
  console.log(`\nLast ${head < SHOW ? head : SHOW} vault transactions:`);
  for (let i = start; i <= head; i++) {
    const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: i });
    const [vaultTxPda] = multisig.getTransactionPda({ multisigPda, index: i });
    let status = "n/a";
    let approvals = 0;
    let rejections = 0;
    try {
      const proposal = await multisig.accounts.Proposal.fromAccountAddress(conn, proposalPda);
      // Status enum: Draft=0, Active=1, Approved=2, Rejected=3, Cancelled=4, Executed=5
      const statusName = ((s: unknown): string => {
        if (typeof s === "object" && s !== null) {
          return Object.keys(s)[0] ?? String(s);
        }
        return String(s);
      })(proposal.status);
      status = statusName;
      approvals = proposal.approved.length;
      rejections = proposal.rejected.length;
    } catch {
      status = "no proposal";
    }
    let memo = "";
    try {
      const txAcct = await multisig.accounts.VaultTransaction.fromAccountAddress(
        conn,
        vaultTxPda,
      );
      void txAcct;
    } catch {
      /* no vault tx */
    }
    console.log(
      `  #${i.toString().padStart(3)} status=${status.padEnd(10)} approvals=${approvals} rejections=${rejections}` +
        (memo ? `  memo=${memo}` : ""),
    );
  }

  console.log("\nSquads UI (paste in browser):");
  console.log(`  https://devnet.squads.so/squad/${multisigPda.toBase58()}`);
}

main().catch((err) => {
  console.error("squads-status failed:", err);
  process.exit(1);
});
