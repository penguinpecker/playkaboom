/**
 * Phase E2 — initialize_v2 on MAINNET (deployer-signed, single tx).
 *
 *   DRY_RUN=1 npx tsx scripts/init-v2-mainnet.ts   # preview
 *   npx tsx scripts/init-v2-mainnet.ts             # send
 *
 * Requires vault to hold ≥1 SOL (anti-inflation seed). Sets up VaultV2State
 * PDA with default Phase 2 config. Deployer (current owner) signs.
 *
 * Default config (per program defaults):
 *   min_house_share_bps     = 5000  (50%)
 *   max_user_position_bps   = 1000  (10%)
 *   min_health_bps          = 1000  (10%)
 *   withdraw_cooldown_slots = 648000 (~3 days @ 400ms slots)
 *   min_lp_deposit          = 10_000_000 (0.01 SOL)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { buildInitializeV2, deriveV2StatePda, deriveVaultPda } from "@playkaboom/sdk";

const PROGRAM_ID = new PublicKey("9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh");
const RPC = "https://solana-mainnet.g.alchemy.com/v2/-j7ptOh-PDq8Dzh8PqnQ-";
const DEPLOYER_PATH = "keypairs/mainnet-deployer.json";

function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main() {
  const dryRun = !!process.env.DRY_RUN;
  const deployer = loadKeypair(resolve(process.cwd(), DEPLOYER_PATH));
  const conn = new Connection(RPC, "confirmed");
  const [vaultPda] = deriveVaultPda(PROGRAM_ID);
  const [v2StatePda] = deriveV2StatePda(PROGRAM_ID);

  console.log("─ Phase E2 — initialize_v2 on MAINNET ─");
  console.log("  Program       :", PROGRAM_ID.toBase58());
  console.log("  Deployer/owner:", deployer.publicKey.toBase58());
  console.log("  Vault PDA     :", vaultPda.toBase58());
  console.log("  V2State PDA   :", v2StatePda.toBase58());

  const v2Existing = await conn.getAccountInfo(v2StatePda, "confirmed");
  if (v2Existing) {
    console.log("\n! V2State already initialized — aborting.");
    return;
  }

  const vaultBal = await conn.getBalance(vaultPda, "confirmed");
  console.log("  Vault balance :", (vaultBal / 1e9).toFixed(8), "SOL");
  if (vaultBal < 1_003_869_760) {
    throw new Error(`Vault has ${vaultBal} lamports — need >= 1 SOL above rent`);
  }

  const ix = buildInitializeV2({ ctx: { programId: PROGRAM_ID }, owner: deployer.publicKey });
  console.log("\n  Tx will create V2State (~0.002 SOL rent) + ~5000 lamports fee.");

  if (dryRun) {
    console.log("\n  DRY_RUN=1 — not sending.");
    return;
  }

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = deployer.publicKey;
  tx.sign(deployer);

  console.log("\n  Sending …");
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("  Sig:", sig);

  const deadline = Date.now() + 90_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const status = value?.[0];
    if (status?.err) throw new Error("init_v2 failed: " + JSON.stringify(status.err));
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      confirmed = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!confirmed) throw new Error("not confirmed within 90s");
  console.log("  Confirmed ✓");

  const after = await conn.getAccountInfo(v2StatePda, "confirmed");
  console.log("\n  V2State on chain ✓ — size:", after?.data.length, "bytes, lamports:", after?.lamports);
}

main().catch((err) => {
  console.error("\n✗ init-v2-mainnet failed:", err.message ?? err);
  process.exit(1);
});
