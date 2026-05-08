// Per-wallet activity ledger (withdrawals + future deposits) persisted in
// localStorage. Game events live in Supabase via the on-chain indexer; wallet
// transfers are not parsed by that indexer (they aren't kaboom-program ixs),
// so we keep a thin client-side record so the user can see their own history
// on /logs without a roundtrip.

export type WalletActivityKind = "withdraw" | "deposit";

export interface WalletActivityEntry {
  kind: WalletActivityKind;
  signature: string;
  amountLamports: string;
  /** Counterparty: destination for withdraw, source for deposit. */
  otherAddress: string;
  /** ISO timestamp of when the tx confirmed (client clock). */
  time: string;
}

const KEY = (addr: string) => `kaboom:wallet-activity:${addr}`;
const MAX_ENTRIES = 100;

export function loadWalletActivity(address: string | null | undefined): WalletActivityEntry[] {
  if (!address || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is WalletActivityEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as WalletActivityEntry).signature === "string" &&
        typeof (e as WalletActivityEntry).amountLamports === "string",
    );
  } catch {
    return [];
  }
}

export function appendWalletActivity(
  address: string,
  entry: WalletActivityEntry,
): void {
  if (typeof window === "undefined") return;
  try {
    const existing = loadWalletActivity(address);
    // Dedupe by signature in case the modal flow records twice.
    const filtered = existing.filter((e) => e.signature !== entry.signature);
    const next = [entry, ...filtered].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(KEY(address), JSON.stringify(next));
  } catch {
    /* localStorage full / disabled — silently swallow, not critical */
  }
}
