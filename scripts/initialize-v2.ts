/**
 * One-shot Phase 2 migration: invoke `initialize_v2` via Squads.
 *
 *   PROGRAM_ID=4rPEGz... npx tsx --env-file=apps/web/.env.local \
 *     scripts/initialize-v2.ts
 *
 * Carves the existing vault balance into:
 *   seed_units  = 1 SOL                          (locked anti-inflation)
 *   house_units = vault_assets - 1 SOL           (house's LP position)
 *   total_units = vault_assets                   (1 lamport = 1 unit)
 *
 * Sets all Phase 2 config knobs to defaults (3-day cooldown, 50% house floor,
 * 10% per-user cap, 10% min health, 0.01 SOL min deposit).
 *
 * Owner-signed. Since owner = Squads vault PDA after Phase 1, this goes
 * through the full Squads vaultTransactionCreate → proposalCreate → 2 approvals
 * → vaultTransactionExecute flow. Idempotent: second run fails at the
 * `init` constraint on v2_state account (already exists).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  SystemProgram,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { deriveVaultPda } from "@playkaboom/sdk";
import { ixDiscriminator } from "@playkaboom/sdk";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

const VAULT_V2_SEED = Buffer.from("kaboom_v2_state");

function deriveV2StatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_V2_SEED], programId);
}

function buildInitializeV2Ix(
  programId: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(programId);
  const [v2StatePda] = deriveV2StatePda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: v2StatePda, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixDiscriminator("initialize_v2"),
  });
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

  const owner = loadKeypair(resolve(homedir(), ".config/solana/id.json"));
  const cosigner = loadKeypair(
    resolve(process.cwd(), "keypairs/squads-cosigner-devnet.json"),
  );
  const squads = JSON.parse(
    readFileSync(resolve(process.cwd(), "keypairs/squads-devnet.json"), "utf8"),
  ) as { vaultPda: string; multisigPda: string };
  const squadsVault = new PublicKey(squads.vaultPda);
  const multisigPda = new PublicKey(squads.multisigPda);

  const conn = new Connection(rpc, "confirmed");
  const [v2StatePda] = deriveV2StatePda(programId);

  console.log("─ initialize_v2 migration via Squads ─");
  console.log("  Program       :", programId.toBase58());
  console.log("  Squads vault  :", squadsVault.toBase58());
  console.log("  v2_state PDA  :", v2StatePda.toBase58());

  const existing = await conn.getAccountInfo(v2StatePda, "confirmed");
  if (existing) {
    console.log("\n✓ v2_state already initialized at", v2StatePda.toBase58());
    console.log("  data length:", existing.data.length, "bytes");
    return;
  }

  const ix = buildInitializeV2Ix(programId, squadsVault);
  const { blockhash: dummyBh } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: squadsVault,
    recentBlockhash: dummyBh,
    instructions: [ix],
  });

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    conn,
    multisigPda,
  );
  const nextIndex = BigInt(multisigAccount.transactionIndex.toString()) + 1n;
  console.log("\nSquads transactionIndex →", nextIndex.toString());

  console.log("\n[1/5] vaultTransactionCreate …");
  let sig = await multisig.rpc.vaultTransactionCreate({
    connection: conn,
    feePayer: owner,
    multisigPda,
    transactionIndex: nextIndex,
    creator: owner.publicKey,
    rentPayer: owner.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: message,
    memo: "initialize_v2 (Phase 2 migration)",
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(sig, "confirmed");
  console.log("       sig:", sig);

  console.log("[2/5] proposalCreate …");
  sig = await multisig.rpc.proposalCreate({
    connection: conn,
    feePayer: owner,
    creator: owner,
    multisigPda,
    transactionIndex: nextIndex,
  });
  await conn.confirmTransaction(sig, "confirmed");
  console.log("       sig:", sig);

  console.log("[3/5] proposalApprove (member1) …");
  sig = await multisig.rpc.proposalApprove({
    connection: conn,
    feePayer: owner,
    member: owner,
    multisigPda,
    transactionIndex: nextIndex,
  });
  await conn.confirmTransaction(sig, "confirmed");
  console.log("       sig:", sig);

  console.log("[4/5] proposalApprove (member2) …");
  sig = await multisig.rpc.proposalApprove({
    connection: conn,
    feePayer: owner,
    member: cosigner,
    multisigPda,
    transactionIndex: nextIndex,
  });
  await conn.confirmTransaction(sig, "confirmed");
  console.log("       sig:", sig);

  console.log("[5/5] vaultTransactionExecute …");
  sig = await multisig.rpc.vaultTransactionExecute({
    connection: conn,
    feePayer: owner,
    multisigPda,
    transactionIndex: nextIndex,
    member: owner.publicKey,
  });
  await conn.confirmTransaction(sig, "confirmed");
  console.log("       sig:", sig);

  const after = await conn.getAccountInfo(v2StatePda, "confirmed");
  if (!after) throw new Error("v2_state not created after execute");
  console.log("\n✓ v2_state initialized");
  console.log("  PDA          :", v2StatePda.toBase58());
  console.log("  data length  :", after.data.length, "bytes");
  console.log("\nNext: deposit + smoke-test the LP flow.");
}

main().catch((err) => {
  console.error("initialize-v2 failed:", err);
  process.exit(1);
});
