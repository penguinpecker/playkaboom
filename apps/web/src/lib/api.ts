import type { SerializedIx } from "@playkaboom/sdk";

export class ApiClientError extends Error {
  status: number;
  payload: Record<string, unknown>;
  constructor(status: number, payload: Record<string, unknown>) {
    super(typeof payload.error === "string" ? payload.error : `HTTP ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

/** Privy access-token resolver. Set once at app boot via `setAuthTokenResolver`
 * and every authed API call will attach it as `Authorization: Bearer …`. */
type TokenResolver = () => Promise<string | null>;
let resolveToken: TokenResolver = async () => null;
export function setAuthTokenResolver(fn: TokenResolver): void {
  resolveToken = fn;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await resolveToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function post<TIn extends object, TOut>(path: string, body: TIn): Promise<TOut> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    credentials: "include",
    body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new ApiClientError(res.status, json);
  return json as TOut;
}

export interface CommitResponse {
  commitment: string;
  instruction: SerializedIx;
  gameToken: string;
}
export async function apiCommit(input: {
  player: string;
  mineCount: number;
  betLamports: bigint;
}): Promise<CommitResponse> {
  return post("/api/commit", { ...input, betLamports: input.betLamports.toString() });
}

export interface RevealResponse {
  isMine: boolean;
  tileIndex: number;
  signature: string;
  safeReveals: number;
  gameToken: string;
  closeInstruction?: SerializedIx;
}
export async function apiReveal(input: {
  player: string;
  tileIndex: number;
  gameToken: string;
}): Promise<RevealResponse> {
  return post("/api/reveal", input);
}

export type SettleResponse =
  | { phase: "cashout"; instruction: SerializedIx }
  | { signature: string; mineLayout: number; verified: true };
export async function apiSettle(
  input: { player: string; gameToken: string; phase?: "cashout" | "settle" },
): Promise<SettleResponse> {
  return post("/api/settle", input);
}

export type CleanupResponse =
  | { active: false }
  | {
      active: true;
      action: "close_game" | "close_unsettled_game" | "refund_expired";
      instruction: SerializedIx;
      readyAt: number;
      secondsUntilReady: 0;
    }
  | {
      active: true;
      action: "wait_close_unsettled" | "wait_refund";
      readyAt: number;
      secondsUntilReady: number;
      currentSlot: number;
    }
  | {
      // Decode failure fallback — the legacy two-ix shape; client will try
      // each in turn.
      active: true;
      action: "unknown";
      closeInstruction: SerializedIx;
      refundInstruction: SerializedIx;
    };
export async function apiCleanup(input: {
  player: string;
  gameToken?: string;
}): Promise<CleanupResponse> {
  return post("/api/cleanup", input);
}

// ── Vault LP API ──────────────────────────────────────────────────────────────
export interface VaultStateResponse {
  v2Initialized: boolean;
  programId: string;
  vaultPda: string;
  vaultBalanceLamports: string;
  vaultAssetsLamports?: string;
  vaultBalanceSol: number;
  totalUnits?: string;
  totalPendingUnits?: string;
  unitValueE18?: string;
  healthBps?: number;
  minHealthBps?: number;
  effectiveMaxBetSol?: number;
  effectiveMaxPayoutSol?: number;
  effectiveMaxUserDepositSol?: number;
  withdrawCooldownSlots?: string;
  withdrawCooldownDays?: number;
  minLpDepositLamports?: string;
  apy30d?: number | null;
  timestamp: string;
}
export async function apiVaultState(): Promise<VaultStateResponse> {
  const res = await fetch("/api/vault/state", { cache: "no-store" });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new ApiClientError(res.status, json);
  return json as unknown as VaultStateResponse;
}

export interface VaultPositionResponse {
  wallet: string;
  units: string;
  pendingUnits: string;
  pendingUnlockSlot: string;
  currentValueLamports: string;
  currentValueSol: number;
  deposited: number;
  withdrawn: number;
  netDeposited: number;
  pnlLamports: number | null;
  pnlPercent: number | null;
  /** True when on-chain holds units but the Helius indexer hasn't ingested
   * the deposit yet. UI should show P&L as "—" / "indexing" instead of zeros. */
  indexerStale?: boolean;
  history: Array<{
    signature: string;
    action: string;
    units_delta: string;
    lamports_delta: number;
    slot: number;
    block_time: string | null;
  }>;
}
export async function apiVaultPosition(wallet: string): Promise<VaultPositionResponse> {
  const res = await fetch(`/api/vault/position/${wallet}`, { cache: "no-store" });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new ApiClientError(res.status, json);
  return json as unknown as VaultPositionResponse;
}

export interface IxResponse { instruction: SerializedIx }
export async function apiVaultDeposit(input: {
  player: string;
  amountLamports: bigint;
}): Promise<IxResponse> {
  return post("/api/vault/deposit", {
    player: input.player,
    amountLamports: input.amountLamports.toString(),
  });
}
export async function apiVaultRequestWithdraw(input: {
  player: string;
  units: bigint;
}): Promise<IxResponse> {
  return post("/api/vault/request-withdraw", {
    player: input.player,
    units: input.units.toString(),
  });
}
export async function apiVaultCancelWithdraw(input: {
  player: string;
}): Promise<IxResponse> {
  return post("/api/vault/cancel-withdraw", input);
}
export async function apiVaultCompleteWithdraw(input: {
  player: string;
}): Promise<IxResponse> {
  return post("/api/vault/complete-withdraw", input);
}

// ── Activity feed ──────────────────────────────────────────────────────────
export interface ActivityEvent {
  kind: "game" | "lp" | "ref_received" | "ref_paid";
  signature: string;
  slot: number;
  time: string | null;
  payload: Record<string, unknown>;
}

export async function apiActivity(wallet: string): Promise<{
  wallet: string;
  events: ActivityEvent[];
}> {
  const res = await fetch(`/api/activity/${wallet}`, { cache: "no-store" });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new ApiClientError(res.status, json);
  return json as unknown as { wallet: string; events: ActivityEvent[] };
}
