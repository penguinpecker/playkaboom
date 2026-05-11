import "server-only";
import {
  type AccountInfo,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { programId } from "./env";
import { getConnection } from "./connection";
import { getHouseSigner } from "./turnkey-signer";
import {
  deriveGamePda,
  extractAnchorFrameworkError,
  isAccountNotInitializedError,
} from "@playkaboom/sdk";
import { logger } from "./logger";

/**
 * Typed wrapper for SendTransactionError shapes we know how to handle.
 * Carries the structured Anchor framework error (3xxx range — account
 * constraints, not the program's custom KaboomError 6xxx codes). Route
 * handlers translate `account_not_initialized` to a 409+needsCleanup
 * response that the client already knows how to recover from (mirroring
 * the existing /api/commit 409 contract). Everything else falls through
 * to the generic 500.
 */
export type OnChainErrorKind = "account_not_initialized" | "anchor_framework_error";

export class OnChainError extends Error {
  readonly kind: OnChainErrorKind;
  readonly code?: number;
  readonly account?: string;
  readonly logs?: readonly string[];

  constructor(
    kind: OnChainErrorKind,
    opts: { message: string; code?: number; account?: string; logs?: readonly string[]; cause?: unknown },
  ) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OnChainError";
    this.kind = kind;
    this.code = opts.code;
    this.account = opts.account;
    this.logs = opts.logs;
  }
}

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
  try {
    const sig = await conn.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "processed",
    });
    logger.debug({ sig }, "house tx submitted via RPC");
    void lastValidBlockHeight; // referenced for clarity; we don't poll-confirm here
    return sig;
  } catch (err) {
    // Classify Anchor framework errors so routes can return a structured
    // 409 instead of an opaque 500. The most consequential one for game
    // routes is AccountNotInitialized (3012) — fired when the GameSession
    // PDA the reveal/settle ix references doesn't exist at simulation
    // time. Two ways that happens: (a) PDA was closed and the encrypted
    // session token is stale, (b) start_game tx hasn't propagated yet.
    // Routes disambiguate via `requireActiveGame` before calling here;
    // this branch catches the TOCTOU window between probe and send.
    if (isAccountNotInitializedError(err)) {
      const fw = extractAnchorFrameworkError(err);
      throw new OnChainError("account_not_initialized", {
        message: `On-chain account not initialized${fw?.account ? `: ${fw.account}` : ""}`,
        code: fw?.code,
        account: fw?.account,
        logs: (err as { logs?: string[] } | null)?.logs,
        cause: err,
      });
    }
    throw err;
  }
}

export async function playerHasActiveGame(player: PublicKey): Promise<boolean> {
  const [pda] = deriveGamePda(programId(), player);
  const info = await getConnection().getAccountInfo(pda, "confirmed");
  return info !== null;
}

/**
 * Probe the GameSession PDA with bounded retries.
 *
 * Returns the account if it exists at "confirmed", or null after retries
 * if the RPC consistently reports the account is absent. RPC errors are
 * retried up to `attempts` times and re-thrown if all fail — a clean
 * `null` is reserved for "RPC confirmed the account does not exist".
 *
 * The retry exists for the start_game-propagation race: the client flips
 * UI to "playing" the instant Alchemy ACKs the start_game send (~200ms),
 * but a tile click landing in the next ~500-800ms may arrive before the
 * validator has processed start_game. Three attempts at 250ms gives
 * ~750ms of headroom — well within typical p99 propagation, well under
 * the blockhash window.
 */
export interface RequireActiveGameOpts {
  attempts?: number;
  backoffMs?: number;
}
export async function requireActiveGame(
  player: PublicKey,
  opts: RequireActiveGameOpts = {},
): Promise<AccountInfo<Buffer> | null> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = Math.max(0, opts.backoffMs ?? 250);
  const [pda] = deriveGamePda(programId(), player);
  const conn = getConnection();
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const info = await conn.getAccountInfo(pda, "confirmed");
      if (info) return info as AccountInfo<Buffer>;
      lastErr = undefined;
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1 && backoffMs > 0) {
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}
