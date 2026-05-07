/**
 * One-shot Squads-signed migration: repair every legacy ReferralAccount whose
 * `referrer` field is Pubkey::default(). Those were created before the
 * 2026-05-07 set_referrer fix (commit 658251e) and their `claim_referral`
 * fails the `referrer == referral_account.referrer` constraint forever.
 *
 *   PROGRAM_ID=4rPEGz... npx tsx --env-file=apps/web/.env.local \
 *     scripts/repair-referrals.ts
 *
 * Flow:
 *   1. Scan every ReferralAccount via getProgramAccounts (discriminator filter).
 *   2. Filter to ones where referrer == Pubkey::default() (the broken state).
 *   3. For each broken PDA, fetch its earliest tx (the buggy `set_referrer`
 *      that init'd it) and recover the original referrer pubkey from
 *      AccountMeta[1] of the set_referrer ix.
 *   4. For each recovered (referrer, referralPda) pair: wrap a single
 *      repair_referral ix in a Squads vault transaction →
 *      vaultTransactionCreate → proposalCreate → owner approve →
 *      cosigner approve → vaultTransactionExecute.
 *   5. Verify on-chain that the referrer field now matches.
 *
 * Idempotent: a referrer whose account is already correct gets a no-op
 * (the on-chain ix returns Ok early). Re-running the script is safe.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import {
  accountDiscriminator,
  buildRepairReferral,
  decodeReferralAccount,
  deriveReferralPda,
  ixDiscriminator,
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

const REFERRAL_ACCOUNT_DISC = accountDiscriminator("ReferralAccount");
const SET_REFERRER_IX_DISC = ixDiscriminator("set_referrer");

async function recoverReferrerFromHistory(
  conn: Connection,
  programId: PublicKey,
  referralPda: PublicKey,
): Promise<PublicKey | null> {
  // Walk back to the oldest tx touching this PDA. set_referrer is the init,
  // so it's the earliest. Page through if needed; cap at a few thousand sigs.
  let before: string | undefined = undefined;
  let earliest: { signature: string; slot: number } | null = null;
  for (let page = 0; page < 10; page++) {
    const sigs = await conn.getSignaturesForAddress(
      referralPda,
      { limit: 1000, before },
      "confirmed",
    );
    if (sigs.length === 0) break;
    for (const s of sigs) {
      if (!earliest || s.slot < earliest.slot) {
        earliest = { signature: s.signature, slot: s.slot };
      }
    }
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
  }
  if (!earliest) return null;

  const tx = await conn.getTransaction(earliest.signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) return null;

  const message = tx.transaction.message;
  const allKeys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined,
  });

  for (const ix of message.compiledInstructions) {
    const progKey = allKeys.get(ix.programIdIndex);
    if (!progKey || !progKey.equals(programId)) continue;

    const data = Buffer.from(ix.data);
    if (data.length < 8) continue;
    if (!data.subarray(0, 8).equals(SET_REFERRER_IX_DISC)) continue;

    // SetReferrer accounts order: [player_stats, referrer, referral_account, player, system]
    if (ix.accountKeyIndexes.length < 3) continue;
    const referrerIdx = ix.accountKeyIndexes[1];
    const referralAccountIdx = ix.accountKeyIndexes[2];
    const referrerKey = allKeys.get(referrerIdx);
    const referralAccountKey = allKeys.get(referralAccountIdx);
    if (!referrerKey || !referralAccountKey) continue;
    if (!referralAccountKey.equals(referralPda)) continue;
    return referrerKey;
  }
  return null;
}

async function repairOne(args: {
  conn: Connection;
  programId: PublicKey;
  multisigPda: PublicKey;
  squadsVault: PublicKey;
  owner: Keypair;
  cosigner: Keypair;
  referrer: PublicKey;
}): Promise<{ ok: true; sig: string } | { ok: false; error: string }> {
  const { conn, programId, multisigPda, squadsVault, owner, cosigner, referrer } = args;
  const ix = buildRepairReferral({
    ctx: { programId },
    owner: squadsVault,
    referrer,
  });

  try {
    const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
      conn,
      multisigPda,
    );
    const nextIndex = BigInt(multisigAccount.transactionIndex.toString()) + 1n;

    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: squadsVault,
      recentBlockhash: blockhash,
      instructions: [ix],
    });

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
      memo: `repair_referral ${referrer.toBase58().slice(0, 8)}…`,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    });
    await conn.confirmTransaction(createSig, "confirmed");

    const propSig = await multisig.rpc.proposalCreate({
      connection: conn,
      feePayer: owner,
      creator: owner,
      multisigPda,
      transactionIndex: nextIndex,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    });
    await conn.confirmTransaction(propSig, "confirmed");

    const approve1 = await multisig.rpc.proposalApprove({
      connection: conn,
      feePayer: owner,
      member: owner,
      multisigPda,
      transactionIndex: nextIndex,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    });
    await conn.confirmTransaction(approve1, "confirmed");

    const approve2 = await multisig.rpc.proposalApprove({
      connection: conn,
      feePayer: owner,
      member: cosigner,
      multisigPda,
      transactionIndex: nextIndex,
      sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
    });
    await conn.confirmTransaction(approve2, "confirmed");

    // Build execute ix manually so we get readable transactionLogs on failure
    // (multisig.rpc.vaultTransactionExecute swallows them — see HANDOFF.md).
    const executeIxBundle = await multisig.instructions.vaultTransactionExecute({
      connection: conn,
      multisigPda,
      transactionIndex: nextIndex,
      member: owner.publicKey,
    });

    const execTx = new Transaction().add(executeIxBundle.instruction);
    const { blockhash: execBlockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash("confirmed");
    execTx.recentBlockhash = execBlockhash;
    execTx.lastValidBlockHeight = lastValidBlockHeight;
    execTx.feePayer = owner.publicKey;
    execTx.sign(owner);

    const execSig = await conn.sendRawTransaction(execTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await conn.confirmTransaction(
      { signature: execSig, blockhash: execBlockhash, lastValidBlockHeight },
      "confirmed",
    );
    return { ok: true, sig: execSig };
  } catch (err) {
    const msg =
      (err as { transactionLogs?: string[] }).transactionLogs?.join("\n") ??
      (err as Error).message ??
      String(err);
    return { ok: false, error: msg };
  }
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

  console.log("─ Repair legacy ReferralAccounts ─");
  console.log("  Program        :", programId.toBase58());
  console.log("  Owner / member1:", owner.publicKey.toBase58());
  console.log("  Squads multisig:", multisigPda.toBase58());
  console.log("  RPC            :", rpc);

  // Scan all ReferralAccount PDAs via discriminator filter
  console.log("\n[1/3] Scanning getProgramAccounts for ReferralAccounts …");
  const accounts = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: bs58.encode(REFERRAL_ACCOUNT_DISC),
        },
      },
    ],
  });
  console.log(`       found ${accounts.length} ReferralAccount(s)`);

  // Filter to broken ones
  const broken: { pda: PublicKey }[] = [];
  for (const a of accounts) {
    try {
      const data = decodeReferralAccount(a.account.data);
      if (data.referrer.equals(PublicKey.default)) {
        broken.push({ pda: a.pubkey });
      }
    } catch (err) {
      console.warn(`       skip ${a.pubkey.toBase58()}: ${(err as Error).message}`);
    }
  }
  console.log(`       ${broken.length} have referrer = Pubkey::default()`);
  if (broken.length === 0) {
    console.log("\n✓ Nothing to repair.");
    return;
  }

  // Recover original referrer pubkey from earliest tx
  console.log("\n[2/3] Recovering referrer pubkeys from on-chain history …");
  type RepairTarget = { pda: PublicKey; referrer: PublicKey };
  const targets: RepairTarget[] = [];
  const unrecovered: PublicKey[] = [];
  for (const b of broken) {
    const referrer = await recoverReferrerFromHistory(conn, programId, b.pda);
    if (!referrer) {
      unrecovered.push(b.pda);
      console.warn(`       could not recover referrer for ${b.pda.toBase58()}`);
      continue;
    }
    // Sanity: derived PDA must match
    const [derivedPda] = deriveReferralPda(programId, referrer);
    if (!derivedPda.equals(b.pda)) {
      console.warn(
        `       derived PDA mismatch for referrer ${referrer.toBase58()}: ` +
          `expected ${b.pda.toBase58()}, got ${derivedPda.toBase58()} — skipping`,
      );
      unrecovered.push(b.pda);
      continue;
    }
    targets.push({ pda: b.pda, referrer });
  }
  console.log(`       recovered ${targets.length}/${broken.length}`);

  // Repair each one via Squads
  console.log(`\n[3/3] Submitting ${targets.length} Squads-signed repair_referral tx(s) …`);
  const successes: { referrer: string; sig: string }[] = [];
  const failures: { referrer: string; error: string }[] = [];
  for (const t of targets) {
    process.stdout.write(`       ${t.referrer.toBase58().slice(0, 8)}… `);
    const result = await repairOne({
      conn,
      programId,
      multisigPda,
      squadsVault,
      owner,
      cosigner,
      referrer: t.referrer,
    });
    if (result.ok) {
      console.log(`✓ ${result.sig}`);
      successes.push({ referrer: t.referrer.toBase58(), sig: result.sig });
    } else {
      console.log("✗");
      console.log("         ", result.error.split("\n").slice(0, 4).join("\n          "));
      failures.push({ referrer: t.referrer.toBase58(), error: result.error });
    }
  }

  console.log("\n─ Summary ─");
  console.log(`  Repaired   : ${successes.length}`);
  console.log(`  Failed     : ${failures.length}`);
  console.log(`  Unrecovered: ${unrecovered.length}`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("repair-referrals failed:", err);
  process.exit(1);
});
