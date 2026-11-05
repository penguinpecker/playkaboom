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
import { useQuery } from "@tanstack/react-query";
import {
  deriveVaultPda,
  deriveV2StatePda,
  decodeVault,
  decodeVaultV2State,
  type VaultAccount,
  type VaultV2StateAccount,
} from "@playkaboom/sdk";
import { computeCapacity, vaultLimits, type CapacityResult } from "@/lib/vault-capacity";
import { PROGRAM_ID, VRF_MODE_ENABLED } from "@/lib/cluster";

const VAULT_PDA = deriveVaultPda(PROGRAM_ID)[0];
const V2_PDA = deriveV2StatePda(PROGRAM_ID)[0];

const HOUSE_EDGE_BPS_DEFAULT = 200;
// Approximation of the rent floor used in the program's `available =
// vault_lamports - rent` calc. Anchor adds 8 bytes for discriminator,
// the actual on-chain Vault::SPACE varies. 0.012 SOL covers it with
// a comfortable margin (current production rent is ~0.0048 SOL).
const VAULT_RENT_LAMPORTS_FLOOR = 12_000_000n;

interface VaultAccountData {
  lamports: bigint;
  vault: VaultAccount | null;
  v2: VaultV2StateAccount | null;
}

const EMPTY_VAULT_DATA: VaultAccountData = {
  lamports: 0n,
  vault: null,
  v2: null,
};

/**
 * Single shared poller for the on-chain vault state.
 *
 * Every hook below (useVaultBalance, useVaultHealth, useVaultCapacity,
 * useVaultMaxBet, useVaultMaxPayout, useGameCounter, useContracts) calls
 * this. Previously this was a useState+useEffect+setInterval that
 * created an INDEPENDENT poller PER CALL — 7 callers meant 7 timers,
 * each on its own 15s schedule starting from when the component mounted.
 * Result: Vault Balance and Vault Health on the same screen could be
 * read from polls 14 seconds apart, and during a high-obligation
 * moment the displayed values for the same on-chain state would be
 * inconsistent (one fresh, one stale).
 *
 * TanStack Query dedupes by queryKey: all 7 consumers share the same
 * single poller and the same cached value, so all derived stats render
 * from the same snapshot every render.
 */
function useVaultAccount(): VaultAccountData {
  const { connection } = useConnection();
  const { data } = useQuery({
    queryKey: ["vault-account", connection.rpcEndpoint],
    queryFn: async (): Promise<VaultAccountData> => {
      const [lamports, vaultInfo, v2Info] = await Promise.all([
        connection.getBalance(VAULT_PDA, "confirmed"),
        connection.getAccountInfo(VAULT_PDA, "confirmed"),
        connection.getAccountInfo(V2_PDA, "confirmed"),
      ]);
      return {
        lamports: BigInt(lamports),
        vault: vaultInfo ? decodeVault(vaultInfo.data) : null,
        v2: v2Info ? decodeVaultV2State(v2Info.data) : null,
      };
    },
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 5_000,
  });
  return data ?? EMPTY_VAULT_DATA;
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
 * Live on-chain house edge. Falls back to HOUSE_EDGE_BPS_DEFAULT only
 * while the vault account is still loading on the first paint — once the
 * account info has arrived, the displayed multiplier exactly matches what
 * the program will pay out at cash_out / settle_game. Governance can
 * change the on-chain edge via update_vault; without this hook, the UI
 * would render stale until the next deploy.
 */
export function useHouseEdgeBps(): number {
  const { vault } = useVaultAccount();
  return vault?.houseEdgeBps ?? HOUSE_EDGE_BPS_DEFAULT;
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

export function useVaultCapacity(
  betSol: number,
  mineCount: number,
): CapacityResult {
  const { lamports, vault, v2 } = useVaultAccount();
  return useMemo(
    () => computeCapacity(lamports, vault, v2, betSol, mineCount, VAULT_RENT_LAMPORTS_FLOOR, VRF_MODE_ENABLED),
    [betSol, mineCount, lamports, vault, v2],
  );
}

/**
 * Max bet (SOL) for each mine count, so the selector can grey out densities
 * the vault cannot cover at ANY legal bet. Worst-case payout scales with
 * C(16, mines) — 16x at 1 mine, 560x at 3 — so on a small bankroll most
 * densities are unplayable even at the minimum bet, and offering them just
 * produces a failed simulation after the player has committed.
 */
export function useMaxBetByMineCount(mineCounts: readonly number[]): Record<number, number> {
  const { lamports, vault, v2 } = useVaultAccount();
  const key = mineCounts.join(",");
  return useMemo(() => {
    const out: Record<number, number> = {};
    for (const n of mineCounts) {
      out[n] = computeCapacity(lamports, vault, v2, 0, n, VAULT_RENT_LAMPORTS_FLOOR, VRF_MODE_ENABLED).maxBetSol;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lamports, vault, v2, key]);
}

/**
 * Headline limits for /vault and /logs: the largest bet any mine count
 * accepts and the program's payout cap, from the same per-mine maths as the
 * bet controls. The old versions used max_bet_bps and max_payout_bps (50%)
 * alone, ignoring the VRF payout cap and the worst-case multiplier, so they
 * quoted ~3x the real max bet and ~5x the real max payout.
 */
function useVaultLimits() {
  const { lamports, vault, v2 } = useVaultAccount();
  return useMemo(
    () => (vault ? vaultLimits(lamports, vault, v2, VAULT_RENT_LAMPORTS_FLOOR, VRF_MODE_ENABLED) : undefined),
    [lamports, vault, v2],
  );
}

export function useVaultMaxBet() {
  return { data: useVaultLimits()?.maxBetLamports };
}

export function useVaultMaxPayout() {
  return { data: useVaultLimits()?.maxPayoutLamports };
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
