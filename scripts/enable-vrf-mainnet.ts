/**
 * Arm VRF mode on MAINNET (relaunch program): update_v2_config with
 * vrf_mode_enabled = true, vrf_validator = the pinned MagicBlock validator and
 * vrf_max_payout_bps = --max-payout-bps. Without it every delegate_vrf fails
 * 6053 VrfValidatorNotSet and nobody can play.
 *
 *   DRY_RUN=1 SOLANA_MAINNET_RPC=... npx tsx scripts/enable-vrf-mainnet.ts --max-payout-bps <BPS>
 *   SOLANA_MAINNET_RPC=... npx tsx scripts/enable-vrf-mainnet.ts --max-payout-bps <BPS>
 *
 * Signed by the vault owner (OWNER_KEYPAIR, default keypairs/mainnet-deployer.json).
 * Run after init-v2-mainnet.ts and BEFORE moving ownership to Squads (after
 * that, propose the same instruction through Squads).
 *
 * The validator is hard-coded: it must name the same node as the browser's
 * NEXT_PUBLIC_ER_RPC (https://as.magicblock.app/). Changing one without the
 * other strands every new game (see apps/web/src/lib/cluster.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { buildUpdateV2Config, decodeVaultV2State, deriveV2StatePda } from "@playkaboom/sdk";
import { KABOOM_PROGRAM_ID } from "@playkaboom/shared";

const PROGRAM_ID = new PublicKey(KABOOM_PROGRAM_ID);
const VRF_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"); // as.magicblock.app
const RPC = process.env.SOLANA_MAINNET_RPC ?? (() => {
  throw new Error("SOLANA_MAINNET_RPC is not set");
})();

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

async function main() {
  const i = process.argv.indexOf("--max-payout-bps");
  const bps = Number(i >= 0 ? process.argv[i + 1] : NaN);
  if (!Number.isInteger(bps) || bps <= 0 || bps > 10_000) {
    throw new Error("--max-payout-bps <1..10000> is required (owner choice; FIXES.md 9.6: lower is safer)");
  }
  const owner = loadKeypair(resolve(process.cwd(), process.env.OWNER_KEYPAIR ?? "keypairs/mainnet-deployer.json"));
  const conn = new Connection(RPC, "confirmed");
  const [v2Pda] = deriveV2StatePda(PROGRAM_ID);
  const info = await conn.getAccountInfo(v2Pda, "confirmed");
  if (!info) throw new Error("V2State not initialized — run init-v2-mainnet.ts first");
  const v2 = decodeVaultV2State(info.data);

  console.log("─ enable VRF mode on MAINNET ─");
  console.log("  Program          :", PROGRAM_ID.toBase58());
  console.log("  Owner            :", owner.publicKey.toBase58());
  console.log("  Validator        :", VRF_VALIDATOR.toBase58());
  console.log("  vrf_max_payout   :", bps, "bps");
  console.log("  now              : enabled", v2.vrfModeEnabled, "validator", v2.vrfValidator.toBase58(), "max", v2.vrfMaxPayoutBps);
  if (v2.withdrawCooldownSlots < 450_000n) {
    console.warn(`  ! withdraw_cooldown_slots is ${v2.withdrawCooldownSlots}; the F4 rule wants >= 450,000`);
  }

  const ix = buildUpdateV2Config({
    ctx: { programId: PROGRAM_ID },
    owner: owner.publicKey,
    vrfModeEnabled: true,
    vrfValidator: VRF_VALIDATOR,
    vrfMaxPayoutBps: bps,
  });
  if (process.env.DRY_RUN) {
    console.log("\n  DRY_RUN=1 — not sending.");
    return;
  }
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = owner.publicKey;
  tx.sign(owner);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("  Sig:", sig);
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error("update_v2_config failed: " + JSON.stringify(conf.value.err));
  const after = decodeVaultV2State((await conn.getAccountInfo(v2Pda, "confirmed"))!.data);
  console.log("  after            : enabled", after.vrfModeEnabled, "validator", after.vrfValidator.toBase58(), "max", after.vrfMaxPayoutBps);
}

main().catch((err) => {
  console.error("\n✗ enable-vrf-mainnet failed:", err.message ?? err);
  process.exit(1);
});
