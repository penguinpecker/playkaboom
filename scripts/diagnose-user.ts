import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  decodeGameSession,
  decodeLpPosition,
  decodeVault,
  decodeVaultV2State,
  deriveLpPositionPda,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";

const PROGRAM_ID = new PublicKey("9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh");
const GAMESESSION_SIZE = 180;

async function main() {
  const wallet = new PublicKey(process.argv[2]);
  const rpc = process.env.SOLANA_RPC!;
  const conn = new Connection(rpc, "confirmed");

  const [vaultPda] = deriveVaultPda(PROGRAM_ID);
  const [v2Pda] = deriveV2StatePda(PROGRAM_ID);
  const [lpPda] = deriveLpPositionPda(PROGRAM_ID, wallet);
  const [vaultInfo, v2Info, lpInfo] = await Promise.all([
    conn.getAccountInfo(vaultPda, "confirmed"),
    conn.getAccountInfo(v2Pda, "confirmed"),
    conn.getAccountInfo(lpPda, "confirmed"),
  ]);
  if (!vaultInfo || !v2Info) throw new Error("vault missing");
  const vault = decodeVault(vaultInfo.data);
  const v2 = decodeVaultV2State(v2Info.data);
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(vaultInfo.data.length));
  const vaultAssets = BigInt(vaultInfo.lamports) - rent;

  const pendingValue = v2.totalUnits === 0n ? 0n : (v2.totalPendingUnits * vaultAssets) / v2.totalUnits;
  const obligations = v2.totalOutstandingMaxPayout + pendingValue;
  const free = vaultAssets > obligations ? vaultAssets - obligations : 0n;
  const healthBps = Number((free * 10000n) / vaultAssets);

  // Per-user cap formula (mirrors effectiveMaxUserPositionLamports)
  const BPS = 10000n;
  const cap =
    v2.maxUserPositionBps === 0
      ? vaultAssets
      : (((vaultAssets * BigInt(v2.maxUserPositionBps)) / BPS) * BigInt(healthBps)) / BPS;

  console.log("─ Vault state ─");
  console.log("  vaultAssets       :", (Number(vaultAssets) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
  console.log("  health_bps        :", healthBps, `(${(healthBps / 100).toFixed(2)}%)`);
  console.log("  maxUserPositionBps:", v2.maxUserPositionBps);
  console.log("  per-user cap      :", (Number(cap) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
  console.log("  minLpDeposit      :", (Number(v2.minLpDeposit) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
  console.log("  paused            :", vault.paused);

  console.log("\n─ LpPosition for", wallet.toBase58(), "─");
  if (!lpInfo) {
    console.log("  none");
  } else {
    const pos = decodeLpPosition(lpInfo.data);
    const totalUnits = pos.units + pos.pendingUnits;
    const currentValueLamports =
      v2.totalUnits === 0n ? 0n : (totalUnits * vaultAssets) / v2.totalUnits;
    const headroom = cap > currentValueLamports ? cap - currentValueLamports : 0n;
    console.log("  units             :", pos.units.toString());
    console.log("  pending_units     :", pos.pendingUnits.toString());
    console.log("  total_units       :", totalUnits.toString());
    console.log("  current value     :", (Number(currentValueLamports) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
    console.log("  cap               :", (Number(cap) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
    console.log("  headroom          :", (Number(headroom) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
    console.log("  pending_unlock    :", pos.pendingUnlockSlot.toString());
  }

  console.log("\n─ Open GameSessions where player ==", wallet.toBase58(), "─");
  const games = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: GAMESESSION_SIZE },
      { memcmp: { offset: 8, bytes: wallet.toBase58() } },
    ],
    commitment: "confirmed",
  });
  if (games.length === 0) {
    console.log("  (none open)");
  } else {
    const slot = BigInt(await conn.getSlot("confirmed"));
    for (const a of games) {
      let g;
      try { g = decodeGameSession(a.account.data); } catch { continue; }
      const age = slot - BigInt(g.startSlot);
      console.log(
        `  ${a.pubkey.toBase58()}  status=${g.status}  settled=${g.settled}  bet=${(Number(g.bet) / LAMPORTS_PER_SOL).toFixed(6)}  startSlot=${g.startSlot} age=${age}slots (~${(Number(age) * 0.4 / 60).toFixed(1)}m)`,
      );
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
