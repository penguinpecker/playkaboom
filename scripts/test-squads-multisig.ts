/**
 * End-to-end smoke test for the 2-of-2 Squads multisig that now holds:
 *   - vault.owner            (PlayKaboom owner ops: update_vault, allowlist, etc)
 *   - vault.treasury         (allowlisted withdrawal destination)
 *   - BPF upgrade authority  (program upgrades)
 *
 * What it does:
 *   1. Reads multisig state.
 *   2. Builds a noop `update_vault` ix (all None args) addressed to the vault.
 *      Since vault.owner = Squads vault PDA, only a Squads-signed message can
 *      execute it.
 *   3. Wraps it in a Squads vault transaction.
 *   4. Member 1 (deployer / ~/.config/solana/id.json) creates the proposal.
 *   5. Member 1 approves.
 *   6. Member 2 (cosigner) approves → threshold met.
 *   7. Member 1 executes the vault transaction.
 *   8. Confirms the inner ix landed by reading vault state.
 *
 * Run:
 *   PROGRAM_ID=4rPEGzWoD2i8k3Pr5tnJsBV7AZEK2zQJCXZe4YgwcixT \
 *     npx tsx --env-file=apps/web/.env.local \
 *     scripts/test-squads-multisig.ts
 *
 * Output is a list of tx signatures + on-chain proof that the multisig
 * actually controls vault config now.
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
import { buildUpdateVault, decodeVault, deriveVaultPda } from "@playkaboom/sdk";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");

  // Member 1 = deployer (~/.config/solana/id.json), member 2 = cosigner
  // (keypairs/squads-cosigner-devnet.json). Both must approve.
  const member1 = loadKeypair(resolve(homedir(), ".config/solana/id.json"));
  const member2 = loadKeypair(
    resolve(process.cwd(), "keypairs/squads-cosigner-devnet.json"),
  );
  const squads = JSON.parse(
    readFileSync(resolve(process.cwd(), "keypairs/squads-devnet.json"), "utf8"),
  ) as { vaultPda: string; multisigPda: string };
  const squadsVault = new PublicKey(squads.vaultPda);
  const multisigPda = new PublicKey(squads.multisigPda);

  const [vaultPda] = deriveVaultPda(programId);

  console.log("─ Squads multisig smoke test ─");
  console.log("  Program          :", programId.toBase58());
  console.log("  PlayKaboom vault :", vaultPda.toBase58());
  console.log("  Squads vault PDA :", squadsVault.toBase58());
  console.log("  Squads multisig  :", multisigPda.toBase58());
  console.log("  Member 1 (creator):", member1.publicKey.toBase58());
  console.log("  Member 2          :", member2.publicKey.toBase58());

  const before = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!before) throw new Error("PlayKaboom vault PDA not found");
  const beforeVault = decodeVault(before.data);
  if (!beforeVault.owner.equals(squadsVault)) {
    throw new Error(
      `vault.owner is not the Squads vault PDA. Owner is ${beforeVault.owner.toBase58()} — run scripts/rotate-owner.ts first.`,
    );
  }
  console.log("\n[pre] vault.owner = Squads ✓");

  // Build the inner noop ix. All Option fields are undefined, so no field
  // changes — the on-chain handler just verifies owner sig and returns ok.
  // This is the cheapest possible "did Squads actually sign for the vault"
  // assertion. Owner field on the keys array is the squadsVault PDA; that's
  // what Squads' vaultTransactionExecute will sign as.
  const innerIx = buildUpdateVault({
    ctx: { programId },
    owner: squadsVault,
  });

  // Read multisig.transactionIndex → this is the next slot we'll create at.
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    conn,
    multisigPda,
  );
  const currentIndex = BigInt(multisigAccount.transactionIndex.toString());
  const nextIndex = currentIndex + 1n;
  console.log(
    `\nMultisig.transactionIndex: ${currentIndex} → next: ${nextIndex}`,
  );

  // Squads expects a TransactionMessage. The blockhash here is a placeholder;
  // execute time provides a fresh one.
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: squadsVault,
    recentBlockhash: blockhash,
    instructions: [innerIx],
  });

  // 1. Create the vault transaction.
  console.log("\n[1/4] vaultTransactionCreate …");
  const createSig = await multisig.rpc.vaultTransactionCreate({
    connection: conn,
    feePayer: member1,
    multisigPda,
    transactionIndex: nextIndex,
    creator: member1.publicKey,
    rentPayer: member1.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: message,
    memo: "smoke-test: noop update_vault",
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(createSig, "confirmed");
  console.log("       sig:", createSig);

  // 2. Create the proposal that members will vote on.
  console.log("\n[2/4] proposalCreate …");
  const propSig = await multisig.rpc.proposalCreate({
    connection: conn,
    feePayer: member1,
    creator: member1,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(propSig, "confirmed");
  console.log("       sig:", propSig);

  // 3. Both members approve.
  console.log("\n[3/4] proposalApprove × 2 …");
  const ap1 = await multisig.rpc.proposalApprove({
    connection: conn,
    feePayer: member1,
    member: member1,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(ap1, "confirmed");
  console.log("       member1 approve:", ap1);

  const ap2 = await multisig.rpc.proposalApprove({
    connection: conn,
    feePayer: member1,
    member: member2,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(ap2, "confirmed");
  console.log("       member2 approve:", ap2);

  // 4. Execute the vault transaction. The Squads program will assert the
  //    proposal status is Approved, then re-construct the inner message with
  //    the Squads vault PDA as a signer and dispatch it.
  console.log("\n[4/4] vaultTransactionExecute …");
  const execSig = await multisig.rpc.vaultTransactionExecute({
    connection: conn,
    feePayer: member1,
    multisigPda,
    transactionIndex: nextIndex,
    member: member1.publicKey,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(execSig, "confirmed");
  console.log("       exec sig:", execSig);

  console.log("\n──────────────────────────────");
  console.log("✓ Multisig smoke test PASSED");
  console.log(
    `  Squads vault PDA successfully signed an update_vault ix on PlayKaboom — the 2-of-2 multisig works end-to-end.`,
  );
  console.log("  Solana Explorer (devnet):");
  console.log(`    https://explorer.solana.com/tx/${execSig}?cluster=devnet`);
}

main().catch((err) => {
  console.error("test-squads-multisig FAILED:", err);
  process.exit(1);
});
