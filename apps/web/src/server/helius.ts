import "server-only";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import WebSocket from "ws";
import { heliusSenderUrl, heliusWsUrl, jitoTipLamports } from "./env";
import { logger } from "./logger";

/**
 * Sender + signatureSubscribe path for house-signed txs.
 *
 * Why these instead of `connection.sendRawTransaction` + polling:
 *   - Sender fans out to staked SWQoS connections (and optionally Jito) from
 *     7 regions; landing latency drops from 2-4s to ~400-800ms during
 *     congestion. SWQoS-only mode requires no API key on Free.
 *   - signatureSubscribe over WS pushes confirmation as soon as it lands
 *     instead of polling every 400ms with `getSignatureStatuses`.
 */

// Standard Jito tip accounts. Sender accepts a transfer to any of these.
// https://docs.jito.wtf/lowlatencytxnsend/#tip-amount
const JITO_TIP_ACCOUNTS = [
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

export function buildJitoTipIx(payer: PublicKey): TransactionInstruction {
  const dest = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(dest),
    lamports: jitoTipLamports(),
  });
}

/** Submit a base64-encoded signed tx via Helius Sender. Returns the signature. */
export async function sendViaSender(signedTxBase64: string): Promise<string> {
  const res = await fetch(heliusSenderUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "kaboom-house-tx",
      method: "sendTransaction",
      params: [signedTxBase64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
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

/**
 * Subscribe to a signature on Helius WS, await confirmation, close.
 *
 * Caller passes the signature already in hand (after local sign) so we can
 * subscribe BEFORE submitting and avoid the race where the tx confirms
 * before the sub registers.
 *
 * On Free plan we get 5 concurrent WS connections globally; each in-flight
 * confirm uses 1 for the duration (~400ms-2s). Plenty of headroom for
 * current scale; upgrade path is the Railway worker holding 1 multiplexed.
 */
export async function awaitSignatureConfirmation(
  signature: string,
  opts: { commitment?: "processed" | "confirmed" | "finalized"; timeoutMs?: number } = {},
): Promise<{ slot: number; err: unknown }> {
  const url = heliusWsUrl();
  if (!url) throw new Error("HELIUS_API_KEY not set; WS confirmation unavailable");
  const commitment = opts.commitment ?? "confirmed";
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`signatureSubscribe timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "signatureSubscribe",
          params: [signature, { commitment }],
        }),
      );
    });

    ws.on("message", (raw) => {
      let msg: { method?: string; params?: { result?: { value?: { err: unknown }; slot?: number } } };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method !== "signatureNotification") return;
      const value = msg.params?.result?.value;
      const slot = msg.params?.result?.slot ?? 0;
      clearTimeout(timer);
      cleanup();
      if (value?.err) {
        reject(new Error(`tx failed on chain: ${JSON.stringify(value.err)}`));
      } else {
        resolve({ slot, err: null });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      logger.warn({ err: err.message, signature }, "ws confirm error");
      reject(err);
    });

    ws.on("close", () => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error("ws closed before confirmation"));
      }
    });
  });
}
