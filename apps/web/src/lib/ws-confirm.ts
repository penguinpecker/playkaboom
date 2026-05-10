// Race-friendly wrappers around `@solana/web3.js` Connection's built-in
// WebSocket subscriptions. The Connection class already runs a battle-
// tested singleton WS (one per `new Connection(...)` instance), with:
//   - Same-target subscription dedup (server-side coalescing per
//     solana-labs/solana#18943; client-side dedup in v1).
//   - Notification-before-ack race resolution.
//   - URL-change reconnect with generation tokens.
//   - signatureSubscribe auto-dispose tracking
//     (solana-labs/solana#18892).
//   - 5s WS heartbeat.
//   - Pending subscription state machine across reconnects.
//
// Reimplementing any of that ourselves was a footgun — the audit
// found 7 BLOCKING/HIGH bugs in our hand-rolled singleton. We use
// the Connection's WS instead and add only the one missing piece:
// a pre-flight `getSignatureStatuses` check, because
// signatureSubscribe does NOT fire for already-finalized sigs
// (solana-foundation/solana-web3.js#1107).

import type { Commitment, Connection } from "@solana/web3.js";

/** Result shape returned from a successful confirmation. */
interface SignatureNotification {
  slot: number;
  err: unknown;
}

/** Map web3.js's TransactionConfirmationStatus to a "is it at least as
 *  committed as `commitment`" check. */
function statusReached(
  status: "processed" | "confirmed" | "finalized" | undefined,
  commitment: Commitment,
): boolean {
  if (!status) return false;
  if (commitment === "processed") return true;
  if (commitment === "confirmed") return status === "confirmed" || status === "finalized";
  return status === "finalized";
}

/**
 * Resolve when `signature` reaches `commitment`.
 *
 * Designed to be raced against `confirmByPolling` via Promise.any — if
 * the WS layer misbehaves the polling fallback wins, so this never
 * makes the flow worse than polling-only.
 *
 * Order of checks:
 *   1. `getSignatureStatuses` immediately. If the sig is already at
 *      the requested commitment, resolve right away. This is the
 *      already-finalized fix — without it, signatureSubscribe sits
 *      silent for the full timeout because Solana only fires on
 *      commitment-level transitions, not for sigs already past it.
 *   2. Otherwise, `connection.onSignature` to subscribe via Connection's
 *      internal WS. The callback fires once when commitment is reached.
 *   3. On timeout, reject — caller's race lets polling take over.
 */
export function awaitSigConfirmedWs(
  connection: Connection,
  signature: string,
  commitment: Commitment = "confirmed",
  timeoutMs = 12_000,
): Promise<SignatureNotification> {
  return new Promise((resolve, reject) => {
    let subId: number | null = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (subId !== null) {
        // signatureSubscribe is auto-disposed by the server after the
        // terminal notification, so removeSignatureListener may surface
        // a "subscription not found" inside web3.js. v1 swallows that
        // internally, but we catch defensively.
        void connection.removeSignatureListener(subId).catch(() => {});
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`ws sig timeout after ${timeoutMs}ms`))),
      timeoutMs,
    );

    // 1) Pre-flight status check. Crucial — without it, an already-
    // finalized sig leaves the WS subscription dangling for the full
    // timeoutMs.
    connection
      .getSignatureStatuses([signature])
      .then(({ value }) => {
        if (settled) return;
        const s = value[0];
        if (s && !s.err && statusReached(s.confirmationStatus, commitment)) {
          finish(() => resolve({ slot: s.slot ?? 0, err: null }));
          return;
        }
        if (s?.err) {
          finish(() => reject(new Error(`tx failed: ${JSON.stringify(s.err)}`)));
          return;
        }
        // 2) Not yet at commitment — subscribe.
        try {
          subId = connection.onSignature(
            signature,
            (result, context) => {
              if (result.err) {
                finish(() => reject(new Error(`tx failed: ${JSON.stringify(result.err)}`)));
              } else {
                finish(() => resolve({ slot: context.slot, err: null }));
              }
            },
            commitment,
          );
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      })
      .catch((statusErr) => {
        if (settled) return;
        // Status check failed (network blip) — still try the subscribe;
        // worst case it timeouts and polling races to a win.
        try {
          subId = connection.onSignature(
            signature,
            (result, context) => {
              if (result.err) {
                finish(() => reject(new Error(`tx failed: ${JSON.stringify(result.err)}`)));
              } else {
                finish(() => resolve({ slot: context.slot, err: null }));
              }
            },
            commitment,
          );
        } catch {
          finish(() => reject(statusErr instanceof Error ? statusErr : new Error(String(statusErr))));
        }
      });
  });
}

/**
 * Resolve when the predicate matches an account state change. For
 * "account closed" use cases pass `(info) => info === null` —
 * accountSubscribe fires with `null` when the account is gone.
 *
 * The web3.js callback receives `AccountInfo<Buffer> | null`. Solana's
 * accountSubscribe behavior on close is "send one final notification
 * with null" in most implementations, but it's not contractually
 * documented — pair this with a polling fallback for guarantees. The
 * caller already does that via Promise.any.
 */
export function awaitAccountChangeWs(
  connection: Connection,
  pubkey: import("@solana/web3.js").PublicKey,
  predicate: (info: import("@solana/web3.js").AccountInfo<Buffer> | null) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let subId: number | null = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (subId !== null) {
        void connection.removeAccountChangeListener(subId).catch(() => {});
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("ws account timeout"))),
      timeoutMs,
    );

    try {
      subId = connection.onAccountChange(
        pubkey,
        (accountInfo) => {
          // web3.js types this as AccountInfo<Buffer>, but the underlying
          // protocol fires with null when the account is gone — accept
          // both.
          const info = (accountInfo as unknown) as import("@solana/web3.js").AccountInfo<Buffer> | null;
          if (predicate(info)) finish(() => resolve());
        },
        "confirmed",
      );
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
