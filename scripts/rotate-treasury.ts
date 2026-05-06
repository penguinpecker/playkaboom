/**
 * Rotate the on-chain vault `treasury` to the Squads multisig vault, and add
 * the same address to the withdraw allowlist. Owner-signed, single tx.
 *
 *   PROGRAM_ID=<pubkey> npx tsx --env-file=apps/web/.env.local \
 *     scripts/rotate-treasury.ts
 *
 * Reads:
 *   ~/.config/solana/id.json                     → owner / payer (must equal vault.owner)
 *   keypairs/squads-devnet.json                  → { vaultPda, multisigPda, ... }
 *   PROGRAM_ID env                               → deployed program id
 *   SOLANA_RPC env (optional)                    → defaults to devnet
 *
 * Idempotent: skips the update if `vault.treasury` already matches the Squads
 * vault, and skips the allowlist add if the address is already on the list.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  buildAllowlistAdd,
  buildUpdateVault,
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
  const squads = JSON.parse(
    readFileSync(resolve(process.cwd(), "keypairs/squads-devnet.json"), "utf8"),
  ) as { vaultPda: string; multisigPda: string };
  const squadsVault = new PublicKey(squads.vaultPda);

  const conn = new Connection(rpc, "confirmed");
  const [vaultPda] = deriveVaultPda(programId);
  const info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!info) throw new Error(`Vault PDA ${vaultPda.toBase58()} not found`);
  const vault = decodeVault(info.data);

  console.log("─ Rotate treasury → Squads ─");
  console.log("  Program       :", programId.toBase58());
  console.log("  Owner (signer):", owner.publicKey.toBase58());
  console.log("  Vault PDA     :", vaultPda.toBase58());
  console.log("  Squads vault  :", squadsVault.toBase58());
  console.log("  Squads multisig:", squads.multisigPda);
  console.log("\nCurrent on-chain:");
  console.log("  vault.owner   :", vault.owner.toBase58());
  console.log("  vault.treasury:", vault.treasury.toBase58());
  console.log("  allowlist     :", vault.withdrawAllowlist.map((p) => p.toBase58()));

  if (!vault.owner.equals(owner.publicKey)) {
    throw new Error(
      `Owner key mismatch: vault.owner=${vault.owner.toBase58()}, signer=${owner.publicKey.toBase58()}`,
    );
  }

  const ctx = { programId };
  const ixs = [];

  if (vault.treasury.equals(squadsVault)) {
    console.log("\n[1/2] update_vault: treasury already set to Squads vault, skipping");
  } else {
    ixs.push(buildUpdateVault({ ctx, owner: owner.publicKey, newTreasury: squadsVault }));
    console.log("\n[1/2] update_vault: queued (treasury → Squads vault)");
  }

  const onAllowlist = vault.withdrawAllowlist.some((p) => p.equals(squadsVault));
  if (onAllowlist) {
    console.log("[2/2] allowlist_add: Squads vault already allowlisted, skipping");
  } else {
    ixs.push(buildAllowlistAdd({ ctx, owner: owner.publicKey, address: squadsVault }));
    console.log("[2/2] allowlist_add: queued");
  }

  if (ixs.length === 0) {
    console.log("\n✓ Nothing to do.");
    return;
  }

  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = owner.publicKey;
  tx.sign(owner);

  console.log("\nSending…");
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value.err) {
    throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);
  }
  console.log("  sig:", sig);

  const after = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!after) throw new Error("vault disappeared");
  const post = decodeVault(after.data);
  console.log("\nNew on-chain:");
  console.log("  vault.treasury:", post.treasury.toBase58());
  console.log("  allowlist     :", post.withdrawAllowlist.map((p) => p.toBase58()));

  if (!post.treasury.equals(squadsVault)) {
    throw new Error("rotation did not take effect — treasury unchanged");
  }
  if (!post.withdrawAllowlist.some((p) => p.equals(squadsVault))) {
    throw new Error("allowlist add did not take effect");
  }
  console.log("\n✓ Treasury rotated to Squads, allowlist updated");
}

main().catch((err) => {
  console.error("rotate-treasury failed:", err);
  process.exit(1);
});
