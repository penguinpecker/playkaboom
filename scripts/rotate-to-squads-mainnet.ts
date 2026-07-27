/**
 * Phase D1 — atomic deployer-signed rotation prep on MAINNET.
 *
 *   DRY_RUN=1 npx tsx scripts/rotate-to-squads-mainnet.ts   # preview
 *   npx tsx scripts/rotate-to-squads-mainnet.ts             # send
 *
 * Bundles 3 ixs into ONE atomic tx so the rotation can't end up half-applied:
 *   1. update_vault(newTreasury = Squads vault PDA)
 *   2. allowlist_add(Squads vault PDA) — so Squads can withdraw later
 *   3. propose_owner(Squads vault PDA) — sets vault.pending_owner
 *
 * After this tx lands, the Squads UI flow takes over to call accept_ownership.
 * Phase D3 (transfer BPF upgrade authority) is a separate solana-cli command.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  buildAllowlistAdd,
  buildProposeOwner,
  buildUpdateVault,
  decodeVault,
  deriveVaultPda,
} from "@playkaboom/sdk";

const PROGRAM_ID = new PublicKey("9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh");
const SQUADS_VAULT = new PublicKey("464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5");
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

  console.log("─ Phase D1 — rotate to Squads (atomic 3-ix tx) ─");
  console.log("  Program       :", PROGRAM_ID.toBase58());
  console.log("  Deployer      :", deployer.publicKey.toBase58());
  console.log("  Squads vault  :", SQUADS_VAULT.toBase58());
  console.log("  PlayKaboom Vault:", vaultPda.toBase58());

  const info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!info) throw new Error("vault PDA not found — run init-vault-mainnet.ts first");
  const vault = decodeVault(info.data);
  console.log("\n  Pre-state:");
  console.log("    owner          :", vault.owner.toBase58());
  console.log("    treasury       :", vault.treasury.toBase58());
  console.log("    pending_owner  :", vault.pendingOwner?.toBase58() ?? "none");
  console.log("    allowlist count:", vault.allowlistCount);
  console.log("    allowlist      :", vault.withdrawAllowlist.slice(0, vault.allowlistCount).map(k => k.toBase58()));

  if (!vault.owner.equals(deployer.publicKey)) {
    throw new Error(`vault.owner (${vault.owner.toBase58()}) is not the deployer — has rotation already happened?`);
  }

  const ixs = [
    buildUpdateVault({ ctx: { programId: PROGRAM_ID }, owner: deployer.publicKey, newTreasury: SQUADS_VAULT }),
    buildAllowlistAdd({ ctx: { programId: PROGRAM_ID }, owner: deployer.publicKey, address: SQUADS_VAULT }),
    buildProposeOwner({ ctx: { programId: PROGRAM_ID }, owner: deployer.publicKey, newOwner: SQUADS_VAULT }),
  ];

  console.log("\n  Building tx with 3 ixs (atomic):");
  console.log("    1. update_vault(newTreasury=", SQUADS_VAULT.toBase58().slice(0, 12) + "…)");
  console.log("    2. allowlist_add(", SQUADS_VAULT.toBase58().slice(0, 12) + "…)");
  console.log("    3. propose_owner(", SQUADS_VAULT.toBase58().slice(0, 12) + "…)");

  if (dryRun) {
    console.log("\n  DRY_RUN=1 — not sending.");
    return;
  }

  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = deployer.publicKey;
  tx.sign(deployer);

  console.log("\n  Sending …");
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("  Sig:", sig);

  // Poll-based confirm (Alchemy doesn't expose signatureSubscribe over WS).
  const deadline = Date.now() + 90_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const status = value?.[0];
    if (status?.err) throw new Error("rotation failed: " + JSON.stringify(status.err));
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      confirmed = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!confirmed) throw new Error("not confirmed within 90s — check sig manually");
  console.log("  Confirmed ✓");

  const after = decodeVault((await conn.getAccountInfo(vaultPda, "confirmed"))!.data);
  console.log("\n  Post-state:");
  console.log("    owner          :", after.owner.toBase58());
  console.log("    treasury       :", after.treasury.toBase58());
  console.log("    pending_owner  :", after.pendingOwner?.toBase58() ?? "none");
  console.log("    allowlist count:", after.allowlistCount);
  console.log("    allowlist      :", after.withdrawAllowlist.slice(0, after.allowlistCount).map(k => k.toBase58()));

  console.log("\n→ Next: do the Squads UI step to accept ownership (Phase D2).");
}

main().catch((err) => {
  console.error("\n✗ rotate-to-squads-mainnet failed:", err.message ?? err);
  process.exit(1);
});
