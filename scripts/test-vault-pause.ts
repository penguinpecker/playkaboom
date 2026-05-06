/**
 * Tests the vault kill-switch.
 *
 *   1. Squads votes paused=true.
 *   2. A fresh player tries start_game → expect VaultPaused (6012).
 *   3. Squads votes paused=false.
 *   4. Same player retries start_game → succeeds.
 *   5. Player refund_expired's the test game (cleanup).
 *
 * Proves both:
 *   - the kill-switch actually blocks gameplay
 *   - the multisig can flip it on AND off
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
import {
  buildRefundExpired,
  buildStartGame,
  buildUpdateVault,
  decodeVault,
  deriveVaultPda,
} from "@playkaboom/sdk";
import { commitmentOf, unbiasedShuffleLayout } from "@playkaboom/shared";
import { randomBytes } from "node:crypto";

function envOrThrow(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing env ${n}`);
  return v;
}
function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]),
  );
}
async function send(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  signers: Keypair[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}
async function squadsExec(
  conn: Connection,
  multisigPda: PublicKey,
  m1: Keypair,
  m2: Keypair,
  innerIx: TransactionInstruction,
  squadsVault: PublicKey,
  memo: string,
): Promise<string> {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const next = BigInt(ms.transactionIndex.toString()) + 1n;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: squadsVault,
    recentBlockhash: blockhash,
    instructions: [innerIx],
  });
  await conn.confirmTransaction(
    await multisig.rpc.vaultTransactionCreate({
      connection: conn,
      feePayer: m1,
      multisigPda,
      transactionIndex: next,
      creator: m1.publicKey,
      rentPayer: m1.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: message,
      memo,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    }),
    "confirmed",
  );
  await conn.confirmTransaction(
    await multisig.rpc.proposalCreate({
      connection: conn,
      feePayer: m1,
      creator: m1,
      multisigPda,
      transactionIndex: next,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    }),
    "confirmed",
  );
  for (const m of [m1, m2]) {
    await conn.confirmTransaction(
      await multisig.rpc.proposalApprove({
        connection: conn,
        feePayer: m1,
        member: m,
        multisigPda,
        transactionIndex: next,
        sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
      }),
      "confirmed",
    );
  }
  const exec = await multisig.rpc.vaultTransactionExecute({
    connection: conn,
    feePayer: m1,
    multisigPda,
    transactionIndex: next,
    member: m1.publicKey,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(exec, "confirmed");
  return exec;
}

async function readPaused(conn: Connection, programId: PublicKey): Promise<boolean> {
  const [vaultPda] = deriveVaultPda(programId);
  const info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!info) throw new Error("vault not found");
  return decodeVault(info.data).paused;
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const conn = new Connection(
    process.env.SOLANA_RPC ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  const ctx = { programId };
  const m1 = loadKp(resolve(homedir(), ".config/solana/id.json"));
  const m2 = loadKp(resolve(process.cwd(), "keypairs/squads-cosigner-devnet.json"));
  const squads = JSON.parse(
    readFileSync(resolve(process.cwd(), "keypairs/squads-devnet.json"), "utf8"),
  ) as { vaultPda: string; multisigPda: string };
  const squadsVault = new PublicKey(squads.vaultPda);
  const multisigPda = new PublicKey(squads.multisigPda);

  console.log("─ vault kill-switch test ─");
  console.log("  programId :", programId.toBase58());
  console.log("  squads    :", squadsVault.toBase58());
  console.log("  paused now:", await readPaused(conn, programId));

  // 1. Pause via Squads
  console.log("\n[1/5] Squads vote: paused = true");
  const pauseSig = await squadsExec(
    conn,
    multisigPda,
    m1,
    m2,
    buildUpdateVault({ ctx, owner: squadsVault, paused: true }),
    squadsVault,
    "test: pause",
  );
  console.log("       multisig exec:", pauseSig);
  if (!(await readPaused(conn, programId))) {
    throw new Error("paused didn't flip to true");
  }

  // 2. start_game while paused → must fail
  console.log("\n[2/5] start_game while paused → expect VaultPaused");
  const player = Keypair.generate();
  await send(
    conn,
    m1,
    [
      SystemProgram.transfer({
        fromPubkey: m1.publicKey,
        toPubkey: player.publicKey,
        lamports: 50_000_000,
      }),
    ],
    [],
  );
  const layout = unbiasedShuffleLayout(3);
  const salt = randomBytes(32);
  const startIx = buildStartGame({
    ctx,
    player: player.publicKey,
    mineCount: 3,
    betLamports: 5_000_000n,
    commitment: commitmentOf(layout, 3, salt),
  });

  let pausedRejected = false;
  try {
    await send(conn, player, [startIx], [player]);
  } catch (err) {
    pausedRejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.log("       ✓ rejected:", msg.split("\n")[0]?.slice(0, 200));
  }
  if (!pausedRejected) {
    // Best-effort cleanup if start somehow succeeded.
    await squadsExec(
      conn,
      multisigPda,
      m1,
      m2,
      buildUpdateVault({ ctx, owner: squadsVault, paused: false }),
      squadsVault,
      "test: emergency unpause",
    );
    throw new Error("start_game succeeded while paused — kill-switch is broken!");
  }

  // 3. Unpause via Squads
  console.log("\n[3/5] Squads vote: paused = false");
  const unpauseSig = await squadsExec(
    conn,
    multisigPda,
    m1,
    m2,
    buildUpdateVault({ ctx, owner: squadsVault, paused: false }),
    squadsVault,
    "test: unpause",
  );
  console.log("       multisig exec:", unpauseSig);
  if (await readPaused(conn, programId)) {
    throw new Error("paused didn't flip back to false");
  }

  // 4. Retry start_game — should succeed now
  console.log("\n[4/5] start_game while unpaused → expect success");
  const startSig = await send(conn, player, [startIx], [player]);
  console.log("       sig:", startSig);

  // 5. Cleanup: refund the test game
  console.log("\n[5/5] cleanup: waiting 300 slots then refund_expired …");
  const startSlot = await conn.getSlot("confirmed");
  while (true) {
    const s = await conn.getSlot("confirmed");
    if (s >= startSlot + 305) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  await send(
    conn,
    player,
    [buildRefundExpired({ ctx, player: player.publicKey })],
    [player],
  );
  console.log("       cleanup done");

  console.log("\n──────────────────────────────");
  console.log("✓ vault kill-switch test PASSED");
  console.log("  - Squads paused vault → start_game blocked");
  console.log("  - Squads unpaused vault → start_game works");
}

main().catch((e) => {
  console.error("vault-pause test FAILED:", e);
  process.exit(1);
});
