import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { decodeReferralAccount } from "@playkaboom/sdk";

const PROGRAM_ID = new PublicKey("Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju"); // relaunch program (old id closed)
const REFERRAL_SEED = Buffer.from("kaboom_referral");

async function main() {
  const referrer = new PublicKey(process.argv[2]);
  const conn = new Connection(process.env.SOLANA_RPC!, "confirmed");
  const [pda] = PublicKey.findProgramAddressSync(
    [REFERRAL_SEED, referrer.toBuffer()],
    PROGRAM_ID,
  );
  const info = await conn.getAccountInfo(pda, "confirmed");
  if (!info) {
    console.log("No ReferralAccount for", referrer.toBase58());
    return;
  }
  const ra = decodeReferralAccount(info.data);
  console.log("ReferralAccount", pda.toBase58());
  console.log("  referrer        :", ra.referrer.toBase58());
  console.log("  tier            :", ra.tier);
  console.log("  referred_count  :", ra.referredCount);
  console.log("  referred_volume :", (Number(ra.referredVolume) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
  console.log("  accrued_lamports:", (Number(ra.accruedLamports) / LAMPORTS_PER_SOL).toFixed(9), "SOL (unclaimed)");
  console.log("  total_earned    :", (Number(ra.totalEarned) / LAMPORTS_PER_SOL).toFixed(9), "SOL (lifetime)");
}

main().catch((e) => { console.error(e); process.exit(1); });
