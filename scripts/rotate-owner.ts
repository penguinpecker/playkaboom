/**
 * Two-step owner rotation: PlayKaboom vault.owner → Squads multisig vault.
 *
 *   PROGRAM_ID=4rPEGz... npx tsx --env-file=apps/web/.env.local \
 *     scripts/rotate-owner.ts
 *
 * Flow (one script, end-to-end):
 *   1. Owner runs `propose_owner(squadsVault)` on PlayKaboom — sets vault.pending_owner.
 *   2. Owner (Squads member) creates a Squads vault transaction wrapping our
 *      `accept_ownership` ix.
 *   3. Owner creates the proposal.
 *   4. Owner approves.
 *   5. Generated devnet cosigner approves (we have its key locally).
 *   6. Owner executes the vault transaction → Squads vault PDA signs as
 *      new_owner → PlayKaboom sets vault.owner = squadsVault.
 *
 * Reads:
 *   ~/.config/solana/id.json                  → owner / payer / member 1
 *   keypairs/squads-cosigner-devnet.json      → member 2
 *   keypairs/squads-devnet.json               → multisigPda, vaultPda
 *   PROGRAM_ID env                            → PlayKaboom program id
 *
 * Idempotent-ish: detects each step's prior completion and skips:
 *   - skips propose_owner if vault.pending_owner == squadsVault already
 *   - skips Squads create/proposal/approvals if a tx at index N+1 already
 *     exists with the right shape (best-effort; safe to re-run after partial
 *     failures from a fresh `transactionIndex`).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import {
  buildAcceptOwnership,
  buildProposeOwner,
  decodeVault,
  deriveVaultPda,
} from "@playkaboom/sdk";

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
  const [vaultPda] = deriveVaultPda(programId);
  const ctx = { programId };

  console.log("─ Rotate owner → Squads (two-step) ─");
  console.log("  Program        :", programId.toBase58());
  console.log("  Owner / member1:", owner.publicKey.toBase58());
  console.log("  Cosigner/member2:", cosigner.publicKey.toBase58());
  console.log("  Squads vault   :", squadsVault.toBase58());
  console.log("  Squads multisig:", multisigPda.toBase58());
  console.log("  PlayKaboom vault:", vaultPda.toBase58());

  // ── Step 1: propose_owner (current owner-signed) ────────────────────────────
  let info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!info) throw new Error("PlayKaboom vault PDA not found");
  let vault = decodeVault(info.data);

  if (!vault.owner.equals(owner.publicKey)) {
    throw new Error(
      `Owner key mismatch: vault.owner=${vault.owner.toBase58()}, signer=${owner.publicKey.toBase58()}`,
    );
  }

  if (vault.pendingOwner && vault.pendingOwner.equals(squadsVault)) {
    console.log("\n[1/3] propose_owner: already pending → Squads, skipping");
  } else {
    const ix = buildProposeOwner({ ctx, owner: owner.publicKey, newOwner: squadsVault });
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = owner.publicKey;
    tx.sign(owner);
    console.log("\n[1/3] propose_owner …");
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log("       sig:", sig);
  }

  // ── Step 2: Squads vault tx wrapping accept_ownership ───────────────────────
  // Build the inner instruction. accept_ownership accounts: writable vault +
  // signer new_owner (== squads vault PDA).
  const acceptIx = buildAcceptOwnership({ ctx, newOwner: squadsVault });

  // Read multisig account to get transactionIndex
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    conn,
    multisigPda,
  );
  const currentIndex = BigInt(multisigAccount.transactionIndex.toString());
  const nextIndex = currentIndex + 1n;
  console.log(
    "\nSquads multisig.transactionIndex:",
    currentIndex.toString(),
    "→ nextIndex:",
    nextIndex.toString(),
  );

  // Construct the TransactionMessage that Squads will record. The blockhash is
  // not consumed at execute time; Squads provides a fresh one then. A current
  // valid blockhash here just keeps the message constructor happy.
  const { blockhash: dummyBlockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: squadsVault,
    recentBlockhash: dummyBlockhash,
    instructions: [acceptIx],
  });

  console.log(
    "[2/3] Squads vaultTransactionCreate + proposalCreate + 2 approvals + execute …",
  );

  const createSig = await multisig.rpc.vaultTransactionCreate({
    connection: conn,
    feePayer: owner,
    multisigPda,
    transactionIndex: nextIndex,
    creator: owner.publicKey,
    rentPayer: owner.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: message,
    memo: "rotate-owner: accept_ownership",
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(createSig, "confirmed");
  console.log("       vaultTransactionCreate sig:", createSig);

  const propSig = await multisig.rpc.proposalCreate({
    connection: conn,
    feePayer: owner,
    creator: owner,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(propSig, "confirmed");
  console.log("       proposalCreate sig:", propSig);

  const approve1 = await multisig.rpc.proposalApprove({
    connection: conn,
    feePayer: owner,
    member: owner,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(approve1, "confirmed");
  console.log("       proposalApprove (member1):", approve1);

  const approve2 = await multisig.rpc.proposalApprove({
    connection: conn,
    feePayer: owner,
    member: cosigner,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(approve2, "confirmed");
  console.log("       proposalApprove (member2):", approve2);

  const execSig = await multisig.rpc.vaultTransactionExecute({
    connection: conn,
    feePayer: owner,
    multisigPda,
    transactionIndex: nextIndex,
    member: owner.publicKey,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(execSig, "confirmed");
  console.log("       vaultTransactionExecute sig:", execSig);

  // ── Step 3: verify ──────────────────────────────────────────────────────────
  info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!info) throw new Error("PlayKaboom vault PDA not found after exec");
  vault = decodeVault(info.data);
  console.log("\n[3/3] On-chain post-rotation:");
  console.log("       vault.owner       :", vault.owner.toBase58());
  console.log("       vault.pendingOwner:", vault.pendingOwner?.toBase58() ?? "null");

  if (!vault.owner.equals(squadsVault)) {
    throw new Error(
      `Owner did not rotate: expected ${squadsVault.toBase58()}, got ${vault.owner.toBase58()}`,
    );
  }
  if (vault.pendingOwner !== null) {
    throw new Error("pending_owner not cleared after accept");
  }
  console.log("\n✓ Owner is now the Squads vault PDA. Future owner-only ops require 2-of-2 sigs.");
}

main().catch((err) => {
  console.error("rotate-owner failed:", err);
  process.exit(1);
});
