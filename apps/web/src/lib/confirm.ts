import { type Connection } from "@solana/web3.js";

/**
 * Polling-based confirmation. Replaces `connection.confirmTransaction(...)`
 * because Alchemy's Solana RPC doesn't expose `signatureSubscribe` (the WS
 * method web3.js uses by default), which causes confirmTransaction to spin
 * until the blockhash expires.
 *
 * Strategy:
 *   - `getSignatureStatuses` every ~1 s. This is the cheap/idempotent path.
 *   - `getBlockHeight` every ~5 s to check expiry. (Slot advances faster than
 *     block-height because of skipped slots — using getSlot here gives false
 *     "expired" verdicts; getBlockHeight is the apples-to-apples compare.)
 *   - Treat any RPC error (429, 5xx, network) as transient: log, exponential
 *     backoff up to 4 s, and keep polling. The tx itself is the source of
 *     truth; we just keep asking until it lands or the wall-clock deadline.
 *   - Total deadline: 90 s. A pre-confirmation tx can live up to ~60-90 s on
 *     mainnet; longer than that is definitely abandoned.
 */
export async function confirmByPolling(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
  timeoutMs = 90_000,
): Promise<void> {
  const start = Date.now();
  let nextStatusAt = 0;
  let nextHeightAt = 0;
  let consecutiveErrors = 0;
  let backoffMs = 0;

  while (true) {
    const now = Date.now();
    if (now - start > timeoutMs) {
      throw new Error(`tx ${signature} confirmation timeout after ${timeoutMs}ms`);
    }

    if (now >= nextStatusAt) {
      try {
        const { value } = await connection.getSignatureStatuses([signature]);
        const s = value[0];
        if (s?.err) {
          throw new Error(`tx ${signature} failed: ${JSON.stringify(s.err)}`);
        }
        if (
          s &&
          (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")
        ) {
          return;
        }
        consecutiveErrors = 0;
        backoffMs = 0;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(`tx ${signature} failed`)) {
          throw err;
        }
        consecutiveErrors++;
        backoffMs = Math.min(4_000, 250 * 2 ** Math.min(consecutiveErrors, 4));
      }
      nextStatusAt = Date.now() + 1_000 + backoffMs;
    }

    if (now >= nextHeightAt) {
      try {
        const height = await connection.getBlockHeight("confirmed");
        if (height > lastValidBlockHeight) {
          // One last status check before giving up — race condition where
          // the tx landed in the very last valid block.
          const { value } = await connection.getSignatureStatuses([signature]);
          const s = value[0];
          if (
            s &&
            (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")
          ) {
            return;
          }
          throw new Error(
            `tx ${signature} blockhash expired (height ${height} > ${lastValidBlockHeight})`,
          );
        }
        consecutiveErrors = 0;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(`tx ${signature}`)) {
          throw err;
        }
        consecutiveErrors++;
      }
      nextHeightAt = Date.now() + 5_000;
    }

    // Yield. Polls are gated by `nextStatusAt`/`nextHeightAt` above; the loop
    // is just keeping wall-clock alive between scheduled requests.
    await new Promise((r) => setTimeout(r, 250));
  }
  void blockhash; // referenced for future strategies
}
