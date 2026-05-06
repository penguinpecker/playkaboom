/**
 * Upgrade the on-chain Kaboom program through the Squads multisig.
 *
 * Background: BPF upgrade authority was transferred to the Squads vault
 * PDA on 2026-05-07 (scripts/transfer-upgrade-authority.ts). After that,
 * the deployer key alone can no longer call BPFLoaderUpgradeable's
 * Upgrade ix — only a Squads-signed message can.
 *
 * This script does the full flow end-to-end:
 *   1. Build (caller does this — `anchor build`).
 *   2. Read target/deploy/kaboom.so.
 *   3. Create a buffer account, write the bytecode chunks (single-key —
 *      buffer creation doesn't need the upgrade authority).
 *   4. Set buffer authority to the Squads vault PDA. After this, only
 *      Squads can consume the buffer.
 *   5. Build the BPFLoaderUpgradeable.Upgrade ix (uses the buffer).
 *   6. Wrap it in a Squads vault transaction.
 *   7. Members 1 + 2 approve.
 *   8. Execute → on-chain program is replaced atomically.
 *
 * Usage:
 *   PROGRAM_ID=4rPEGzWoD2i8k3Pr5tnJsBV7AZEK2zQJCXZe4YgwcixT \
 *     npx tsx --env-file=apps/web/.env.local \
 *     scripts/upgrade-program-via-squads.ts
 *
 * Cost:
 *   - Buffer rent: ~bytecode size × 6.96e-6 SOL/byte ≈ 4.5 SOL temporarily
 *     (refunded to spill account when the upgrade ix consumes the buffer).
 *   - Per-chunk tx fee: ~0.000005 SOL × ~600 chunks ≈ 0.003 SOL.
 *   - Squads create + 2 approvals + execute: ~0.001 SOL total.
 *
 * Idempotency:
 *   The buffer keypair is generated fresh each run. If a previous run
 *   crashed mid-write, the buffer is dangling — close it manually with
 *   `solana program close <buffer>` to recover the rent. We don't auto-
 *   detect/resume because the buffer signer is ephemeral.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
// Anchor / solana CLI use ~960 bytes of bytecode per chunk to stay under
// the per-tx data limit. Conservative — the exact limit is ~1232 bytes
// minus header overhead.
const CHUNK_SIZE = 900;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function deriveProgramData(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  );
  return pda;
}

/** BPFLoaderUpgradeable instructions we need (manually encoded — there's
 *  no first-class @solana/web3.js helper for these in older versions). */
