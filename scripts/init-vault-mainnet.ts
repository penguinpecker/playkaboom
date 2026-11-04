/**
 * Mainnet vault bootstrap — minimal one-tx initialize_vault (relaunch program).
 *
 *   DRY_RUN=1 npx tsx scripts/init-vault-mainnet.ts --house <HOUSE_PUBKEY>   # preview
 *   npx tsx scripts/init-vault-mainnet.ts --house <HOUSE_PUBKEY>             # send
 *
 * Sends a single tx: initialize_vault with the deployer as owner+treasury and
 * the house signer's PUBLIC key as house_authority. The house key is the raw
 * keypair the web server holds as HOUSE_SECRET_KEY; pass only its pubkey here
 * (e.g. `solana-keygen pubkey <file>`), never the secret. No fund_vault, no
 * allowlist_add — those happen later.
 *
 * Hard-coded mainnet inputs (auditable; no env-var tampering):
 *   PROGRAM    Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju
 *   DEPLOYER   keypairs/mainnet-deployer.json, must be qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG
 *              (F1: the program fails 6055 NotDeployer for any other owner)
 *
 * Preflight (read-only): the deployed program must already be the VRF-only
 * build (a simulated start_game must fail 6057 LegacyModeDisabled). Initializing
 * the vault on the earlier build would let commit-reveal games start with a raw
 * house key on the server, which is exactly what the VRF-only upgrade closes.
 *
 * The RPC endpoint is the ONE input that is deliberately NOT hard-coded: it
 * carries an API key, and this repo is public. Supply it via SOLANA_MAINNET_RPC.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { buildInitializeVault, buildStartGame, decodeVault, deriveVaultPda } from "@playkaboom/sdk";
import { KABOOM_DEPLOYER, KABOOM_PROGRAM_ID } from "@playkaboom/shared";

const PROGRAM_ID = new PublicKey(KABOOM_PROGRAM_ID);
const DEPLOYER = new PublicKey(KABOOM_DEPLOYER);

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const HOUSE = (() => {
  const raw = argValue("--house");
  if (!raw) throw new Error("--house <HOUSE_PUBKEY> is required (the public key of HOUSE_SECRET_KEY)");
  return new PublicKey(raw);
})();
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

/** True iff the deployed program rejects start_game with 6057 (VRF-only build). Read-only simulate. */
async function isVrfOnlyBuild(conn: Connection, feePayer: PublicKey): Promise<boolean> {
  const tx = new Transaction().add(
    buildStartGame({
      ctx: { programId: PROGRAM_ID },
      player: feePayer,
      mineCount: 1,
      betLamports: 1_000_000n,
      commitment: Buffer.alloc(32),
    }),
  );
  tx.feePayer = feePayer;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  const sim = await conn.simulateTransaction(tx);
  return JSON.stringify(sim.value.err ?? null).includes('"Custom":6057');
}

async function main() {
  const dryRun = !!process.env.DRY_RUN;
  const deployer = loadKeypair(resolve(process.cwd(), DEPLOYER_PATH));
  const conn = new Connection(RPC, "confirmed");
  const [vaultPda] = deriveVaultPda(PROGRAM_ID);

  console.log("─ initialize_vault on MAINNET ─");
  console.log("  Program       :", PROGRAM_ID.toBase58());
  console.log("  Deployer      :", deployer.publicKey.toBase58());
  console.log("  House signer  :", HOUSE.toBase58());
  if (!deployer.publicKey.equals(DEPLOYER)) {
    throw new Error(`${DEPLOYER_PATH} is ${deployer.publicKey.toBase58()}, not the F1 deployer ${DEPLOYER.toBase58()} (would fail 6055)`);
  }
  if (HOUSE.equals(deployer.publicKey)) throw new Error("--house must not be the deployer key");
  if (!(await isVrfOnlyBuild(conn, deployer.publicKey))) {
    throw new Error("deployed program is not the VRF-only build (start_game did not fail 6057): upgrade it first");
  }
  console.log("  Program build : VRF-only (start_game -> 6057) ✓");
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
    houseAuthority: HOUSE,
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
