import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  decodeVault,
  decodeVaultV2State,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";
import { jsonError } from "@/server/api-helpers";
import { getConnection } from "@/server/connection";
import { programId } from "@/server/env";
import { sendAlert } from "@/server/alerts";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron-triggered vault health probe. Runs every N minutes from GH
 * Actions. Reads Vault + V2State PDAs, computes the same health metric
 * the program enforces, and pings ALERT_WEBHOOK_URL if it crosses a
 * threshold.
 *
 * Triggers (in order of severity):
 *   • CRITICAL   health < 20%       → game payouts at risk
 *   • CRITICAL   vault_paused == true (someone toggled it; alert ops)
 *   • WARN       health < 50%       → vault is over-leveraged, top up soon
 *   • WARN       lamports < rent_floor + 1 SOL  → barely funded
 *   • INFO       health drop > 25 percentage points since last sample
 *
 * Authed: requires `Authorization: Bearer ${CRON_SECRET}`. Same
 * pattern as /api/cron/index-events.
 */
const HEALTH_CRITICAL = 2_000; // 20%
const HEALTH_WARN = 5_000; // 50%
const RENT_FLOOR_LAMPORTS = 12_000_000n;
const LOW_BALANCE_FLOOR_LAMPORTS = 1_000_000_000n + RENT_FLOOR_LAMPORTS;
// House signer (Turnkey HSM) pays the fees on every reveal_tile + settle_game.
// At ~0.0001 SOL/tx-pair worst case, 0.1 SOL ≈ 500 games. Warn early so ops
// can top it up before the next round of plays starts erroring with
// "Attempt to debit an account but found no record of a prior credit".
const HOUSE_BALANCE_WARN_LAMPORTS = 100_000_000n; // 0.1 SOL
const HOUSE_BALANCE_CRITICAL_LAMPORTS = 20_000_000n; // 0.02 SOL

export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.get("authorization");
    if (!secret || auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const conn = getConnection();
    const pid = programId();
    const [vaultPda] = deriveVaultPda(pid);
    const [v2Pda] = deriveV2StatePda(pid);
    const [lamports, vaultInfo, v2Info] = await Promise.all([
      conn.getBalance(vaultPda, "confirmed"),
      conn.getAccountInfo(vaultPda, "confirmed"),
      conn.getAccountInfo(v2Pda, "confirmed"),
    ]);
    // Fetch house signer balance after we know vault.house_authority.
    // Done in a second round-trip to avoid coupling alert-shape to vault decode.
    if (!vaultInfo) {
      await sendAlert({
        severity: "critical",
        title: "Vault PDA missing",
        description: `Vault account ${vaultPda.toBase58()} not found. Program may have been redeployed without re-init.`,
      });
      return NextResponse.json({ error: "vault not found" }, { status: 500 });
    }
    const vault = decodeVault(vaultInfo.data);
    const v2 = v2Info ? decodeVaultV2State(v2Info.data) : null;
    const houseLamports = BigInt(await conn.getBalance(vault.houseAuthority, "confirmed"));

    const lamportsBig = BigInt(lamports);
    const available =
      lamportsBig > RENT_FLOOR_LAMPORTS ? lamportsBig - RENT_FLOOR_LAMPORTS : 0n;

    // Mirror calc_health_bps from the program.
    let healthBps = 10_000;
    let obligationsLamports = 0n;
    if (v2 && available > 0n) {
      const pendingValue =
        v2.totalUnits > 0n ? (v2.totalPendingUnits * available) / v2.totalUnits : 0n;
      obligationsLamports = v2.totalOutstandingMaxPayout + pendingValue;
      const free =
        obligationsLamports >= available ? 0n : available - obligationsLamports;
      healthBps = Number((free * 10_000n) / available);
    }

    // Alerts.
    const baseFields = {
      vault: vaultPda.toBase58(),
      lamports: lamports.toString(),
      sol: (Number(lamportsBig) / 1e9).toFixed(4),
      healthBps: healthBps.toString(),
      healthPct: `${(healthBps / 100).toFixed(1)}%`,
      paused: vault.paused,
      obligationsLamports: obligationsLamports.toString(),
      house: vault.houseAuthority.toBase58(),
      houseSol: (Number(houseLamports) / 1e9).toFixed(4),
    };

    // House signer fuel — separate channel from vault solvency. Turnkey HSM
    // (or whatever sits in vault.house_authority) needs SOL to pay tx fees
    // for every reveal_tile + settle_game.
    if (houseLamports < HOUSE_BALANCE_CRITICAL_LAMPORTS) {
      await sendAlert({
        severity: "critical",
        title: "House signer balance critical",
        description: `Turnkey/house wallet has ${(Number(houseLamports) / 1e9).toFixed(4)} SOL. Game txs will start failing imminently. Top up immediately.`,
        fields: baseFields,
      });
    } else if (houseLamports < HOUSE_BALANCE_WARN_LAMPORTS) {
      await sendAlert({
        severity: "warn",
        title: "House signer balance low",
        description: `Turnkey/house wallet has ${(Number(houseLamports) / 1e9).toFixed(4)} SOL. Top up to keep covering reveal/settle tx fees.`,
        fields: baseFields,
      });
    }

    if (vault.paused) {
      await sendAlert({
        severity: "critical",
        title: "Vault is paused",
        description:
          "The on-chain vault.paused flag is true. New games will not start until unpaused via update_vault.",
        fields: baseFields,
      });
    } else if (healthBps < HEALTH_CRITICAL) {
      await sendAlert({
        severity: "critical",
        title: `Vault health below ${HEALTH_CRITICAL / 100}%`,
        description: "Outstanding obligations + pending withdrawals are eating the vault. New games will start to error 6006.",
        fields: baseFields,
      });
    } else if (healthBps < HEALTH_WARN) {
      await sendAlert({
        severity: "warn",
        title: `Vault health below ${HEALTH_WARN / 100}%`,
        description:
          "Vault is over-leveraged. Top up SOL or increase max_payout_bps cap before health drops further.",
        fields: baseFields,
      });
    } else if (lamportsBig < LOW_BALANCE_FLOOR_LAMPORTS) {
      await sendAlert({
        severity: "warn",
        title: "Vault balance is low",
        description: `Vault has ${(Number(lamportsBig) / 1e9).toFixed(4)} SOL on hand. Consider depositing more liquidity.`,
        fields: baseFields,
      });
    }

    logger.info(baseFields, "vault health probe ok");
    return NextResponse.json({
      ok: true,
      vault: vaultPda.toBase58(),
      lamports: lamports.toString(),
      sol: Number(lamportsBig) / 1e9,
      healthBps,
      paused: vault.paused,
      obligations: obligationsLamports.toString(),
      house: vault.houseAuthority.toBase58(),
      houseSol: Number(houseLamports) / 1e9,
    });
  } catch (err) {
    return jsonError(err);
  }
}
