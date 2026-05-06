/**
 * Create a 2-of-2 Squads V4 multisig on devnet.
 *
 *   npx tsx scripts/create-devnet-squads.ts
 *
 * Reads:
 *   ~/.config/solana/id.json                       → owner / creator / member 1
 *   keypairs/squads-cosigner-devnet.json (auto-generated if absent) → member 2
 *   keypairs/squads-create-key-devnet.json (auto-generated)         → ephemeral createKey for PDA derivation
 *
 * Writes:
 *   keypairs/squads-devnet.json                    → { multisigPda, vaultPda, members[], threshold, createKey }
 *
 * Idempotent: if `keypairs/squads-devnet.json` already exists with a multisig PDA that
 * deserialises on-chain, the script just prints the existing addresses and exits.
 *
 * Uses Squads V4 program at SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf (deployed on devnet).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const { Permissions } = multisig.types;
const SQUADS_DEVNET_RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const KEYPAIRS_DIR = resolve(process.cwd(), "keypairs");
const COSIGNER_PATH = resolve(KEYPAIRS_DIR, "squads-cosigner-devnet.json");
const CREATEKEY_PATH = resolve(KEYPAIRS_DIR, "squads-create-key-devnet.json");
const OUT_PATH = resolve(KEYPAIRS_DIR, "squads-devnet.json");

function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function loadOrCreateKeypair(path: string, label: string): Keypair {
  if (existsSync(path)) {
    return loadKeypair(path);
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  generated new ${label} → ${path}`);
  return kp;
}

async function main() {
  const owner = loadKeypair(resolve(homedir(), ".config/solana/id.json"));
  const cosigner = loadOrCreateKeypair(COSIGNER_PATH, "devnet cosigner");
  const createKey = loadOrCreateKeypair(CREATEKEY_PATH, "createKey");

  const conn = new Connection(SQUADS_DEVNET_RPC, "confirmed");

  console.log("─ Squads devnet 2-of-2 setup ─");
  console.log("  RPC      :", SQUADS_DEVNET_RPC);
  console.log("  Member 1 :", owner.publicKey.toBase58(), "(also creator + payer)");
  console.log("  Member 2 :", cosigner.publicKey.toBase58());
  console.log("  CreateKey:", createKey.publicKey.toBase58());

  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

  console.log("\n  Multisig PDA :", multisigPda.toBase58());
  console.log("  Vault PDA    :", vaultPda.toBase58(), "(this is where funds sit and which signs txs)");

  const existing = await conn.getAccountInfo(multisigPda, "confirmed");
  if (existing) {
    console.log("\n✓ Multisig already exists on-chain. Skipping creation.");
    persistOutput({
      multisigPda: multisigPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      createKey: createKey.publicKey.toBase58(),
      members: [owner.publicKey.toBase58(), cosigner.publicKey.toBase58()],
      threshold: 2,
      programId: multisig.PROGRAM_ID.toBase58(),
      cluster: "devnet",
    });
    return;
  }

  const ownerBal = await conn.getBalance(owner.publicKey);
  console.log("\n  Creator SOL:", (ownerBal / LAMPORTS_PER_SOL).toFixed(4));
  if (ownerBal < 0.05 * LAMPORTS_PER_SOL) {
    throw new Error("Creator wallet has < 0.05 SOL — top up before continuing.");
  }

  const programConfigPda = multisig.getProgramConfigPda({})[0];
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    conn,
    programConfigPda,
  );
  const configTreasury = programConfig.treasury;
  console.log("  Squads program treasury (devnet):", configTreasury.toBase58());

  console.log("\nCreating multisig…");
  const sig = await multisig.rpc.multisigCreateV2({
    connection: conn,
    createKey,
    creator: owner,
    multisigPda,
    configAuthority: null,         // null = members can change config via on-chain proposals (not external authority)
    timeLock: 0,
    members: [
      { key: owner.publicKey, permissions: Permissions.all() },
      { key: cosigner.publicKey, permissions: Permissions.all() },
    ],
    threshold: 2,
    rentCollector: null,
    treasury: configTreasury,
    sendOptions: { skipPreflight: false, preflightCommitment: "confirmed" },
  });
  console.log("  sig:", sig);
  await conn.confirmTransaction(sig, "confirmed");

  const created = await conn.getAccountInfo(multisigPda, "confirmed");
  if (!created) throw new Error("Multisig PDA still missing after create");

  console.log("\n✓ Multisig created");
  console.log("\nNext steps:");
  console.log("  1. Fund the Vault PDA so it has rent buffer + SOL for fees:");
  console.log(`       solana transfer ${vaultPda.toBase58()} 0.05 --url devnet \\`);
  console.log(`         --keypair ~/.config/solana/id.json --allow-unfunded-recipient`);
  console.log("  2. Use", vaultPda.toBase58(), "as the rotation target for treasury + owner.");

  persistOutput({
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    createKey: createKey.publicKey.toBase58(),
    members: [owner.publicKey.toBase58(), cosigner.publicKey.toBase58()],
    threshold: 2,
    programId: multisig.PROGRAM_ID.toBase58(),
    cluster: "devnet",
  });
}

function persistOutput(record: Record<string, unknown>) {
  writeFileSync(OUT_PATH, JSON.stringify(record, null, 2) + "\n");
  console.log(`\n  wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("create-devnet-squads failed:", err);
  process.exit(1);
});
