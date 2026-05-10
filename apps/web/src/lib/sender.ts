import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

/**
 * Browser-side Helius Sender helpers for player-signed txs (start_game,
 * close_game, refund_expired). Server has its own version in
 * `apps/web/src/server/helius.ts` for house txs.
 *
 * Sender (https://sender.helius-rpc.com/fast?swqos_only=true) needs no API
 * key on Free tier and lands txs through staked SWQoS connections from 7
 * regions — typical landing latency drops from 2-4s to ~400-800ms during
 * congestion. The trade-off is a ~5000-lamport (~$0.001 at $200/SOL) Jito
 * tip per tx, paid by whoever is the fee payer.
 */

const SENDER_URL = "https://sender.helius-rpc.com/fast?swqos_only=true";
const TIP_LAMPORTS = 5_000;

// Standard Jito tip accounts (mirror server-side helius.ts).
const TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

/** Build a Jito tip transfer ix for the given fee payer. */
export function buildJitoTipIx(payer: PublicKey): TransactionInstruction {
  const dest = TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]!;
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(dest),
    lamports: TIP_LAMPORTS,
  });
}

/** POST a serialized tx to Helius Sender. Returns the signature. */
export async function sendViaSender(serialized: Uint8Array): Promise<string> {
  // Convert to base64 for the JSON-RPC `encoding: "base64"` mode. Browser
  // has no Buffer; build it via btoa over a string conversion that's safe
  // for binary payloads.
  let binary = "";
  for (const b of serialized) binary += String.fromCharCode(b);
  const base64 = btoa(binary);

  const res = await fetch(SENDER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "kaboom-player-tx",
      method: "sendTransaction",
      params: [base64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Sender HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(`Sender RPC: ${body.error.message ?? "unknown"}`);
  if (!body.result) throw new Error("Sender returned no signature");
  return body.result;
}
