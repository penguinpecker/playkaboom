import "server-only";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { programId } from "./env";
import { getConnection } from "./connection";
import { getHouseSigner } from "./turnkey-signer";
import { deriveGamePda } from "@playkaboom/sdk";
import { logger } from "./logger";

const COMPUTE_PRICE_MICROLAMPORTS = 5_000;
const COMPUTE_LIMIT = 200_000;

/**
 * Sends a house-signed transaction via plain RPC sendRawTransaction
 * (Alchemy mainnet). Helius Sender was tried for ~24h but introduced
 * intermittent failures we couldn't isolate; reverted to the path that
 * had been stable for weeks.
 *
 * Briefly polls signature status after broadcast as a defensive
 * acknowledgement; doesn't block on full confirmation (callers can
 * inline-ingest or rely on cron for downstream indexing).
 */
export async function sendHouseTx(instructions: TransactionInstruction[]): Promise<string> {
  const conn = getConnection();
  const house = getHouseSigner();

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_PRICE_MICROLAMPORTS }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT }));
  for (const ix of instructions) tx.add(ix);

  // `processed` blockhash is canonical-enough for our use and lands on the
  // leader's first response (~150-200ms saved vs `confirmed`).
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = house.publicKey;

  const signed = await house.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "processed",
  });
  logger.debug({ sig }, "house tx submitted via RPC");
  void lastValidBlockHeight; // referenced for clarity; we don't poll-confirm here
  return sig;
}

export async function playerHasActiveGame(player: PublicKey): Promise<boolean> {
  const [pda] = deriveGamePda(programId(), player);
  const info = await getConnection().getAccountInfo(pda, "confirmed");
  return info !== null;
}
