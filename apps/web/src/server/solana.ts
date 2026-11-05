import "server-only";
import {
  ComputeBudgetProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { programId } from "./env";
import { getConnection, getErConnection } from "./connection";
import { getHouseSigner } from "./house-signer";
import { extractAnchorFrameworkError, isAccountNotInitializedError } from "@playkaboom/sdk";
import { logger } from "./logger";
import { assertTickLockHeld } from "./cron/tick";

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
export async function sendHouseTx(
  instructions: TransactionInstruction[],
): Promise<string> {
  await assertTickLockHeld(); // a cron pass whose lock was lost must not send
  const conn = getConnection();
  const house = getHouseSigner();
  const priceMicroLamports = await computePriorityFee();

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priceMicroLamports }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT }));
  for (const ix of instructions) tx.add(ix);

  // `confirmed` blockhash + preflight: a `processed` blockhash can be unknown
  // to the RPC node that runs the simulation (load-balanced RPC), which fails
  // preflight with EMPTY logs ("Blockhash not found") — that made
  // /api/vrf/settle 500 right after an undelegate (2026-11-05). Retry that
  // transient case with a fresh blockhash; program errors (non-empty logs)
  // are thrown on the first attempt.
  tx.feePayer = house.publicKey;
  for (let attempt = 0; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.signatures = [];
    const signed = await house.signTransaction(tx);
    try {
      const sig = await conn.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: "confirmed",
      });
      logger.debug({ sig }, "house tx submitted via RPC");
      return sig;
    } catch (err) {
      if (attempt < 2 && isTransientPreflightError(err)) {
        logger.warn({ attempt, err: (err as Error).message?.slice(0, 160) }, "house tx preflight transient; retrying");
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      throw classifyHouseTxError(err);
    }
  }
}

/** Preflight failed before the program ran: no logs, or an explicit blockhash miss. */
function isTransientPreflightError(err: unknown): boolean {
  const e = err as { message?: string; logs?: string[] | null; transactionLogs?: string[] | null } | null;
  const msg = e?.message ?? "";
  if (/blockhash not found|BlockhashNotFound/i.test(msg)) return true;
  const logs = e?.logs ?? e?.transactionLogs;
  return /simulation failed/i.test(msg) && (!logs || logs.length === 0) && /Logs:\s*\n?\s*\[\]/.test(msg);
}

function classifyHouseTxError(err: unknown): unknown {
  {
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
      return new OnChainError("account_not_initialized", {
        message: `On-chain account not initialized${fw?.account ? `: ${fw.account}` : ""}`,
        code: fw?.code,
        account: fw?.account,
        logs: (err as { logs?: string[] } | null)?.logs,
        cause: err,
      });
    }
    return err;
  }
}

/**
 * House-signed transaction on the MagicBlock ephemeral rollup (F3 force pass).
 * No compute-budget instructions and no priority fee: the ER has neither fee
 * market nor `getRecentPrioritizationFees`. Blockhash comes from the ER itself.
 * Preflight on, so a deterministic failure (6044 pending, 6007) throws here.
 */
export async function sendHouseErTx(instructions: TransactionInstruction[]): Promise<string> {
  await assertTickLockHeld();
  const conn = getErConnection();
  const house = getHouseSigner();
  const tx = new Transaction();
  for (const ix of instructions) tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = house.publicKey;
  const signed = await house.signTransaction(tx);
  return conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
}

/**
 * Poll until `sig` is confirmed. Returns true on confirmed/finalized, false on
 * an on-chain error or when `timeoutMs` passes (dropped or still in flight).
 */
export async function waitConfirmed(
  sig: string,
  timeoutMs = 30_000,
  conn = getConnection(),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
    if (st?.err) return false;
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
