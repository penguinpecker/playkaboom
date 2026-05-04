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

async function post<TIn extends object, TOut>(path: string, body: TIn): Promise<TOut> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

export interface CleanupResponse {
  active: boolean;
  closeInstruction?: SerializedIx;
  refundInstruction?: SerializedIx;
}
export async function apiCleanup(input: {
  player: string;
  gameToken?: string;
}): Promise<CleanupResponse> {
  return post("/api/cleanup", input);
}
