/**
 * Mainnet vault bootstrap — minimal one-tx initialize_vault.
 *
 *   DRY_RUN=1 npx tsx scripts/init-vault-mainnet.ts   # preview
 *   npx tsx scripts/init-vault-mainnet.ts             # send
 *
 * Sends a single tx: initialize_vault with deployer as owner+treasury,
 * Turnkey HSM as house_authority. No fund_vault, no allowlist_add — those
 * happen later (Phase D rotation + Phase E vault funding).
 *
 * Hard-coded mainnet inputs (auditable; no env-var tampering):
 *   PROGRAM         9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh
 *   DEPLOYER        keypairs/mainnet-deployer.json
 *   TURNKEY HOUSE   7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp
 *
 * The RPC endpoint is the ONE input that is deliberately NOT hard-coded: it
 * carries an API key, and this repo is public. Supply it via SOLANA_MAINNET_RPC.
 * Pinning the addresses above is what makes this script auditable — the RPC is
 * not a trust input, only a transport.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { buildInitializeVault, decodeVault, deriveVaultPda } from "@playkaboom/sdk";

const PROGRAM_ID = new PublicKey("9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh");
const TURNKEY_HOUSE = new PublicKey("7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp");
const RPC = process.env.SOLANA_MAINNET_RPC
  ?? (() => {
    throw new Error(
      "SOLANA_MAINNET_RPC is not set. This used to be a hardcoded Alchemy URL " +
      "with the key inline — in a PUBLIC repo, and still reachable in git history. " +
      "Export the endpoint instead: SOLANA_MAINNET_RPC=https://... (see docs/security/secrets.md)."
    );
  })();
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

  console.log("─ Phase C — initialize_vault on MAINNET ─");
  console.log("  Program       :", PROGRAM_ID.toBase58());
  console.log("  Deployer      :", deployer.publicKey.toBase58());
  console.log("  House (Turnkey):", TURNKEY_HOUSE.toBase58());
  console.log("  Treasury (temp):", deployer.publicKey.toBase58());
  console.log("  Vault PDA     :", vaultPda.toBase58());
  console.log("  Args          : houseEdgeBps=200, maxBetBps=200, maxPayoutBps=5000");

  const existing = await conn.getAccountInfo(vaultPda, "confirmed");
  if (existing) {
    const v = decodeVault(existing.data);
    console.log("\n! Vault already initialized — aborting.");
    console.log("  owner  :", v.owner.toBase58());
    console.log("  house  :", v.houseAuthority.toBase58());
    console.log("  treasury:", v.treasury.toBase58());
    return;
  }

  const ownerBal = await conn.getBalance(deployer.publicKey);
  console.log("  Deployer SOL  :", (ownerBal / 1e9).toFixed(6));

  const ix = buildInitializeVault({
    ctx: { programId: PROGRAM_ID },
    owner: deployer.publicKey,
    houseAuthority: TURNKEY_HOUSE,
    treasury: deployer.publicKey,
    houseEdgeBps: 200,
    maxBetBps: 200,
    maxPayoutBps: 5000,
  });

  console.log("\n  Tx will pay vault PDA rent (~0.004 SOL) + ~0.000005 SOL fee.");
  console.log("  Accounts in ix:");
  ix.keys.forEach((k, i) => {
    console.log(`    [${i}] ${k.pubkey.toBase58()} ${k.isWritable ? "W" : "r"}${k.isSigner ? "S" : "-"}`);
  });

  if (dryRun) {
    console.log("\n  DRY_RUN=1 set — not sending. Exiting.");
    return;
  }

  console.log("\n  Sending …");
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = deployer.publicKey;
  tx.sign(deployer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("  Sig (broadcast):", sig);

  // Poll-based confirm (Alchemy doesn't expose signatureSubscribe over WS).
  const deadline = Date.now() + 90_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const status = value?.[0];
    if (status?.err) throw new Error("init failed: " + JSON.stringify(status.err));
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      confirmed = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!confirmed) throw new Error("init not confirmed within 90s");
  console.log("  Confirmed ✓");

  const after = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!after) throw new Error("vault not visible after init");
  const v = decodeVault(after.data);
  console.log("\n  On-chain Vault state:");
  console.log("    owner    :", v.owner.toBase58());
  console.log("    house    :", v.houseAuthority.toBase58());
  console.log("    treasury :", v.treasury.toBase58());
  console.log("    bump     :", v.bump);
  console.log("    paused   :", v.paused);
}

main().catch((err) => {
  console.error("\n✗ init-vault-mainnet failed:", err.message ?? err);
  process.exit(1);
});
