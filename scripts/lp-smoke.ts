/**
 * Smoke test for the Phase 2 LP flow.
 *
 *   PROGRAM_ID=4rPEGz... npx tsx --env-file=apps/web/.env.local \
 *     scripts/lp-smoke.ts
 *
 * Path:
 *   1. Read v2_state, print baseline (seed/house/total units, unit_value).
 *   2. lp_deposit 0.1 SOL from owner key (acts as a test LP for this run).
 *   3. Read position + v2_state — verify units minted and counters updated.
 *   4. request_withdraw on all the freshly-minted units.
 *   5. Read position — verify pending_units + unlock_slot.
 *
 * Doesn't run complete_withdraw because the cooldown is 3 days. To exercise
 * complete_withdraw, owner can `update_v2_config(withdraw_cooldown_slots=1)`
 * via Squads first; this script doesn't do that automatically.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  buildLpDeposit,
  buildRequestWithdraw,
  decodeLpPosition,
  decodeVaultV2State,
  deriveLpPositionPda,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

  const user = loadKeypair(resolve(homedir(), ".config/solana/id.json"));
  const ctx = { programId };
  const conn = new Connection(rpc, "confirmed");
  const [vaultPda] = deriveVaultPda(programId);
  const [v2StatePda] = deriveV2StatePda(programId);
  const [positionPda] = deriveLpPositionPda(programId, user.publicKey);

  console.log("─ LP smoke ─");
  console.log("  Program     :", programId.toBase58());
  console.log("  User        :", user.publicKey.toBase58());
  console.log("  Vault PDA   :", vaultPda.toBase58());
  console.log("  v2_state    :", v2StatePda.toBase58());
  console.log("  Position PDA:", positionPda.toBase58());

  const v2Info = await conn.getAccountInfo(v2StatePda, "confirmed");
  if (!v2Info) throw new Error("v2_state not initialized — run scripts/initialize-v2.ts first");
  const v2 = decodeVaultV2State(v2Info.data);
  const vaultBalance = await conn.getBalance(vaultPda, "confirmed");
  const rentMin = await conn.getMinimumBalanceForRentExemption(428);
  const assetsPre = vaultBalance - rentMin;

  console.log("\nBaseline:");
  console.log("  vault.lamports         :", vaultBalance, `(${(vaultBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log("  vault_assets (≈)       :", assetsPre, `(${(assetsPre / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log("  v2.total_units         :", v2.totalUnits.toString());
  console.log("  v2.house_units         :", v2.houseUnits.toString());
  console.log("  v2.seed_units          :", v2.seedUnits.toString());
  console.log("  v2.total_pending_units :", v2.totalPendingUnits.toString());
  console.log("  v2.min_house_share_bps :", v2.minHouseShareBps);
  console.log("  v2.max_user_pos_bps    :", v2.maxUserPositionBps);
  console.log("  v2.min_health_bps      :", v2.minHealthBps);
  console.log("  v2.cooldown_slots      :", v2.withdrawCooldownSlots.toString());
  console.log("  v2.min_lp_deposit      :", v2.minLpDeposit.toString());

  // Step 2 — deposit
  const depositAmount = 100_000_000n; // 0.1 SOL
  console.log(`\n[2/5] lp_deposit ${(Number(depositAmount) / LAMPORTS_PER_SOL).toFixed(3)} SOL …`);
  const ix1 = buildLpDeposit({ ctx, user: user.publicKey, amountLamports: depositAmount });
  let { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  let tx = new Transaction().add(ix1);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user.publicKey;
  tx.sign(user);
  let sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("       sig:", sig);

  // Step 3 — read post state
  const posInfo = await conn.getAccountInfo(positionPda, "confirmed");
  if (!posInfo) throw new Error("position PDA not created");
  const pos = decodeLpPosition(posInfo.data);
  const v2InfoAfter = await conn.getAccountInfo(v2StatePda, "confirmed");
  const v2After = decodeVaultV2State(v2InfoAfter!.data);

  console.log("\n[3/5] Post-deposit:");
  console.log("  position.units          :", pos.units.toString());
  console.log("  position.pending_units  :", pos.pendingUnits.toString());
  console.log("  v2.total_units          :", v2After.totalUnits.toString());
  const unitsMinted = v2After.totalUnits - v2.totalUnits;
  console.log("  units minted            :", unitsMinted.toString());
  if (pos.units !== unitsMinted) {
    throw new Error(
      `position.units (${pos.units}) != minted (${unitsMinted})`,
    );
  }

  // Step 4 — request_withdraw all units
  console.log(`\n[4/5] request_withdraw ${pos.units.toString()} units …`);
  const ix2 = buildRequestWithdraw({ ctx, user: user.publicKey, units: pos.units });
  ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed"));
  tx = new Transaction().add(ix2);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user.publicKey;
  tx.sign(user);
  sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("       sig:", sig);

  // Step 5 — verify pending state
  const posFinal = decodeLpPosition((await conn.getAccountInfo(positionPda, "confirmed"))!.data);
  const v2Final = decodeVaultV2State((await conn.getAccountInfo(v2StatePda, "confirmed"))!.data);
  console.log("\n[5/5] Post-request:");
  console.log("  position.units          :", posFinal.units.toString());
  console.log("  position.pending_units  :", posFinal.pendingUnits.toString());
  console.log("  position.unlock_slot    :", posFinal.pendingUnlockSlot.toString());
  console.log("  v2.total_pending_units  :", v2Final.totalPendingUnits.toString());

  if (posFinal.units !== 0n || posFinal.pendingUnits !== unitsMinted) {
    throw new Error("request_withdraw did not move units to pending");
  }
  console.log("\n✓ LP smoke green. complete_withdraw will unlock at slot", posFinal.pendingUnlockSlot.toString(),
              `(in ${(Number(v2.withdrawCooldownSlots) * 0.4 / 86400).toFixed(2)} days at ~400ms/slot)`);
}

main().catch((err) => {
  console.error("lp-smoke failed:", err);
  process.exit(1);
});