function buildInitializeBufferIx(
  buffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(0, 0); // InitializeBuffer
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildWriteIx(
  buffer: PublicKey,
  authority: PublicKey,
  offset: number,
  bytes: Buffer,
): TransactionInstruction {
  const data = Buffer.alloc(4 + 4 + 4 + bytes.length);
  data.writeUInt32LE(1, 0); // Write
  data.writeUInt32LE(offset, 4);
  // Vec<u8> length prefix is 4-byte u32 little-endian
  data.writeUInt32LE(bytes.length, 8);
  bytes.copy(data, 12);
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildSetBufferAuthorityIx(
  buffer: PublicKey,
  currentAuth: PublicKey,
  newAuth: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(4, 0); // SetAuthority (buffer variant)
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: currentAuth, isSigner: true, isWritable: false },
      { pubkey: newAuth, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildUpgradeIx(
  programData: PublicKey,
  programId: PublicKey,
  buffer: PublicKey,
  spill: PublicKey,
  rentSysvar: PublicKey,
  clockSysvar: PublicKey,
  upgradeAuthority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(3, 0); // Upgrade
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: spill, isSigner: false, isWritable: true },
      { pubkey: rentSysvar, isSigner: false, isWritable: false },
      { pubkey: clockSysvar, isSigner: false, isWritable: false },
      { pubkey: upgradeAuthority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");

  const member1 = loadKeypair(resolve(homedir(), ".config/solana/id.json"));
  const member2 = loadKeypair(
    resolve(process.cwd(), "keypairs/squads-cosigner-devnet.json"),
  );
  const squads = JSON.parse(
    readFileSync(resolve(process.cwd(), "keypairs/squads-devnet.json"), "utf8"),
  ) as { vaultPda: string; multisigPda: string };
  const squadsVault = new PublicKey(squads.vaultPda);
  const multisigPda = new PublicKey(squads.multisigPda);

  const soPath = resolve(process.cwd(), "target/deploy/kaboom.so");
  const bytecode = readFileSync(soPath);

  const programData = deriveProgramData(programId);
  const buffer = Keypair.generate();
  const spill = member1.publicKey; // rent refund destination

  console.log("─ Squads program upgrade ─");
  console.log("  Program ID:        ", programId.toBase58());
  console.log("  ProgramData PDA:   ", programData.toBase58());
  console.log("  Bytecode bytes:    ", bytecode.length);
  console.log("  Buffer (ephemeral):", buffer.publicKey.toBase58());
  console.log("  Squads vault PDA:  ", squadsVault.toBase58());
  console.log();

  // ── Step 1: Create the buffer account, sized for the bytecode + 45-byte header.
  const bufferSpace = 45 + bytecode.length;
  const rentLamports = await conn.getMinimumBalanceForRentExemption(bufferSpace);
  console.log(
    `[1/5] Create buffer account (${bufferSpace} bytes, ${(rentLamports / 1e9).toFixed(4)} SOL rent) …`,
  );
  const createIx = SystemProgram.createAccount({
    fromPubkey: member1.publicKey,
    newAccountPubkey: buffer.publicKey,
    lamports: rentLamports,
    space: bufferSpace,
    programId: BPF_LOADER_UPGRADEABLE,
  });
  const initBufIx = buildInitializeBufferIx(buffer.publicKey, member1.publicKey);
  {
    const tx = new Transaction().add(createIx, initBufIx);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = member1.publicKey;
    tx.sign(member1, buffer);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log("       sig:", sig);
  }

  // ── Step 2: Write bytecode in chunks (single-key, member1 is buffer authority).
  const chunkCount = Math.ceil(bytecode.length / CHUNK_SIZE);
  console.log(`\n[2/5] Write ${chunkCount} chunks of ≤${CHUNK_SIZE} bytes …`);
  for (let i = 0; i < chunkCount; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = bytecode.subarray(offset, Math.min(offset + CHUNK_SIZE, bytecode.length));
    const ix = buildWriteIx(buffer.publicKey, member1.publicKey, offset, chunk);
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = member1.publicKey;
    tx.sign(member1);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (i % 25 === 0 || i === chunkCount - 1) {
      console.log(`       chunk ${i + 1}/${chunkCount}: ${sig}`);
    }
  }

  // ── Step 3: Transfer buffer authority to Squads vault PDA.
  console.log("\n[3/5] Transfer buffer authority → Squads vault …");
  {
    const ix = buildSetBufferAuthorityIx(buffer.publicKey, member1.publicKey, squadsVault);
    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = member1.publicKey;
    tx.sign(member1);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log("       sig:", sig);
  }

  // ── Step 4: Squads vault transaction wrapping the Upgrade ix.
  // BPFLoaderUpgradeable's Upgrade ix needs:
  //   1. ProgramData (writable)  2. Program (writable)  3. Buffer (writable)
  //   4. Spill (writable, signer-not-required)
  //   5. Rent sysvar  6. Clock sysvar  7. Upgrade authority (signer)
  // The signer is the Squads vault PDA, which Squads will sign as during
  // vaultTransactionExecute.
  const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
  const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");
  const upgradeIx = buildUpgradeIx(
    programData,
    programId,
    buffer.publicKey,
    spill,
    RENT_SYSVAR,
    CLOCK_SYSVAR,
    squadsVault,
  );

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    conn,
    multisigPda,
  );
  const nextIndex = BigInt(multisigAccount.transactionIndex.toString()) + 1n;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: squadsVault,
    recentBlockhash: blockhash,
    instructions: [upgradeIx],
  });

  console.log(`\n[4/5] Squads vault tx + 2 approvals (transactionIndex ${nextIndex}) …`);
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
    memo: `program upgrade buffer=${buffer.publicKey.toBase58()}`,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(createSig, "confirmed");
  console.log("       create:", createSig);

  const propSig = await multisig.rpc.proposalCreate({
    connection: conn,
    feePayer: member1,
    creator: member1,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(propSig, "confirmed");
  console.log("       proposal:", propSig);

  const ap1 = await multisig.rpc.proposalApprove({
    connection: conn,
    feePayer: member1,
    member: member1,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(ap1, "confirmed");
  console.log("       approve member1:", ap1);

  const ap2 = await multisig.rpc.proposalApprove({
    connection: conn,
    feePayer: member1,
    member: member2,
    multisigPda,
    transactionIndex: nextIndex,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(ap2, "confirmed");
  console.log("       approve member2:", ap2);

  // ── Step 5: Execute. Squads dispatches the inner Upgrade ix; the
  //    BPF Upgradeable Loader sees the Squads vault PDA as upgrade
  //    authority signer and atomically replaces ProgramData with the
  //    buffer's contents.
  console.log("\n[5/5] vaultTransactionExecute …");
  const execSig = await multisig.rpc.vaultTransactionExecute({
    connection: conn,
    feePayer: member1,
    multisigPda,
    transactionIndex: nextIndex,
    member: member1.publicKey,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(execSig, "confirmed");
  console.log("       exec:", execSig);

  console.log("\n──────────────────────────────");
  console.log("✓ Program upgraded via Squads multisig");
  console.log(`  https://explorer.solana.com/tx/${execSig}?cluster=devnet`);
}

main().catch((err) => {
  console.error("upgrade-program-via-squads FAILED:", err);
  process.exit(1);
});
