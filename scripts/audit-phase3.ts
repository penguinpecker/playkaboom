/**
 * End-to-end audit. Reads every Phase 1/2 PDA + Supabase table and prints a
 * concise health report.
 *
 *   PROGRAM_ID=4rPEGz... npx tsx --env-file=apps/web/.env.local \
 *     scripts/audit-phase3.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  decodeLpPosition,
  decodeVault,
  decodeVaultV2State,
  deriveLpPositionPda,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";
import { createClient } from "@supabase/supabase-js";

const env = (k: string, fallback?: string) => {
  const v = process.env[k];
  if (v == null && fallback === undefined) throw new Error(`Missing ${k}`);
  return v ?? fallback!;
};

async function main() {
  const programId = new PublicKey(env("PROGRAM_ID"));
  const rpc = env("SOLANA_RPC", "https://api.devnet.solana.com");
  const conn = new Connection(rpc, "confirmed");

  const owner = JSON.parse(
    readFileSync(resolve(homedir(), ".config/solana/id.json"), "utf8"),
  ) as number[];
  const ownerPk = new PublicKey(
    Buffer.from(owner.slice(32)).slice(0, 32), // public key is the last 32 bytes
  );

  const [vaultPda] = deriveVaultPda(programId);
  const [v2Pda] = deriveV2StatePda(programId);

  console.log("─ Devnet on-chain audit ─");
  console.log("  Program  :", programId.toBase58());
  console.log("  Vault    :", vaultPda.toBase58());
  console.log("  V2State  :", v2Pda.toBase58());

  const [vaultInfo, v2Info] = await Promise.all([
    conn.getAccountInfo(vaultPda, "confirmed"),
    conn.getAccountInfo(v2Pda, "confirmed"),
  ]);
  if (!vaultInfo || !v2Info) {
    console.error("  ✗ vault or v2_state missing");
    process.exit(1);
  }

  const vault = decodeVault(vaultInfo.data);
  const v2 = decodeVaultV2State(v2Info.data);
  const rentVault = await conn.getMinimumBalanceForRentExemption(vaultInfo.data.length);
  const assets = BigInt(vaultInfo.lamports) - BigInt(rentVault);

  console.log("\n[Vault]");
  console.log("  owner          :", vault.owner.toBase58());
  console.log("  treasury       :", vault.treasury.toBase58());
  console.log("  house_authority:", vault.houseAuthority.toBase58());
  console.log("  pendingOwner   :", vault.pendingOwner?.toBase58() ?? "null");
  console.log("  paused         :", vault.paused);
  console.log(
    "  bps            : edge=" + vault.houseEdgeBps + " maxBet=" + vault.maxBetBps + " maxPayout=" + vault.maxPayoutBps + " split=" + vault.treasurySplitBps,
  );
  console.log("  allowlist      :", vault.withdrawAllowlist.map((p) => p.toBase58()));

  console.log("\n[VaultV2State]");
  console.log("  vaultLamports  :", vaultInfo.lamports, `(${(vaultInfo.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log("  vaultAssets    :", assets.toString(), `(${(Number(assets) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log("  total_units    :", v2.totalUnits.toString());
  console.log("  seed_units     :", v2.seedUnits.toString());
  console.log("  house_units    :", v2.houseUnits.toString());
  console.log("  house_pending  :", v2.housePendingUnits.toString());
  console.log("  total_pending  :", v2.totalPendingUnits.toString());
  console.log("  outstanding    :", v2.totalOutstandingMaxPayout.toString());
  console.log(
    "  config         : minHouse=" +
      v2.minHouseShareBps +
      " maxUserPos=" +
      v2.maxUserPositionBps +
      " minHealth=" +
      v2.minHealthBps +
      " cooldown=" +
      v2.withdrawCooldownSlots.toString() +
      "slots minDep=" +
      v2.minLpDeposit.toString(),
  );

  // Invariant: seed + house + house_pending + Σ(users) === total_units
  const sumExceptUsers = v2.seedUnits + v2.houseUnits + v2.housePendingUnits;
  const userTotalImpliedByMath = v2.totalUnits - sumExceptUsers;
  console.log("\n[Invariants]");
  console.log("  Σ(seed + house + house_pending) =", sumExceptUsers.toString());
  console.log("  total_units − that            =", userTotalImpliedByMath.toString(), "← should equal Σ(user units + pending)");

  // Read all known LpPositions by walking program accounts. Filter for the
  // discriminator. Cheap on devnet.
  // We just check the owner key as a sanity LP position (set by lp-smoke earlier).
  const [posPda] = deriveLpPositionPda(programId, ownerPk);
  const posInfo = await conn.getAccountInfo(posPda, "confirmed");
  console.log("\n[LpPosition for owner key " + ownerPk.toBase58() + "]");
  if (!posInfo) {
    console.log("  none");
  } else {
    const pos = decodeLpPosition(posInfo.data);
    console.log("  units          :", pos.units.toString());
    console.log("  pending_units  :", pos.pendingUnits.toString());
    console.log("  unlock_slot    :", pos.pendingUnlockSlot.toString());
    console.log("  created_slot   :", pos.createdSlot.toString());
  }

  // Health factor (mirrors on-chain)
  const BPS = 10_000n;
  const pendingValue =
    v2.totalUnits === 0n ? 0n : (v2.totalPendingUnits * assets) / v2.totalUnits;
  const obligations = v2.totalOutstandingMaxPayout + pendingValue;
  const free = assets > obligations ? assets - obligations : 0n;
  const health = (free * BPS) / assets;
  console.log("\n[Health]");
  console.log("  pending_value :", pendingValue.toString());
  console.log("  obligations   :", obligations.toString());
  console.log("  free          :", free.toString());
  console.log("  health_bps    :", health.toString(), "/ 10000 =", (Number(health) / 100).toFixed(2) + "%");

  // ─── Indexer Supabase tables ───────────────────────────────────────────
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supaUrl && supaKey) {
    console.log("\n[Indexer (Supabase)]");
    const sb = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
    const tables = ["lp_positions", "lp_actions", "vault_unit_value_history"];
    for (const t of tables) {
      const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
      if (error) console.log(`  ${t}: error ${error.message}`);
      else console.log(`  ${t}: ${count ?? 0} rows`);
    }
  } else {
    console.log("\n[Indexer]");
    console.log("  Supabase env not set (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — skipping.");
  }

  console.log("\n✓ audit complete");
}

main().catch((err) => {
  console.error("audit failed:", err);
  process.exit(1);
});
