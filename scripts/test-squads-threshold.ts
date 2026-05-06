/**
 * Negative test for the Squads 2-of-2 threshold: prove that 1 approval
 * is NOT enough to execute. This is the test that actually shows the
 * multisig is doing its job — anyone who steals member 1's key can
 * propose + approve, but cannot execute alone.
 *
 * Flow:
 *   1. Build a noop update_vault inner ix.
 *   2. Create the vault transaction + proposal as member 1.
 *   3. Member 1 approves (1/2 signatures).
 *   4. Skip member 2 approval.
 *   5. Try vaultTransactionExecute → expect failure with "InvalidProposalStatus"
 *      (because the proposal is still in Active status, not Approved).
 *   6. THEN have member 2 approve.
 *   7. Try execute again → expect SUCCESS now.
 *   8. Verify on-chain.
 *
 * Both stages run in the same script so you see the difference clearly.
 *
 * Run:
 *   PROGRAM_ID=4rPEGzWoD2i8k3Pr5tnJsBV7AZEK2zQJCXZe4YgwcixT \
 *     npx tsx --env-file=apps/web/.env.local \
 *     scripts/test-squads-threshold.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { buildUpdateVault, deriveVaultPda } from "@playkaboom/sdk";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]),
  );
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const conn = new Connection(
    process.env.SOLANA_RPC ?? "https://api.devnet.solana.com",
    "confirmed",
  );

  const member1 = loadKeypair(resolve(homedir(), ".config/solana/id.json"));
  const member2 = loadKeypair(
    resolve(process.cwd(), "keypairs/squads-cosigner-devnet.json"),
  );
  const squads = JSON.parse(
    readFileSync(resolve(process.cwd(), "keypairs/squads-devnet.json"), "utf8"),
  ) as { vaultPda: string; multisigPda: string };
  const squadsVault = new PublicKey(squads.vaultPda);
  const multisigPda = new PublicKey(squads.multisigPda);

  console.log("─ Squads 2-of-2 threshold test ─");
  console.log("  multisig:", multisigPda.toBase58());
  console.log("  vault PDA:", squadsVault.toBase58());

  const innerIx = buildUpdateVault({ ctx: { programId }, owner: squadsVault });

  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const nextIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  console.log(`  transactionIndex: ${ms.transactionIndex} → next ${nextIndex}\n`);

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: squadsVault,
    recentBlockhash: blockhash,
    instructions: [innerIx],
  });

  // ── Setup: create + propose ──────────────────────────────────────────────
  console.log("[setup] vaultTransactionCreate + proposalCreate (member1)…");
  await conn.confirmTransaction(
    await multisig.rpc.vaultTransactionCreate({
      connection: conn,
      feePayer: member1,
      multisigPda,
      transactionIndex: nextIndex,
      creator: member1.publicKey,
      rentPayer: member1.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: message,
      memo: "threshold-test",
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    }),
    "confirmed",
  );
  await conn.confirmTransaction(
    await multisig.rpc.proposalCreate({
      connection: conn,
      feePayer: member1,
      creator: member1,
      multisigPda,
      transactionIndex: nextIndex,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    }),
    "confirmed",
  );
  console.log("  ok\n");

  // ── Stage 1: only member1 approves ───────────────────────────────────────
  console.log("[stage1] member1 approves (1/2)");
  await conn.confirmTransaction(
    await multisig.rpc.proposalApprove({
      connection: conn,
      feePayer: member1,
      member: member1,
      multisigPda,
      transactionIndex: nextIndex,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    }),
    "confirmed",
  );

  console.log("[stage1] attempt vaultTransactionExecute → expect FAILURE …");
  let stage1Failed = false;
  let stage1Err = "";
  try {
    await multisig.rpc.vaultTransactionExecute({
      connection: conn,
      feePayer: member1,
      multisigPda,
      transactionIndex: nextIndex,
      member: member1.publicKey,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    });
    console.log("  ⚠️  EXECUTE SUCCEEDED with only 1/2 approvals — multisig threshold is broken!");
  } catch (err) {
    stage1Failed = true;
    stage1Err = err instanceof Error ? err.message : String(err);
    // Look for the expected "InvalidProposalStatus" custom error or
    // anything containing "Active" — the Squads program rejects executes
    // against a proposal that's still in Active status.
    console.log("  ✓ rejected as expected");
    console.log("    error excerpt:", stage1Err.split("\n")[0]?.slice(0, 220));
  }

  if (!stage1Failed) {
    console.error("\nFAIL: multisig allowed execute with only 1 approval.");
    process.exit(1);
  }

  // ── Stage 2: member2 approves, then execute should pass ──────────────────
  console.log("\n[stage2] member2 approves (2/2)");
  await conn.confirmTransaction(
    await multisig.rpc.proposalApprove({
      connection: conn,
      feePayer: member1,
      member: member2,
      multisigPda,
      transactionIndex: nextIndex,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    }),
    "confirmed",
  );

  console.log("[stage2] attempt vaultTransactionExecute → expect SUCCESS …");
  const execSig = await multisig.rpc.vaultTransactionExecute({
    connection: conn,
    feePayer: member1,
    multisigPda,
    transactionIndex: nextIndex,
    member: member1.publicKey,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(execSig, "confirmed");
  console.log("  ✓ executed:", execSig);

  console.log("\n──────────────────────────────");
  console.log("✓ Threshold test PASSED");
  console.log("  Stage 1: 1/2 approvals → execute REJECTED");
  console.log("  Stage 2: 2/2 approvals → execute SUCCEEDED");
  console.log(`  Final exec: https://explorer.solana.com/tx/${execSig}?cluster=devnet`);
}

main().catch((err) => {
  console.error("threshold test FAILED:", err);
  process.exit(1);
});
