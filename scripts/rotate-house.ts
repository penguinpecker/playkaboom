/**
 * Rotate the on-chain vault `house_authority` to the Turnkey-controlled wallet.
 *
 *   PROGRAM_ID=<pubkey> npx tsx --env-file=apps/web/.env.local scripts/rotate-house.ts
 *
 * Reads:
 *   ~/.config/solana/id.json     → owner / payer / signer (must equal vault.owner)
 *   PROGRAM_ID env               → deployed program id
 *   TURNKEY_HOUSE_PUBKEY env     → new house_authority (base58)
 *   SOLANA_RPC env (optional)    → defaults to devnet
 *
 * Idempotent: skips the call if the vault's house_authority already equals
 * TURNKEY_HOUSE_PUBKEY.
 *
 * After rotation, all sendHouseTx calls must come from the Turnkey signer
 * (USE_TURNKEY=true on Vercel) — the old raw key will be rejected on-chain.
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
  const newHouse = new PublicKey(envOrThrow("TURNKEY_HOUSE_PUBKEY"));
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

  const owner = loadKeypair(resolve(homedir(), ".config/solana/id.json"));

  console.log("─ Rotate house_authority ─");
  console.log("  RPC      :", rpc);
  console.log("  Program  :", programId.toBase58());
  console.log("  Owner    :", owner.publicKey.toBase58());
  console.log("  New house:", newHouse.toBase58());

  const conn = new Connection(rpc, "confirmed");
  const [vaultPda] = deriveVaultPda(programId);
  const info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!info) throw new Error(`Vault PDA ${vaultPda.toBase58()} not found`);
  const vault = decodeVault(info.data);
  console.log("\nCurrent vault state:");
  console.log("  Vault PDA       :", vaultPda.toBase58());
  console.log("  owner           :", vault.owner.toBase58());
  console.log("  house_authority :", vault.houseAuthority.toBase58());
  console.log("  treasury        :", vault.treasury.toBase58());

  if (!vault.owner.equals(owner.publicKey)) {
    throw new Error(
      `Owner key mismatch: vault owner is ${vault.owner.toBase58()}, signer is ${owner.publicKey.toBase58()}`,
    );
  }

  if (vault.houseAuthority.equals(newHouse)) {
    console.log("\n✓ house_authority already rotated; nothing to do.");
    return;
  }

  const ix = buildUpdateVault({
    ctx: { programId },
    owner: owner.publicKey,
    newHouseAuthority: newHouse,
  });
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = owner.publicKey;
  tx.sign(owner);

  console.log("\nSending update_vault…");
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value.err) {
    throw new Error(`update_vault failed: ${JSON.stringify(conf.value.err)}`);
  }
  console.log("  sig:", sig);

  const after = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!after) throw new Error("vault disappeared after rotation");
  const post = decodeVault(after.data);
  console.log("\nNew vault state:");
  console.log("  house_authority :", post.houseAuthority.toBase58());
  if (!post.houseAuthority.equals(newHouse)) {
    throw new Error("rotation did not take effect — house_authority unchanged");
  }
  console.log("\n✓ Rotation complete");
}

main().catch((err) => {
  console.error("rotate-house failed:", err);
  process.exit(1);
});
