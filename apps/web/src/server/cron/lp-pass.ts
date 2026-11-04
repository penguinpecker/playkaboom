import "server-only";
import {
  buildCompleteWithdraw,
  decodeLpPosition,
  decodeVaultV2State,
  deriveV2StatePda,
  deriveVaultPda,
  type LpPositionAccount,
} from "@playkaboom/sdk";
import { WITHDRAW_CLAIM_WINDOW_SLOTS } from "@playkaboom/shared";
import { getConnection } from "../connection";
import { programId } from "../env";
import { sendHouseTx } from "../solana";
import { indexFreshSignature } from "../inline-ingest";
import { unitsToLamports } from "../vault-math";
import { logger } from "../logger";

/**
 * FIXES.md 9.3.f (F4): complete every matured LP withdrawal inside its 9,000-slot
 * claim window, unsigned, house as fee payer. Funds go only to position.user.
 *
 * ONE complete_withdraw per tx, never batched (F4-1): a completion paying less
 * than the 0-byte rent minimum into a 0-lamport wallet fails the runtime rent
 * check and would sink every completion batched with it for the whole window.
 * Such positions are skipped up front; the LP completes them itself (as fee
 * payer its wallet is not empty). Positions past the window
 * are only logged: the LP restarts them (cancel + request).
 */
const LP_POSITION_DATASIZE = 121;
const MAX_PER_PASS = 20;
// Where the next pass starts in `due`, so positions that keep failing at the
// head of the (stable) getProgramAccounts order cannot starve the rest.
let rotate = 0;

export async function runLpAutoComplete() {
  const conn = getConnection();
  const pid = programId();
  const [vaultPda] = deriveVaultPda(pid);
  const [v2Pda] = deriveV2StatePda(pid);
  const [positions, slot, vaultInfo, v2Info, rent0] = await Promise.all([
    conn.getProgramAccounts(pid, { commitment: "confirmed", filters: [{ dataSize: LP_POSITION_DATASIZE }] }),
    conn.getSlot("confirmed"),
    conn.getAccountInfo(vaultPda, "confirmed"),
    conn.getAccountInfo(v2Pda, "confirmed"),
    conn.getMinimumBalanceForRentExemption(0),
  ]);
  if (!vaultInfo || !v2Info) return { skipped: "vault not initialized" };
  const v2 = decodeVaultV2State(v2Info.data);
  const vaultRent = await conn.getMinimumBalanceForRentExemption(vaultInfo.data.length);
  const assets = BigInt(Math.max(0, vaultInfo.lamports - vaultRent));

  const due: LpPositionAccount[] = [];
  const expired: string[] = [];
  for (const a of positions) {
    let p: LpPositionAccount;
    try {
      p = decodeLpPosition(a.account.data);
    } catch {
      continue;
    }
    if (p.pendingUnits === 0n) continue;
    const unlock = Number(p.pendingUnlockSlot);
    if (slot < unlock) continue;
    if (slot > unlock + WITHDRAW_CLAIM_WINDOW_SLOTS) expired.push(p.user.toBase58());
    else due.push(p);
  }

  const res = { due: due.length, completed: 0, skippedDust: 0, expired: expired.length, errors: [] as string[] };
  // Only sends count toward the cap (dust skips do not), and the start rotates.
  const start = due.length ? rotate % due.length : 0;
  let sent = 0;
  for (let i = 0; i < due.length && sent < MAX_PER_PASS; i++) {
    const p = due[(start + i) % due.length]!;
    const payout = unitsToLamports(p.pendingUnits, assets, v2.totalUnits);
    if (payout < BigInt(rent0) && (await conn.getBalance(p.user, "confirmed")) === 0) {
      res.skippedDust++;
      continue;
    }
    sent++;
    try {
      const sig = await sendHouseTx([
        buildCompleteWithdraw({ ctx: { programId: pid }, user: p.user, userSigns: false }),
      ]);
      void indexFreshSignature(sig);
      res.completed++;
      logger.info({ user: p.user.toBase58(), sig }, "cron: lp withdrawal auto-completed");
    } catch (e) {
      res.errors.push(`${p.user.toBase58().slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    }
  }
  rotate = start + sent + res.skippedDust;
  if (expired.length) logger.warn({ users: expired }, "lp withdrawals past the claim window (LP must restart)");
  return res;
}
