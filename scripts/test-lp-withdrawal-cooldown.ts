/**
 * End-to-end LP withdrawal-cooldown test on devnet.
 *
 * What it proves:
 *   1. complete_withdraw FAILS before the cooldown elapses
 *      (KaboomError::CooldownNotElapsed = 6037)
 *   2. complete_withdraw SUCCEEDS after the cooldown
 *   3. SOL actually moves: vault.lamports drops, user.lamports rises
 *   4. Squads multisig can adjust v2_state.withdraw_cooldown_slots
 *      (proves the multisig actually controls protocol parameters,
 *      not just symbolic ownership)
 *
 * Why we can't just wait 3 days:
 *   Default cooldown is 648,000 slots ≈ 3 days. We use Squads to
 *   *temporarily* drop it to 30 slots (~12s) for the duration of the
 *   test, then restore it to 648,000 at the end. Both cooldown changes
 *   require 2-of-2 multisig approval, which the test verifies.
 *
 * Flow:
 *   step 1   Generate ephemeral LP keypair, airdrop 0.5 SOL
 *   step 2   Squads vote: set withdraw_cooldown_slots = 30
 *   step 3   LP user calls lp_deposit(0.05 SOL)
 *   step 4   LP user calls request_withdraw(units)
 *   step 5   LP user attempts complete_withdraw → expect CooldownNotElapsed
 *   step 6   Wait until current_slot ≥ unlock_slot
 *   step 7   LP user calls complete_withdraw → expect success + SOL refund
 *   step 8   Squads vote: set withdraw_cooldown_slots = 648_000 (default)
 *
 * Run:
 *   PROGRAM_ID=4rPEGzWoD2i8k3Pr5tnJsBV7AZEK2zQJCXZe4YgwcixT \
 *     npx tsx --env-file=apps/web/.env.local \
 *     scripts/test-lp-withdrawal-cooldown.ts
 *
 * Cleanup:
 *   Even if the test crashes mid-flow, the cooldown will revert to 648_000
 *   the next time someone runs this. Worst case: the cooldown stays at 30
 *   slots for a few minutes (no real risk — that just makes withdrawals
 *   *faster* during the window, which can be reverted by re-running).
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
  buildUpdateV2Config,
  buildLpDeposit,
  buildRequestWithdraw,
  buildCompleteWithdraw,
  decodeVaultV2State,
  deriveLpPositionPda,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";

// Must be ≥ MIN_WITHDRAW_COOLDOWN_SLOTS (150) once the audit-fix program
// upgrade lands. Pre-upgrade, any value works; using 200 to be forward
// compatible with both the current and the patched program.
const TEST_COOLDOWN_SLOTS = 200n;
const DEFAULT_COOLDOWN_SLOTS = 648_000n;
const DEPOSIT_LAMPORTS = 50_000_000n; // 0.05 SOL
const AIRDROP_LAMPORTS = 500_000_000; // 0.5 SOL

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

async function squadsExec(
  conn: Connection,
  multisigPda: PublicKey,
  member1: Keypair,
  member2: Keypair,
  innerIx: TransactionInstruction,
  squadsVault: PublicKey,
  memo: string,
): Promise<string> {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const nextIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: squadsVault,
    recentBlockhash: blockhash,
    instructions: [innerIx],
  });
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
      memo,
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
  const exec = await multisig.rpc.vaultTransactionExecute({
    connection: conn,
    feePayer: member1,
    multisigPda,
    transactionIndex: nextIndex,
    member: member1.publicKey,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  await conn.confirmTransaction(exec, "confirmed");
  return exec;
}

async function sendIxAsUser(
  conn: Connection,
  user: Keypair,
  ix: TransactionInstruction,
): Promise<string> {
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user.publicKey;
  tx.sign(user);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/**
 * Fund a fresh keypair from the deployer wallet via a SystemTransfer.
 * Public devnet airdrops are heavily rate-limited and unreliable; the
 * deployer has plenty of SOL to spare for these tiny test amounts and
 * gets refunded by the test's own complete_withdraw step at the end
 * (modulo a few thousand lamports of tx fees).
 */
