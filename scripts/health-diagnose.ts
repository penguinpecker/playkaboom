import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  decodeGameSession,
  decodeVault,
  decodeVaultV2State,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";
import { createClient } from "@supabase/supabase-js";

const PROGRAM_ID = new PublicKey("9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh");
const GAMESESSION_DATASIZE = 180;

async function main() {
  const rpc = process.env.SOLANA_RPC;
  if (!rpc) throw new Error("SOLANA_RPC not set");
  const conn = new Connection(rpc, "confirmed");

  const [vaultPda] = deriveVaultPda(PROGRAM_ID);
  const [v2Pda] = deriveV2StatePda(PROGRAM_ID);
  const [vaultInfo, v2Info] = await Promise.all([
    conn.getAccountInfo(vaultPda, "confirmed"),
    conn.getAccountInfo(v2Pda, "confirmed"),
  ]);
  if (!vaultInfo || !v2Info) throw new Error("vault/v2 missing");
  decodeVault(vaultInfo.data);
  const v2 = decodeVaultV2State(v2Info.data);
  const rent = BigInt(
    await conn.getMinimumBalanceForRentExemption(vaultInfo.data.length),
  );
  const assets = BigInt(vaultInfo.lamports) - rent;
  const pendingValue =
    v2.totalUnits === 0n ? 0n : (v2.totalPendingUnits * assets) / v2.totalUnits;
  const obligations = v2.totalOutstandingMaxPayout + pendingValue;
  const free = assets > obligations ? assets - obligations : 0n;
  const health = Number((free * 10000n) / assets);
  console.log("vaultAssets (SOL)        :", (Number(assets) / LAMPORTS_PER_SOL).toFixed(6));
  console.log("totalOutstandingMaxPayout:",
    (Number(v2.totalOutstandingMaxPayout) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
  console.log("health_bps               :", health, `(${(health / 100).toFixed(2)}%)`);

  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: GAMESESSION_DATASIZE }],
    commitment: "confirmed",
  });

  const slot = BigInt(await conn.getSlot("confirmed"));
  console.log("currentSlot              :", slot.toString());
  console.log();

  const stuck: { pda: PublicKey; player: PublicKey; maxPayout: bigint; status: string; settled: boolean; startSlot: bigint }[] = [];
  for (const a of accounts) {
    let g;
    try { g = decodeGameSession(a.account.data); } catch { continue; }
    const contributes =
      g.status === "Playing" ||
      ((g.status === "Won" || g.status === "Lost") && !g.settled);
    if (!contributes) continue;
    stuck.push({
      pda: a.pubkey,
      player: g.player,
      maxPayout: BigInt(g.maxPayout),
      status: g.status,
      settled: g.settled,
      startSlot: BigInt(g.startSlot),
    });
  }
  stuck.sort((a, b) => Number(b.maxPayout - a.maxPayout));

  console.log("Outstanding game sessions:");
  for (const s of stuck) {
    const ageSlots = slot - s.startSlot;
    const ageSec = Number(ageSlots) * 0.4;
    console.log(
      `  ${s.pda.toBase58()}  player=${s.player.toBase58()}  status=${s.status}${s.settled ? "(settled)" : ""}  maxPayout=${(Number(s.maxPayout) / LAMPORTS_PER_SOL).toFixed(6)} SOL  age=${ageSlots} slots (~${(ageSec / 3600).toFixed(2)}h)  startSlot=${s.startSlot}`,
    );
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supaUrl && supaKey && stuck.length > 0) {
    const sb = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
    console.log("\nSupabase session lookup:");
    for (const s of stuck) {
      const { data, error } = await sb
        .from("game_sessions")
        .select("game,created_at")
        .eq("game", s.pda.toBase58())
        .maybeSingle();
      if (error) {
        console.log(`  ${s.pda.toBase58()}: ERROR ${error.message}`);
      } else if (!data) {
        console.log(`  ${s.pda.toBase58()}: NO session row — needs player-signed close_unsettled_game (after slot+600)`);
      } else {
        console.log(`  ${s.pda.toBase58()}: session present (created ${data.created_at}) -> server-fixable via /api/admin/release-stuck-obligations`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
