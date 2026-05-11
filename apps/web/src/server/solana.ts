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

// Floor + ceiling for the priority fee. Floor is what we always pay (keeps
// landing rates predictable on quiet mainnet). Ceiling caps the most we'll
// ever spend per tx — at 200,000 CU * 50,000 µLamports = 10,000 lamports =
// ~$0.002 worst case. We pay min(ceiling, max(floor, p75 of recent fees)).
const COMPUTE_PRICE_FLOOR_MICROLAMPORTS = 5_000;
const COMPUTE_PRICE_CEILING_MICROLAMPORTS = 50_000;
const COMPUTE_LIMIT = 200_000;

/** Cached recent-fee snapshot so we don't hit getRecentPrioritizationFees on
 *  every single house tx — that RPC is slow (~150-300ms) and we batch many
 *  txs through this path. Refresh every 15s. */
let recentFeeCache: { microLamports: number; expiresAt: number } | null = null;

async function computePriorityFee(): Promise<number> {
  const now = Date.now();
  if (recentFeeCache && recentFeeCache.expiresAt > now) {
    return recentFeeCache.microLamports;
  }
  let priceMicroLamports = COMPUTE_PRICE_FLOOR_MICROLAMPORTS;
  try {
    const conn = getConnection();
    const fees = await conn.getRecentPrioritizationFees({
      lockedWritableAccounts: [programId()],
    });
    if (fees.length > 0) {
      // p75 of nonzero fees; falls back to floor if all are zero.
      const nonZero = fees
        .map((f) => f.prioritizationFee)
        .filter((v) => v > 0)
        .sort((a, b) => a - b);
      if (nonZero.length > 0) {
        const idx = Math.floor(nonZero.length * 0.75);
        const p75 = nonZero[idx] ?? nonZero[nonZero.length - 1] ?? 0;
        priceMicroLamports = p75;
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "[priority-fee] getRecentPrioritizationFees failed; using floor",
    );
  }
  // Clamp to [floor, ceiling].
  priceMicroLamports = Math.max(
    COMPUTE_PRICE_FLOOR_MICROLAMPORTS,
    Math.min(COMPUTE_PRICE_CEILING_MICROLAMPORTS, priceMicroLamports),
  );
  recentFeeCache = { microLamports: priceMicroLamports, expiresAt: now + 15_000 };
  return priceMicroLamports;
}

/**
 * Sends a house-signed transaction via plain RPC sendRawTransaction
 * (Alchemy mainnet). Helius Sender was tried for ~24h but introduced
 * intermittent failures we couldn't isolate; reverted to the path that
 * had been stable for weeks.
 *
 * Briefly polls signature status after broadcast as a defensive
 * acknowledgement; doesn't block on full confirmation (callers can
 * inline-ingest or rely on cron for downstream indexing).
 *
 * 2026-05-11: priority fee is now p75 of recent program-touching fees,
 * clamped to [5_000, 50_000] µLamports. Used to be a flat 5_000 which
 * caused settle/reveal drops during congestion. Worst-case spend bounded
 * at 10_000 lamports/tx (~$0.002).
 */
export async function sendHouseTx(instructions: TransactionInstruction[]): Promise<string> {
  const conn = getConnection();
  const house = getHouseSigner();
  const priceMicroLamports = await computePriorityFee();

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priceMicroLamports }));
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
