/**
 * One-shot Mines vault bootstrap.
 *
 *   PROGRAM_ID=<deployed pubkey> npx tsx scripts/init-vault.ts
 *
 * Sends three transactions, in order, idempotently:
 *   1. initialize_vault(houseEdgeBps=200, maxBetBps=200, maxPayoutBps=5000)
 *   2. fund_vault(FUND_LAMPORTS, default 2 SOL)
 *   3. allowlist_add(TREASURY_DEST, default = owner)
 *
 * Reads:
 *   ~/.config/solana/id.json        → owner / payer
 *   ./keypairs/house.json           → house authority
 *   PROGRAM_ID env                  → deployed program id
 *   RPC env (optional)              → defaults to devnet
 *   TREASURY env (optional pubkey)  → defaults to owner pubkey
 *   FUND_LAMPORTS env (optional)    → defaults to 2_000_000_000
 *
 * Safe to re-run: each step inspects on-chain state first.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  buildAllowlistAdd,
  buildFundVault,
  buildInitializeVault,
  decodeVault,
  deriveVaultPda,
} from "@playkaboom/sdk";

function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function send(
  conn: Connection,
  signers: Keypair[],
  ixs: ReturnType<typeof buildInitializeVault>[],
  label: string,
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value.err) {
    throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const rpc = process.env.RPC ?? "https://api.devnet.solana.com";
  const fundLamports = BigInt(process.env.FUND_LAMPORTS ?? "2000000000");

  const owner = loadKeypair(resolve(homedir(), ".config/solana/id.json"));
  const house = loadKeypair(resolve(process.cwd(), "keypairs/house.json"));
  const treasury = process.env.TREASURY
    ? new PublicKey(process.env.TREASURY)
    : owner.publicKey;

  const conn = new Connection(rpc, "confirmed");
  const [vaultPda] = deriveVaultPda(programId);

  console.log("─ PlayKaboom vault init ─");
  console.log("  RPC      :", rpc);
  console.log("  Program  :", programId.toBase58());
  console.log("  Owner    :", owner.publicKey.toBase58());
  console.log("  House    :", house.publicKey.toBase58());
  console.log("  Treasury :", treasury.toBase58());
  console.log("  Vault PDA:", vaultPda.toBase58());

  const ownerBal = await conn.getBalance(owner.publicKey);
  console.log("  Owner SOL:", (ownerBal / LAMPORTS_PER_SOL).toFixed(4));
  if (ownerBal < 3 * LAMPORTS_PER_SOL) {
    console.warn("  ! owner balance < 3 SOL — top up before continuing");
  }

  // 1. initialize_vault (skip if already on-chain)
  const existing = await conn.getAccountInfo(vaultPda, "confirmed");
  if (existing) {
    const decoded = decodeVault(existing.data);
    console.log("\n[1/3] initialize_vault: already initialized");
    console.log("       owner            =", decoded.owner.toBase58());
    console.log("       house_authority  =", decoded.houseAuthority.toBase58());
    console.log("       treasury         =", decoded.treasury.toBase58());
    console.log("       house_edge_bps   =", decoded.houseEdgeBps);
    console.log("       max_bet_bps      =", decoded.maxBetBps);
    console.log("       max_payout_bps   =", decoded.maxPayoutBps);
    console.log("       allowlist_count  =", decoded.allowlistCount);
  } else {
    const ix = buildInitializeVault({
      ctx: { programId },
      owner: owner.publicKey,
      houseAuthority: house.publicKey,
      treasury,
      houseEdgeBps: 200,
      maxBetBps: 200,
      maxPayoutBps: 5_000,
    });
    const sig = await send(conn, [owner], [ix], "initialize_vault");
    console.log("\n[1/3] initialize_vault sig:", sig);
  }

  // 2. fund_vault — top up to fundLamports if vault is short
  const vaultBalBefore = BigInt(await conn.getBalance(vaultPda, "confirmed"));
  if (vaultBalBefore >= fundLamports) {
    console.log(
      `\n[2/3] fund_vault: vault already at ${Number(vaultBalBefore) / LAMPORTS_PER_SOL} SOL ≥ target`,
    );
  } else {
    const need = fundLamports - vaultBalBefore;
    const fundIx = buildFundVault({
      ctx: { programId },
      funder: owner.publicKey,
      amount: need,
    });
    const sig = await send(conn, [owner], [fundIx], "fund_vault");
    console.log(
      `\n[2/3] fund_vault sig: ${sig} (${Number(need) / LAMPORTS_PER_SOL} SOL added)`,
    );
  }

  // 3. allowlist_add — only if treasury isn't already on it
  const refreshed = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!refreshed) throw new Error("vault disappeared after init");
  const vault = decodeVault(refreshed.data);
  const alreadyOn = vault.withdrawAllowlist
    .slice(0, vault.allowlistCount)
    .some((k) => k.equals(treasury));
  if (alreadyOn) {
    console.log("\n[3/3] allowlist_add: treasury already allowlisted");
  } else {
    const ix = buildAllowlistAdd({
      ctx: { programId },
      owner: owner.publicKey,
      address: treasury,
    });
    const sig = await send(conn, [owner], [ix], "allowlist_add");
    console.log("\n[3/3] allowlist_add sig:", sig);
  }

  const finalBal = await conn.getBalance(vaultPda, "confirmed");
  console.log("\n✓ Vault ready");
  console.log("  Vault PDA balance:", (finalBal / LAMPORTS_PER_SOL).toFixed(4), "SOL");
}

main().catch((err) => {
  console.error("init-vault failed:", err);
  process.exit(1);
});
