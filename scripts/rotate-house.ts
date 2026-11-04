/**
 * Rotate the on-chain vault `house_authority` to a new raw house keypair's
 * PUBLIC key (mainnet, relaunch program). Never pass the secret here.
 *
 *   SOLANA_MAINNET_RPC=... npx tsx scripts/rotate-house.ts --house <NEW_HOUSE_PUBKEY>
 *
 * Reads:
 *   OWNER_KEYPAIR (default keypairs/mainnet-deployer.json) → owner / payer / signer
 *     (must equal vault.owner; once ownership is with Squads, propose update_vault
 *     there instead)
 *   --house                       → new house_authority (base58 pubkey)
 *   SOLANA_MAINNET_RPC            → required, no devnet default
 *
 * Idempotent: skips the call if the vault's house_authority already equals it.
 *
 * Order for a key rotation: set the new HOUSE_SECRET_KEY on kaboom-web and
 * this update in the same window — every house-signed tx (settle, refunds,
 * the F3 force, LP auto-complete) is rejected (6007) while they disagree, and
 * the tick's vault-health pass alerts on the mismatch.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { buildUpdateVault, decodeVault, deriveVaultPda } from "@playkaboom/sdk";
import { KABOOM_PROGRAM_ID } from "@playkaboom/shared";

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
  const programId = new PublicKey(KABOOM_PROGRAM_ID);
  const i = process.argv.indexOf("--house");
  if (i < 0 || !process.argv[i + 1]) throw new Error("--house <NEW_HOUSE_PUBKEY> is required");
  const newHouse = new PublicKey(process.argv[i + 1]!);
  const rpc = envOrThrow("SOLANA_MAINNET_RPC");

  const owner = loadKeypair(resolve(process.cwd(), process.env.OWNER_KEYPAIR ?? "keypairs/mainnet-deployer.json"));

  console.log("─ Rotate house_authority ─");
  console.log("  RPC host :", new URL(rpc).host); // the URL carries an API key
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
