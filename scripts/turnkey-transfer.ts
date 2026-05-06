/**
 * Sign a system transfer with the Turnkey HSM wallet (house_authority).
 *
 *   AMOUNT_SOL=4 RECIPIENT=DbR1... \
 *     npx tsx --env-file=apps/web/.env.local scripts/turnkey-transfer.ts
 *
 * Used when devnet airdrops are rate-limited and we need to move SOL
 * out of the Turnkey float into the owner wallet for program upgrade rent.
 */
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function main() {
  const orgId = envOrThrow("TURNKEY_ORG_ID");
  const apiPublicKey = envOrThrow("TURNKEY_API_PUBLIC_KEY");
  const apiPrivateKey = envOrThrow("TURNKEY_API_PRIVATE_KEY");
  const housePubkeyStr = envOrThrow("TURNKEY_HOUSE_PUBKEY");
  const recipient = new PublicKey(envOrThrow("RECIPIENT"));
  const amountSol = parseFloat(envOrThrow("AMOUNT_SOL"));
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error("AMOUNT_SOL must be a positive number");
  }
  const lamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

  const housePubkey = new PublicKey(housePubkeyStr);
  console.log("─ Turnkey transfer ─");
  console.log("  From   :", housePubkeyStr);
  console.log("  To     :", recipient.toBase58());
  console.log("  Amount :", amountSol, "SOL");
  console.log("  RPC    :", rpc);

  const tk = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: orgId,
  });
  const signer = new TurnkeySigner({ organizationId: orgId, client: tk.apiClient() });

  const conn = new Connection(rpc, "confirmed");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: housePubkey,
      toPubkey: recipient,
      lamports: Number(lamports),
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = housePubkey;

  console.log("\nSigning via Turnkey…");
  const signed = (await signer.signTransaction(tx, housePubkeyStr)) as Transaction;
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("  sig:", sig);
  console.log("\n✓ Transfer confirmed");
}

main().catch((err) => {
  console.error("turnkey-transfer failed:", err);
  process.exit(1);
});
