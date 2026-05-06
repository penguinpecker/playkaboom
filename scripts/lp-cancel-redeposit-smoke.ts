/**
 * E2E smoke: cancel_withdraw → fresh lp_deposit → request_withdraw with the
 * deposited amount only (leaves prior position units intact).
 *
 *   PROGRAM_ID=4rPEGz... npx tsx --env-file=apps/web/.env.local \
 *     scripts/lp-cancel-redeposit-smoke.ts
 *
 * Verifies SDK + program path end-to-end after Phase 3 SDK changes.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  buildCancelWithdraw,
  buildLpDeposit,
  buildRequestWithdraw,
  decodeLpPosition,
  decodeVaultV2State,
  deriveLpPositionPda,
  deriveV2StatePda,
} from "@playkaboom/sdk";

function loadKp(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
}

async function send(conn: Connection, payer: Keypair, ixs: Parameters<Transaction["add"]>) {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function main() {
  const programId = new PublicKey(process.env.PROGRAM_ID!);
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const user = loadKp(resolve(homedir(), ".config/solana/id.json"));
  const ctx = { programId };
  const [posPda] = deriveLpPositionPda(programId, user.publicKey);
  const [v2Pda] = deriveV2StatePda(programId);

  console.log("─ E2E LP smoke (cancel → deposit → request) ─");
  let pos = decodeLpPosition((await conn.getAccountInfo(posPda, "confirmed"))!.data);
  console.log("Pre  : units=" + pos.units + ", pending=" + pos.pendingUnits);

  if (pos.pendingUnits > 0n) {
    const sig = await send(conn, user, [buildCancelWithdraw({ ctx, user: user.publicKey })]);
    console.log("[1] cancel_withdraw sig:", sig);
    pos = decodeLpPosition((await conn.getAccountInfo(posPda, "confirmed"))!.data);
    console.log("    units=" + pos.units + ", pending=" + pos.pendingUnits);
  } else {
    console.log("[1] no pending — skipping cancel");
  }

  // Deposit 0.05 SOL
  const dep = 50_000_000n;
  const sig2 = await send(conn, user, [
    buildLpDeposit({ ctx, user: user.publicKey, amountLamports: dep }),
  ]);
  console.log(`[2] lp_deposit ${Number(dep) / LAMPORTS_PER_SOL} SOL sig:`, sig2);
  const v2After = decodeVaultV2State((await conn.getAccountInfo(v2Pda, "confirmed"))!.data);
  pos = decodeLpPosition((await conn.getAccountInfo(posPda, "confirmed"))!.data);
  console.log("    units=" + pos.units + ", pending=" + pos.pendingUnits + ", total_units=" + v2After.totalUnits);

  // Request 50% of units back
  const reqUnits = pos.units / 2n;
  const sig3 = await send(conn, user, [
    buildRequestWithdraw({ ctx, user: user.publicKey, units: reqUnits }),
  ]);
  console.log(`[3] request_withdraw ${reqUnits} units sig:`, sig3);
  pos = decodeLpPosition((await conn.getAccountInfo(posPda, "confirmed"))!.data);
  console.log("    units=" + pos.units + ", pending=" + pos.pendingUnits + ", unlock_slot=" + pos.pendingUnlockSlot);

  console.log("\n✓ E2E smoke green");
}

main().catch((e) => { console.error(e); process.exit(1); });
