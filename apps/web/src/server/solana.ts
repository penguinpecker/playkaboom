import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { houseAuthority, programId } from "./env";
import { getConnection } from "./connection";
import { deriveGamePda } from "@playkaboom/sdk";
import { logger } from "./logger";

const COMPUTE_PRICE_MICROLAMPORTS = 5_000;
const COMPUTE_LIMIT = 200_000;

/**
 * Sends a house-signed transaction. Does NOT poll — Vercel/Lambda timeouts
 * make polling expensive. Caller can confirm asynchronously if needed.
 */
export async function sendHouseTx(instructions: TransactionInstruction[]): Promise<string> {
  const conn = getConnection();
  const house = houseAuthority();
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_PRICE_MICROLAMPORTS }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT }));
  for (const ix of instructions) tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = house.publicKey;
  tx.sign(house);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });
  logger.debug({ sig }, "house tx submitted");
  return sig;
}

export async function playerHasActiveGame(player: PublicKey): Promise<boolean> {
  const [pda] = deriveGamePda(programId(), player);
  const info = await getConnection().getAccountInfo(pda, "confirmed");
  return info !== null;
}