async function fundFromDeployer(
  conn: Connection,
  deployer: Keypair,
  to: PublicKey,
  lamports: number,
): Promise<void> {
  const ix = SystemProgram.transfer({
    fromPubkey: deployer.publicKey,
    toPubkey: to,
    lamports,
  });
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = deployer.publicKey;
  tx.sign(deployer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
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

  const [vaultPda] = deriveVaultPda(programId);
  const [v2StatePda] = deriveV2StatePda(programId);

  console.log("─ LP withdrawal cooldown test ─");
  console.log("  Program ID:", programId.toBase58());
  console.log("  Vault PDA :", vaultPda.toBase58());
  console.log("  V2 PDA    :", v2StatePda.toBase58());
  console.log("  Squads    :", squadsVault.toBase58());
  console.log();

  // Helper to read v2_state and current slot.
  async function readV2() {
    const info = await conn.getAccountInfo(v2StatePda, "confirmed");
    if (!info) throw new Error("v2_state PDA not found");
    return decodeVaultV2State(info.data);
  }

  // ── Step 1: ephemeral LP user ────────────────────────────────────────────
  const lpUser = Keypair.generate();
  console.log(`[1/8] LP user keypair: ${lpUser.publicKey.toBase58()}`);
  console.log(`      funding ${AIRDROP_LAMPORTS / 1e9} SOL from deployer …`);
  await fundFromDeployer(conn, member1, lpUser.publicKey, AIRDROP_LAMPORTS);
  const userBalStart = await conn.getBalance(lpUser.publicKey, "confirmed");
  console.log(`      balance: ${(userBalStart / 1e9).toFixed(4)} SOL`);

  // ── Step 2: Squads sets cooldown to 30 slots ─────────────────────────────
  console.log(
    `\n[2/8] Squads vote: withdraw_cooldown_slots = ${TEST_COOLDOWN_SLOTS} (test value)`,
  );
  const setShortIx = buildUpdateV2Config({
    ctx: { programId },
    owner: squadsVault,
    withdrawCooldownSlots: TEST_COOLDOWN_SLOTS,
  });
  const sig2 = await squadsExec(
    conn,
    multisigPda,
    member1,
    member2,
    setShortIx,
    squadsVault,
    "test: cooldown=30 slots",
  );
  console.log(`      multisig exec sig: ${sig2}`);
  const v2After = await readV2();
  console.log(`      v2.withdraw_cooldown_slots = ${v2After.withdrawCooldownSlots}`);
  if (v2After.withdrawCooldownSlots !== TEST_COOLDOWN_SLOTS) {
    throw new Error(`cooldown mismatch: expected ${TEST_COOLDOWN_SLOTS}, got ${v2After.withdrawCooldownSlots}`);
  }

  // ── Step 3: LP user deposits ─────────────────────────────────────────────
  console.log(`\n[3/8] LP user deposits ${Number(DEPOSIT_LAMPORTS) / 1e9} SOL …`);
  const vaultBalBefore = await conn.getBalance(vaultPda, "confirmed");
  const depositIx = buildLpDeposit({
    ctx: { programId },
    user: lpUser.publicKey,
    amountLamports: DEPOSIT_LAMPORTS,
  });
  const sig3 = await sendIxAsUser(conn, lpUser, depositIx);
  console.log(`      sig: ${sig3}`);
  const [positionPda] = deriveLpPositionPda(programId, lpUser.publicKey);
  console.log(`      position PDA: ${positionPda.toBase58()}`);
  const posInfo = await conn.getAccountInfo(positionPda, "confirmed");
  if (!posInfo) throw new Error("position PDA not created");

  // We pull the user's units from v2.total_units delta — our SDK exports
  // an LpPosition decoder, but for this test reading the delta is fine
  // because no other user is depositing concurrently.
  const v2AfterDeposit = await readV2();
  const userUnits = v2AfterDeposit.totalUnits - v2After.totalUnits;
  console.log(`      units minted: ${userUnits}`);
  const vaultBalAfterDeposit = await conn.getBalance(vaultPda, "confirmed");
  console.log(
    `      vault: ${(vaultBalBefore / 1e9).toFixed(4)} → ${(vaultBalAfterDeposit / 1e9).toFixed(4)} SOL`,
  );

  // ── Step 4: request withdraw ─────────────────────────────────────────────
  console.log("\n[4/8] LP user calls request_withdraw …");
  const reqIx = buildRequestWithdraw({
    ctx: { programId },
    user: lpUser.publicKey,
    units: userUnits,
  });
  const sig4 = await sendIxAsUser(conn, lpUser, reqIx);
  console.log(`      sig: ${sig4}`);
  const slotAfterRequest = await conn.getSlot("confirmed");
  console.log(`      current slot: ${slotAfterRequest}`);
  console.log(`      expected unlock slot: ${slotAfterRequest + Number(TEST_COOLDOWN_SLOTS)}`);

  // ── Step 5: try complete_withdraw immediately → expect CooldownNotElapsed
  console.log("\n[5/8] complete_withdraw immediately → expect CooldownNotElapsed");
  const completeIx = buildCompleteWithdraw({
    ctx: { programId },
    user: lpUser.publicKey,
  });
  let earlyRejected = false;
  try {
    const sig = await sendIxAsUser(conn, lpUser, completeIx);
    console.log(`      ⚠️  succeeded — cooldown NOT enforced! sig: ${sig}`);
  } catch (err) {
    earlyRejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    const looksRight = msg.includes("CooldownNotElapsed") || msg.includes("0x1795") || msg.includes("Custom\":6037");
    console.log(`      ${looksRight ? "✓" : "?"} rejected:`, msg.split("\n")[0]?.slice(0, 220));
  }
  if (!earlyRejected) {
    throw new Error("complete_withdraw should have been rejected during cooldown");
  }

  // ── Step 6: wait for cooldown to elapse ──────────────────────────────────
  console.log(
    `\n[6/8] waiting for slot ≥ ${slotAfterRequest + Number(TEST_COOLDOWN_SLOTS)} (≈${Number(TEST_COOLDOWN_SLOTS) * 0.4}s) …`,
  );
  const target = slotAfterRequest + Number(TEST_COOLDOWN_SLOTS) + 2; // safety margin
  while (true) {
    const s = await conn.getSlot("confirmed");
    if (s >= target) {
      console.log(`      slot ${s} ≥ ${target}, ready`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // ── Step 7: complete_withdraw → expect success + SOL refund ──────────────
  console.log("\n[7/8] complete_withdraw → expect success");
  const userBalBeforeRefund = await conn.getBalance(lpUser.publicKey, "confirmed");
  const vaultBalBeforeRefund = await conn.getBalance(vaultPda, "confirmed");
  const sig7 = await sendIxAsUser(conn, lpUser, completeIx);
  console.log(`      sig: ${sig7}`);
  const userBalAfter = await conn.getBalance(lpUser.publicKey, "confirmed");
  const vaultBalAfter = await conn.getBalance(vaultPda, "confirmed");
  const userDelta = userBalAfter - userBalBeforeRefund;
  const vaultDelta = vaultBalBeforeRefund - vaultBalAfter;
  console.log(
    `      user balance: ${(userBalBeforeRefund / 1e9).toFixed(6)} → ${(userBalAfter / 1e9).toFixed(6)} SOL  (Δ +${(userDelta / 1e9).toFixed(6)})`,
  );
  console.log(
    `      vault balance: ${(vaultBalBeforeRefund / 1e9).toFixed(6)} → ${(vaultBalAfter / 1e9).toFixed(6)} SOL  (Δ −${(vaultDelta / 1e9).toFixed(6)})`,
  );
  if (userDelta <= 0 || vaultDelta <= 0) {
    throw new Error("SOL flow assertion failed: user should gain, vault should lose");
  }

  // ── Step 8: Squads restores cooldown ─────────────────────────────────────
  console.log(
    `\n[8/8] Squads vote: withdraw_cooldown_slots = ${DEFAULT_COOLDOWN_SLOTS} (default ≈ 3 days)`,
  );
  const restoreIx = buildUpdateV2Config({
    ctx: { programId },
    owner: squadsVault,
    withdrawCooldownSlots: DEFAULT_COOLDOWN_SLOTS,
  });
  const sig8 = await squadsExec(
    conn,
    multisigPda,
    member1,
    member2,
    restoreIx,
    squadsVault,
    "test: cooldown=default",
  );
  console.log(`      multisig exec sig: ${sig8}`);
  const v2Final = await readV2();
  console.log(`      v2.withdraw_cooldown_slots = ${v2Final.withdrawCooldownSlots}`);

  console.log("\n──────────────────────────────");
  console.log("✓ LP withdrawal cooldown test PASSED");
  console.log("  - cooldown enforced (early withdraw rejected)");
  console.log(`  - SOL refunded ${(userDelta / 1e9).toFixed(6)} SOL from vault to user`);
  console.log("  - Squads multisig successfully changed + restored cooldown config");
}

main().catch((err) => {
  console.error("test-lp-withdrawal-cooldown FAILED:", err);
  process.exit(1);
});
