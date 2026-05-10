import "server-only";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { heliusApiKey, programId } from "./env";
import { getConnection } from "./connection";
import { getHouseSigner } from "./turnkey-signer";
import { deriveGamePda } from "@playkaboom/sdk";
import { logger } from "./logger";
import { awaitSignatureConfirmation, buildJitoTipIx, sendViaSender } from "./helius";

const COMPUTE_PRICE_MICROLAMPORTS = 5_000;
const COMPUTE_LIMIT = 200_000;

/**
 * Sends a house-signed transaction.
 *
 * Path when HELIUS_API_KEY is set (production):
 *   - Bundle a small Jito tip ix so the tx is eligible for Helius Sender's
 *     SWQoS-only routing (~$0.001 per tx at $200/SOL).
 *   - Submit via `sender.helius-rpc.com/fast` — fans out to staked
 *     connections from 7 regions; landing latency ~400-800ms vs 2-4s
 *     naive sendRawTransaction during congestion.
 *   - Confirm via signatureSubscribe WS — pushes the notification as soon
 *     as the slot lands, no 400ms polling jitter. WS limit is 5
 *     concurrent on free tier; current scale uses far less.
 *   - Falls back to RPC polling on WS timeout for resilience.
 *
 * Without HELIUS_API_KEY (local dev) it falls back to plain
 * `sendRawTransaction` + a short status poll.
 */
export async function sendHouseTx(instructions: TransactionInstruction[]): Promise<string> {
  const conn = getConnection();
  const house = getHouseSigner();
  const useHelius = !!heliusApiKey();

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_PRICE_MICROLAMPORTS }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT }));
  for (const ix of instructions) tx.add(ix);
  if (useHelius) {
    // Sender requires a Jito tip transfer in the same tx — house pays it.
    tx.add(buildJitoTipIx(house.publicKey));
  }

  // `processed` blockhash is canonical-enough for our use and lands on the
  // leader's first response (~150-200ms saved vs `confirmed`).
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = house.publicKey;

  const signed = await house.signTransaction(tx);

  if (useHelius) {
    const sig = await sendViaSender(signed.serialize().toString("base64"));
    logger.debug({ sig }, "house tx submitted via Helius Sender");
    try {
      await awaitSignatureConfirmation(sig, { commitment: "confirmed", timeoutMs: 10_000 });
      logger.debug({ sig }, "ws confirm received");
    } catch (err) {
      // WS path failed — fall back to a brief status poll. Don't throw if
      // the tx may still land; the caller can re-poll via inline-ingest.
      logger.warn(
        { sig, err: (err as Error).message },
        "ws confirm failed, falling back to status poll",
      );
      await pollStatus(sig, 5_000);
    }
    return sig;
  }

  // Fallback path (no Helius key): legacy RPC send.
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "processed",
  });
  logger.debug({ sig }, "house tx submitted via RPC");
  return sig;
}

/** Cheap RPC fallback: poll getSignatureStatuses for up to `timeoutMs`. */
async function pollStatus(signature: string, timeoutMs: number): Promise<void> {
  const conn = getConnection();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    if (status?.err) throw new Error(`tx failed: ${JSON.stringify(status.err)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

export async function playerHasActiveGame(player: PublicKey): Promise<boolean> {
  const [pda] = deriveGamePda(programId(), player);
  const info = await getConnection().getAccountInfo(pda, "confirmed");
  return info !== null;
}
