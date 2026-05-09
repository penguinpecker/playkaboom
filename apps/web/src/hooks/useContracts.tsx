"use client";
import { useEffect, useMemo, useState } from "react";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  useSolanaWallets as useWallets,
  useStandardSignTransaction,
} from "@privy-io/react-auth/solana";
import {
  deriveVaultPda,
  deriveV2StatePda,
  decodeVault,
  decodeVaultV2State,
  type VaultAccount,
  type VaultV2StateAccount,
} from "@playkaboom/sdk";
import { calcMultiplierBps } from "@playkaboom/shared";
import { PROGRAM_ID } from "@/lib/cluster";

const VAULT_PDA = deriveVaultPda(PROGRAM_ID)[0];
const V2_PDA = deriveV2StatePda(PROGRAM_ID)[0];

const HOUSE_EDGE_BPS_DEFAULT = 200;
// Approximation of the rent floor used in the program's `available =
// vault_lamports - rent` calc. Anchor adds 8 bytes for discriminator,
// the actual on-chain Vault::SPACE varies. 0.012 SOL covers it with
// a comfortable margin (current production rent is ~0.0048 SOL).
const VAULT_RENT_LAMPORTS_FLOOR = 12_000_000n;

function useVaultAccount() {
  const { connection } = useConnection();
  const [data, setData] = useState<{
    lamports: bigint;
    vault: VaultAccount | null;
    v2: VaultV2StateAccount | null;
  }>({
    lamports: 0n,
    vault: null,
    v2: null,
  });
  useEffect(() => {
    let cancelled = false;
    const f = async () => {
      try {
        const [lamports, vaultInfo, v2Info] = await Promise.all([
          connection.getBalance(VAULT_PDA, "confirmed"),
          connection.getAccountInfo(VAULT_PDA, "confirmed"),
          connection.getAccountInfo(V2_PDA, "confirmed"),
        ]);
        if (cancelled) return;
        setData({
          lamports: BigInt(lamports),
          vault: vaultInfo ? decodeVault(vaultInfo.data) : null,
          v2: v2Info ? decodeVaultV2State(v2Info.data) : null,
        });
      } catch {
        /* noop */
      }
    };
    void f();
    const id = setInterval(f, 15_000);
    // Wake-up triggers so the vault state recovers from background-tab
    // suspension. Without these, after a few hours of inactivity the
    // displayed vault balance / health / max bet stays frozen.
    const onWake = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void f();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [connection]);
  return data;
}

export function useContracts() {
  const { lamports } = useVaultAccount();
  return { vaultBalance: Number(lamports) / LAMPORTS_PER_SOL };
}

export function useVaultBalance() {
  const { lamports } = useVaultAccount();
  return { data: lamports > 0n ? lamports : undefined };
}

/**
 * Mirrors the program's calc_health_bps (lib.rs ~line 2000):
 *   pending_value = units_to_assets(total_pending_units, available, total_units)
 *   obligations   = total_outstanding_max_payout + pending_value
 *   free          = available - obligations
 *   health_bps    = free / available × 10_000
 *
 * If the V2 state account hasn't been read yet, we fall back to a
 * naive vault-lamports-only health (the pre-V2 behavior) so the UI
 * doesn't show "—" indefinitely on the home page.
 */
export function useVaultHealth(): { data: number | undefined } {
  const { lamports, vault, v2 } = useVaultAccount();
  return useMemo(() => {
    if (vault === null) return { data: undefined };
    if (lamports <= VAULT_RENT_LAMPORTS_FLOOR) return { data: 0 };
    const available = lamports - VAULT_RENT_LAMPORTS_FLOOR;
    if (!v2) {
      // V2 hasn't migrated yet: full health if the vault has anything,
      // 0 if drained. Matches pre-V2 semantics.
      return { data: available > 0n ? 100 : 0 };
    }
    const pendingValue =
      v2.totalUnits > 0n
        ? (v2.totalPendingUnits * available) / v2.totalUnits
        : 0n;
    const obligations = v2.totalOutstandingMaxPayout + pendingValue;
    const free = obligations >= available ? 0n : available - obligations;
    const healthBps = (free * 10_000n) / available;
    return { data: Number(healthBps) / 100 };
  }, [lamports, vault, v2]);
}

/**
 * The strict, on-chain-equivalent capacity reader. Returns the maximum
 * bet that would *actually* pass start_game's
 * `worst_payout <= max_payout` check for the supplied mine_count, plus
 * a structured reason when the cap is zero (so the UI can explain
 * "vault paused" vs "outstanding obligations" vs "rent floor").
 *
 * Mirror of programs/kaboom/src/lib.rs:218-246. If you change the
 * on-chain check, change this too — the start_game tx will simulate
 * fail otherwise and players see error 6006.
 */
export interface CapacityResult {
  maxBetSol: number;
  healthBps: number;
  effectiveMaxPayoutBps: number;
  worstCasePayoutSol: number;
  /** "ok" | "paused" | "v2_not_ready" | "vault_empty" | "obligations_full"
   *  | "exceeds_cap" — UI maps these to user-readable copy. */
  reason: string;
}

export function useVaultCapacity(
  betSol: number,
  mineCount: number,
): CapacityResult {
  const { lamports, vault, v2 } = useVaultAccount();
  return useMemo(() => {
    const empty: CapacityResult = {
      maxBetSol: 0,
      healthBps: 0,
      effectiveMaxPayoutBps: 0,
      worstCasePayoutSol: 0,
      reason: "vault_empty",
    };
    if (!vault) return empty;
    if (vault.paused) return { ...empty, reason: "paused" };
    if (lamports <= VAULT_RENT_LAMPORTS_FLOOR) return empty;
    const available = lamports - VAULT_RENT_LAMPORTS_FLOOR;

    // Health (mirrors calc_health_bps).
    let healthBps = 10_000;
    let obligations = 0n;
    if (v2) {
      const pendingValue =
        v2.totalUnits > 0n
          ? (v2.totalPendingUnits * available) / v2.totalUnits
          : 0n;
      obligations = v2.totalOutstandingMaxPayout + pendingValue;
      const free = obligations >= available ? 0n : available - obligations;
      healthBps = Number((free * 10_000n) / available);
      if (healthBps <= 0) {
        return {
          maxBetSol: 0,
          healthBps: 0,
          effectiveMaxPayoutBps: 0,
          worstCasePayoutSol: 0,
          reason: "obligations_full",
        };
      }
    }

    const effectiveMaxPayoutBps = Math.floor(
      (vault.maxPayoutBps * healthBps) / 10_000,
    );
    // Convert "max payout" to "max bet" by dividing by the worst-case
    // multiplier for the chosen mine_count. The worst case is when the
    // player reveals every safe tile (safeReveals = GRID_SIZE - mineCount).
    const safeReveals = 16 - mineCount;
    if (safeReveals <= 0) return empty;
    const houseEdgeBps = vault.houseEdgeBps ?? HOUSE_EDGE_BPS_DEFAULT;
    const multBps = Number(calcMultiplierBps(safeReveals, mineCount, houseEdgeBps));
    if (multBps <= 0) return empty;

    // max_payout_lamports = available × effectiveMaxPayoutBps / 10_000
    // max_bet_lamports    = max_payout_lamports × 10_000 / multBps
    const maxPayoutLamports = (available * BigInt(effectiveMaxPayoutBps)) / 10_000n;
    // Also clamp by max_bet_bps × healthBps × available (the BetExceedsMax check).
    const effectiveMaxBetBps = Math.floor((vault.maxBetBps * healthBps) / 10_000);
    const maxBetByBetCap = (available * BigInt(effectiveMaxBetBps)) / 10_000n;
    const maxBetByPayout = (maxPayoutLamports * 10_000n) / BigInt(multBps);
    const maxBetLamports = maxBetByBetCap < maxBetByPayout ? maxBetByBetCap : maxBetByPayout;
    const maxBetSol = Number(maxBetLamports) / LAMPORTS_PER_SOL;

    const worstCasePayoutSol = (betSol * multBps) / 10_000;
    const reason = betSol > maxBetSol ? "exceeds_cap" : "ok";

    return {
      maxBetSol,
      healthBps,
      effectiveMaxPayoutBps,
      worstCasePayoutSol,
      reason,
    };
  }, [betSol, mineCount, lamports, vault, v2]);
}

export function useVaultMaxBet() {
  const { lamports, vault } = useVaultAccount();
  const bps = vault?.maxBetBps ?? 200;
  return {
    data: lamports > 0n ? (lamports * BigInt(bps)) / 10_000n : undefined,
  };
}

export function useVaultMaxPayout() {
  const { lamports, vault } = useVaultAccount();
  const bps = vault?.maxPayoutBps ?? 5_000;
  return {
    data: lamports > 0n ? (lamports * BigInt(bps)) / 10_000n : undefined,
  };
}

export function useGameCounter() {
  const { vault } = useVaultAccount();
  return { data: vault ? vault.totalGames : 0n };
}

export function useRiskLevel() {
  const { data } = useVaultHealth();
  if (data === undefined) return { data: undefined as number | undefined };
  const level = data >= 70 ? 0 : data >= 30 ? 1 : 2;
  return { data: level };
}

export function useWhaleAlertCount() {
  return { data: 0 };
}

export function useDepositToVault() {
  const { connection } = useConnection();
  const { wallets } = useWallets();
  const { signTransaction } = useStandardSignTransaction();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const deposit = async (amt?: string) => {
    const wallet = wallets[0];
    if (!wallet) return;
    try {
      setIsPending(true);
      const sol = parseFloat(amt || "0");
      if (sol <= 0) return;
      const lamports = Math.round(sol * LAMPORTS_PER_SOL);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(wallet.address),
          toPubkey: VAULT_PDA,
          lamports,
        }),
      );
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = new PublicKey(wallet.address);
      setIsConfirming(true);
      const { signedTransaction } = await signTransaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: tx.serialize({ requireAllSignatures: false }) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
      });
      const raw =
        signedTransaction instanceof Uint8Array ? signedTransaction : Buffer.from(signedTransaction);
      const sig = await connection.sendRawTransaction(raw);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setIsSuccess(true);
      setTimeout(() => setIsSuccess(false), 3_000);
    } catch (e) {
      console.error("Deposit failed:", e instanceof Error ? e.message : e);
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return { deposit, isPending, isConfirming, isSuccess };
}

export interface LeaderboardEntry {
  player: string;
  totalWagered: bigint;
  totalWon: bigint;
  gamesPlayed: bigint;
  biggestWin: bigint;
  biggestMultiplier: bigint;
}

export function useLeaderboard() {
  return { data: [] as LeaderboardEntry[] };
}
