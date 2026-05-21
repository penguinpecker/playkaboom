import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { GRID_SIZE, MIN_BET_LAMPORTS, StartGameInput, calcMultiplierBps } from "@playkaboom/shared";
import {
  buildStartGame,
  decodeVault,
  decodeVaultV2State,
  deriveV2StatePda,
  deriveVaultPda,
  serializeIx,
} from "@playkaboom/sdk";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { createGameSession } from "@/server/game";
import { saveSession } from "@/server/session-store";
import { playerHasActiveGame } from "@/server/solana";
import { programId } from "@/server/env";
import { getConnection } from "@/server/connection";
import { enforceRateLimit } from "@/server/ratelimit";
import {
  effectiveMaxBetLamports,
  effectiveMaxPayoutLamports,
  healthBps,
} from "@/server/vault-math";
import { logger } from "@/server/logger";

// Rent floor used by the program when computing `available = vault.lamports -
// rent`. Mirrors apps/web/src/hooks/useContracts.tsx — kept conservative so
// the server-side gate is *no looser* than the on-chain check. If they ever
// drift, the on-chain start_game tx will simulate-fail with BetExceedsMax /
// MaxPayoutExceeded and the player sees a 6xxx error — annoying but not a
// money bug. The server gate is here to reject obvious out-of-range inputs
// (e.g. u64::MAX) before we write Supabase rows and burn RPC quota.
const VAULT_RENT_LAMPORTS_FLOOR = 12_000_000n;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, StartGameInput);

    const playerPk = new PublicKey(body.player);
    const pid = programId();
    const conn = getConnection();
    const [vaultPda] = deriveVaultPda(pid);
    const [v2Pda] = deriveV2StatePda(pid);

    // Auth, ratelimit, and the RPC checks all run in parallel. They share
    // no state and were cumulatively adding ~700ms p50 sequential. Rate
    // limit consumes a slot even if auth fails — desired anti-abuse.
    //
    // 2026-05-21: bet-cap pre-check. We must reject out-of-range bets
    // BEFORE writing the session row to Supabase, otherwise an attacker
    // requesting betLamports = u64::MAX spam-writes game_sessions and
    // burns four parallel RPC calls per request. Reads vault + v2 account
    // info here so the validation runs against the same snapshot the
    // on-chain start_game ix will see.
    const [, rl, activeGame, slot, vaultInfo, v2Info, vaultLamports] = await Promise.all([
      verifyPlayerAuth(req, body.player),
      enforceRateLimit(`commit:${clientIp(req)}:${body.player}`),
      playerHasActiveGame(playerPk),
      // `processed` is fine here: we just need a recent slot for the
      // session start_slot (used for the refund window). Saves ~150ms vs
      // confirmed because processed lands on the leader's first response.
      conn.getSlot("processed"),
      conn.getAccountInfo(vaultPda, "confirmed"),
      conn.getAccountInfo(v2Pda, "confirmed"),
      conn.getBalance(vaultPda, "confirmed"),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    if (activeGame) {
      throw new ApiError(409, "Active game exists. Close it first.", { needsCleanup: true });
    }

    // Vault must exist; if not, refuse rather than letting the ix simulate-fail.
    if (!vaultInfo) {
      throw new ApiError(503, "Vault account not found");
    }
    const vault = decodeVault(vaultInfo.data);
    if (vault.paused) {
      throw new ApiError(503, "Vault is paused");
    }
    const v2 = v2Info ? decodeVaultV2State(v2Info.data) : null;

    const betLamports = BigInt(body.betLamports);
    if (betLamports < MIN_BET_LAMPORTS) {
      throw new ApiError(400, "Bet below minimum");
    }
    const lamportsBig = BigInt(vaultLamports);
    if (lamportsBig <= VAULT_RENT_LAMPORTS_FLOOR) {
      throw new ApiError(503, "Vault has insufficient capacity");
    }
    const available = lamportsBig - VAULT_RENT_LAMPORTS_FLOOR;
    const health = v2 ? healthBps(v2, available) : 10_000;
    if (health <= 0) {
      throw new ApiError(503, "Vault is at zero health");
    }
    const maxBet = effectiveMaxBetLamports(available, vault.maxBetBps, health);
    const maxPayout = effectiveMaxPayoutLamports(available, vault.maxPayoutBps, health);

    // Worst-case payout = bet × multiplier_at_full_clear. Mirrors the
    // on-chain check in start_game (lib.rs `worst_payout <= max_payout`).
    const safeReveals = GRID_SIZE - body.mineCount;
    const houseEdge = vault.houseEdgeBps;
    const multBps = BigInt(calcMultiplierBps(safeReveals, body.mineCount, houseEdge));
    const worstPayout = (betLamports * multBps) / 10_000n;

    if (betLamports > maxBet) {
      throw new ApiError(400, "Bet exceeds vault cap for the current mine count");
    }
    if (worstPayout > maxPayout) {
      throw new ApiError(400, "Worst-case payout exceeds vault cap");
    }

    const { payload, commitment } = createGameSession(body.player, body.mineCount);

    const ix = buildStartGame({
      ctx: { programId: pid },
      player: playerPk,
      mineCount: body.mineCount,
      betLamports,
      commitment,
    });
    // Mirror the encrypted session to Supabase keyed by GameSession PDA so
    // the player can recover from any device. Function returns the same
    // ciphertext we'd have produced with encryptSession alone.
    const gameToken = await saveSession(body.player, payload, slot, {
      betLamports,
      mineCount: body.mineCount,
      startSlot: slot,
    });

    logger.info(
      { player: body.player, mineCount: body.mineCount, bet: body.betLamports.toString() },
      "commit",
    );

    return NextResponse.json({
      commitment: commitment.toString("hex"),
      instruction: serializeIx(ix),
      gameToken,
    });
  } catch (err) {
    return jsonError(err);
  }
}
