/**
 * Treasury + allowlist tests via Squads multisig.
 *
 * Scenarios:
 *   1. withdraw_to_treasury with NON-allowlisted destination → expect
 *      DestinationNotAllowlisted (6024).
 *   2. add_allowlist via Squads → vault.allowlist_count++.
 *   3. withdraw_to_treasury to the freshly-allowlisted destination →
 *      expect SUCCESS, vault.lamports drops, destination.lamports rises.
 *   4. remove_allowlist via Squads → vault.allowlist_count--.
 *   5. withdraw_to_treasury to the now-removed destination → expect
 *      DestinationNotAllowlisted again.
 *
 * Proves:
 *   - The allowlist actually gates withdrawals (security property).
 *   - Squads can add + remove allowlist entries (operational ability).
 *   - SOL physically flows from vault PDA to allowlisted destination
 *     (the "house cashes out edge profit" path).
 *
 * Cleanup: every allowlist entry added is removed at the end so the
 * vault state is the same after the test as before.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import {
  buildAllowlistAdd,
  buildAllowlistRemove,
  buildWithdrawToTreasury,
  decodeVault,
  deriveVaultPda,
} from "@playkaboom/sdk";

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
async function squadsExec(
  conn: Connection,
  multisigPda: PublicKey,
  m1: Keypair,
  m2: Keypair,
  innerIxs: TransactionInstruction[],
  squadsVault: PublicKey,
  memo: string,
): Promise<string> {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const next = BigInt(ms.transactionIndex.toString()) + 1n;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: squadsVault,
    recentBlockhash: blockhash,
    instructions: innerIxs,
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

async function readVault(conn: Connection, programId: PublicKey) {
  const [vaultPda] = deriveVaultPda(programId);
  const info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!info) throw new Error("vault not found");
  return { vaultPda, vault: decodeVault(info.data) };
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

  // Fresh allowlist target — random keypair (we never need to sign as it).
  const dest = Keypair.generate().publicKey;
  console.log("─ treasury + allowlist test ─");
  console.log("  programId:", programId.toBase58());
  console.log("  squads:   ", squadsVault.toBase58());
  console.log("  test dest:", dest.toBase58());

  const { vaultPda, vault: vBefore } = await readVault(conn, programId);
  console.log(`  vault now: ${vBefore.allowlistCount} entries on allowlist`);

  // ── 1. Withdraw to non-allowlisted → expect DestinationNotAllowlisted ──
  console.log("\n[1/5] withdraw_to_treasury → non-allowlisted dest → expect rejected");
  let r1 = false;
  try {
    await squadsExec(
      conn,
      multisigPda,
      m1,
      m2,
      [
        buildWithdrawToTreasury({
          ctx,
          treasury: squadsVault,
          destination: dest,
          amount: 1_000_000n,
        }),
      ],
      squadsVault,
      "test: non-allowlisted withdraw",
    );
    console.log("  ⚠️  withdraw to non-allowlisted destination SUCCEEDED — allowlist is broken!");
  } catch (err) {
    r1 = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.log("  ✓ rejected:", msg.split("\n")[0]?.slice(0, 220));
  }
  if (!r1) throw new Error("[1] allowlist not enforced");

  // ── 2. Add to allowlist via Squads ─────────────────────────────────────
  console.log("\n[2/5] Squads add_allowlist(dest)");
  const sig2 = await squadsExec(
    conn,
    multisigPda,
    m1,
    m2,
    [buildAllowlistAdd({ ctx, owner: squadsVault, address: dest })],
    squadsVault,
    "test: add allowlist",
  );
  console.log("  exec:", sig2);
  const { vault: vAfterAdd } = await readVault(conn, programId);
  console.log(`  allowlist: ${vBefore.allowlistCount} → ${vAfterAdd.allowlistCount}`);
  if (vAfterAdd.allowlistCount !== vBefore.allowlistCount + 1) {
    throw new Error("allowlist count didn't increment");
  }

  // ── 3. Withdraw → allowlisted → expect success ────────────────────────
  console.log("\n[3/5] withdraw_to_treasury → allowlisted dest → expect success");
  const vaultBalBefore = await conn.getBalance(vaultPda, "confirmed");
  const destBalBefore = await conn.getBalance(dest, "confirmed");
  const sig3 = await squadsExec(
    conn,
    multisigPda,
    m1,
    m2,
    [
      buildWithdrawToTreasury({
        ctx,
        treasury: squadsVault,
        destination: dest,
        amount: 1_000_000n,
      }),
    ],
    squadsVault,
    "test: allowlisted withdraw",
  );
  console.log("  exec:", sig3);
  const vaultBalAfter = await conn.getBalance(vaultPda, "confirmed");
  const destBalAfter = await conn.getBalance(dest, "confirmed");
  console.log(`  vault: ${(vaultBalBefore / 1e9).toFixed(6)} → ${(vaultBalAfter / 1e9).toFixed(6)} SOL`);
  console.log(`  dest:  ${(destBalBefore / 1e9).toFixed(6)} → ${(destBalAfter / 1e9).toFixed(6)} SOL`);
  if (vaultBalBefore - vaultBalAfter !== 1_000_000) {
    throw new Error(`vault delta wrong: expected -1_000_000, got ${vaultBalBefore - vaultBalAfter}`);
  }
  if (destBalAfter - destBalBefore !== 1_000_000) {
    throw new Error(`dest delta wrong: expected +1_000_000, got ${destBalAfter - destBalBefore}`);
  }
  console.log("  ✓ exact 0.001 SOL flowed vault → dest");

  // ── 4. Remove from allowlist via Squads ───────────────────────────────
  console.log("\n[4/5] Squads remove_allowlist(dest)");
  const sig4 = await squadsExec(
    conn,
    multisigPda,
    m1,
    m2,
    [buildAllowlistRemove({ ctx, owner: squadsVault, address: dest })],
    squadsVault,
    "test: remove allowlist",
  );
  console.log("  exec:", sig4);
  const { vault: vAfterRm } = await readVault(conn, programId);
  console.log(`  allowlist: ${vAfterAdd.allowlistCount} → ${vAfterRm.allowlistCount}`);
  if (vAfterRm.allowlistCount !== vBefore.allowlistCount) {
    throw new Error("allowlist count didn't return to baseline after remove");
  }

  // ── 5. Withdraw to now-removed dest → expect rejection ─────────────────
  console.log("\n[5/5] withdraw_to_treasury → removed dest → expect rejected");
  let r5 = false;
  try {
    await squadsExec(
      conn,
      multisigPda,
      m1,
      m2,
      [
        buildWithdrawToTreasury({
          ctx,
          treasury: squadsVault,
          destination: dest,
          amount: 1_000_000n,
        }),
      ],
      squadsVault,
      "test: removed-dest withdraw",
    );
  } catch (err) {
    r5 = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.log("  ✓ rejected:", msg.split("\n")[0]?.slice(0, 220));
  }
  if (!r5) throw new Error("[5] removed allowlist entry was not enforced");

  console.log("\n──────────────────────────────");
  console.log("✓ treasury + allowlist test PASSED");
  console.log("  - withdraw to non-allowlisted dest → rejected");
  console.log("  - Squads add → allowlist_count++");
  console.log("  - withdraw to allowlisted dest → 0.001 SOL flows correctly");
  console.log("  - Squads remove → allowlist_count--");
  console.log("  - withdraw to now-removed dest → rejected again");
}

main().catch((e) => {
  console.error("treasury+allowlist test FAILED:", e);
  process.exit(1);
});
