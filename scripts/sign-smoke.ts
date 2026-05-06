/**
 * Turnkey signing smoke test.
 *
 *   npx tsx --env-file=apps/web/.env.local scripts/sign-smoke.ts
 *   # optionally:  SEND=1 npx tsx --env-file=apps/web/.env.local scripts/sign-smoke.ts
 *
 * Builds a no-op SPL Memo transaction, requests a Turnkey signature for the
 * configured house pubkey, and verifies the signature locally by calling
 * Transaction.serialize() (which fails if signatures are missing or invalid).
 *
 * Reads:
 *   TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY,
 *   TURNKEY_HOUSE_PUBKEY, SOLANA_RPC (defaults to devnet)
 *
 * SEND=1 also broadcasts the tx and confirms; this costs a fraction of a SOL
 * on whatever cluster SOLANA_RPC points at.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

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
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

  const housePubkey = new PublicKey(housePubkeyStr);

  console.log("─ Turnkey sign smoke ─");
  console.log("  Org ID  :", orgId);
  console.log("  House   :", housePubkeyStr);
  console.log("  RPC     :", rpc);

  const tk = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: orgId,
  });
  const signer = new TurnkeySigner({ organizationId: orgId, client: tk.apiClient() });

  const conn = new Connection(rpc, "confirmed");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  const memoIx = new TransactionInstruction({
    keys: [{ pubkey: housePubkey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(`playkaboom-turnkey-smoke-${Date.now()}`, "utf8"),
  });

  const tx = new Transaction();
  tx.add(memoIx);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = housePubkey;

  console.log("\nRequesting Turnkey signature…");
  const t0 = Date.now();
  const signed = (await signer.signTransaction(tx, housePubkeyStr)) as Transaction;
  const dur = Date.now() - t0;
  console.log(`  signed in ${dur} ms`);

  // serialize() throws if any required signature is missing or invalid.
  const raw = signed.serialize({ requireAllSignatures: true, verifySignatures: true });
  console.log("  signature verified locally ✓");
  console.log("  tx size :", raw.length, "bytes");
  const sigBase58 = signed.signatures
    .find((s) => s.publicKey.equals(housePubkey))
    ?.signature;
  if (sigBase58) {
    console.log("  sig (b64):", Buffer.from(sigBase58).toString("base64"));
  }

  if (process.env.SEND === "1") {
    console.log("\nBroadcasting…");
    const sig = await conn.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    console.log("  submitted:", sig);
    const conf = await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (conf.value.err) {
      throw new Error(`memo tx failed on chain: ${JSON.stringify(conf.value.err)}`);
    }
    console.log("  confirmed ✓");
  } else {
    console.log("\n(set SEND=1 to also broadcast to chain)");
  }

  console.log("\n✓ Turnkey signer is wired correctly");
}

main().catch((err) => {
  console.error("sign-smoke failed:", err);
  process.exit(1);
});
