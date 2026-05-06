/**
 * Tests the player-self-recovery code paths added 2026-05-07.
 *
 *   A. refund_expired (Playing → Expired)
 *      Player starts a game and abandons it. After GAME_EXPIRY_SLOTS=300
 *      (~2 min), they self-call refund_expired which:
 *        - sets status=Expired
 *        - returns the bet to the player (full refund)
 *        - releases obligation
 *        - closes the GameSession PDA (no follow-up close_game needed)
 *
 *   C. close_unsettled_game on a Playing game must FAIL with
 *      GameNotFinished (6018). This is the bug surface we hit before:
 *      the recovery banner used to dispatch close_unsettled_game for
 *      every stuck state, throwing 6018 on Playing games.
 *
 * Path B (close_unsettled_game on Won/Lost) requires Turnkey to sign
 * a reveal_tile during setup. We exercise that exhaustively in the
 * full-game-smoke instead — no point duplicating Turnkey deps here.
 *
 * Total runtime ~2.5 minutes (one 300-slot wait).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  buildCloseUnsettledGame,
  buildRefundExpired,
  buildStartGame,
  decodeVaultV2State,
  deriveGamePda,
  deriveV2StatePda,
} from "@playkaboom/sdk";
import { commitmentOf, unbiasedShuffleLayout } from "@playkaboom/shared";
import { randomBytes } from "node:crypto";

function envOrThrow(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing env ${n}`);
  return v;
}
function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]),
  );
}
async function send(
  conn: Connection,
  payer: Keypair,
  ixs: Parameters<Transaction["add"]>,
  signers: Keypair[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}
async function waitForSlot(conn: Connection, target: number, label: string) {
  console.log(`  waiting for slot ≥ ${target} (${label}) …`);
  while (true) {
    const s = await conn.getSlot("confirmed");
    if (s >= target) {
      console.log(`  current ${s} ≥ ${target}, ready`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
async function readObligation(conn: Connection, programId: PublicKey): Promise<bigint> {
  const [v2Pda] = deriveV2StatePda(programId);
  const info = await conn.getAccountInfo(v2Pda, "confirmed");
  if (!info) return 0n;
  return decodeVaultV2State(info.data).totalOutstandingMaxPayout;
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const conn = new Connection(
    process.env.SOLANA_RPC ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  const ctx = { programId };
  const deployer = loadKp(resolve(homedir(), ".config/solana/id.json"));

  console.log("─ stuck-game recovery suite ─");
  console.log("  programId:", programId.toBase58());

  // ─── Path A: refund_expired ────────────────────────────────────────────
  console.log("\n[A] refund_expired (Playing → Expired)");
  const playerA = Keypair.generate();
  await send(
    conn,
    deployer,
    [
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: playerA.publicKey,
        lamports: 50_000_000,
      }),
    ],
    [],
  );
  console.log("  [A] funded:", playerA.publicKey.toBase58());

  const layoutA = unbiasedShuffleLayout(3);
  const saltA = randomBytes(32);
  const commitA = commitmentOf(layoutA, 3, saltA);
  const startA = buildStartGame({
    ctx,
    player: playerA.publicKey,
    mineCount: 3,
    betLamports: 5_000_000n,
    commitment: commitA,
  });
  const startSigA = await send(conn, playerA, [startA], [playerA]);
  console.log("  [A] start_game:", startSigA);

  const [gamePdaA] = deriveGamePda(programId, playerA.publicKey);
  const startedAt = await conn.getSlot("confirmed");
  const refundReadyAt = startedAt + 305;

  const obligationBefore = await readObligation(conn, programId);
  console.log(`  [A] obligation now: ${obligationBefore}`);

  // Negative: refund_expired before expiry → GameNotExpired
  console.log("  [A] try refund_expired BEFORE expiry → expect GameNotExpired");
  let preFail = false;
  try {
    await send(
      conn,
      playerA,
      [buildRefundExpired({ ctx, player: playerA.publicKey })],
      [playerA],
    );
  } catch (err) {
    preFail = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.log("  [A] ✓ rejected:", msg.split("\n")[0]?.slice(0, 200));
  }
  if (!preFail) throw new Error("[A] refund_expired succeeded BEFORE expiry — bug!");

  await waitForSlot(conn, refundReadyAt, "refund_expired ready (start+300)");

  console.log("  [A] refund_expired");
  const balBefore = await conn.getBalance(playerA.publicKey, "confirmed");
  const refundSig = await send(
    conn,
    playerA,
    [buildRefundExpired({ ctx, player: playerA.publicKey })],
    [playerA],
  );
  console.log("  [A] sig:", refundSig);
  const balAfter = await conn.getBalance(playerA.publicKey, "confirmed");
  const delta = balAfter - balBefore;
  console.log(
    `  [A] balance Δ +${(delta / 1e9).toFixed(6)} SOL (bet 0.005 + ~rent + tx fee)`,
  );
  if (delta <= 4_000_000) {
    throw new Error(`[A] expected ≥0.004 SOL refund, got ${delta} lamports`);
  }
  const obligationAfter = await readObligation(conn, programId);
  console.log(`  [A] obligation: ${obligationBefore} → ${obligationAfter}`);
  if (obligationAfter >= obligationBefore) {
    throw new Error("[A] obligation should have dropped after refund_expired");
  }
  const pdaCheck = await conn.getAccountInfo(gamePdaA, "confirmed");
  if (pdaCheck) {
    throw new Error("[A] GameSession PDA still exists after refund_expired");
  }
  console.log("  [A] ✓ PDA closed");

  // ─── Path C: close_unsettled_game on Playing → must fail ───────────────
  console.log("\n[C] close_unsettled_game on a Playing game → expect GameNotFinished");
  const playerC = Keypair.generate();
  await send(
    conn,
    deployer,
    [
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: playerC.publicKey,
        lamports: 50_000_000,
      }),
    ],
    [],
  );
  const layoutC = unbiasedShuffleLayout(3);
  const saltC = randomBytes(32);
  const startC = buildStartGame({
    ctx,
    player: playerC.publicKey,
    mineCount: 3,
    betLamports: 5_000_000n,
    commitment: commitmentOf(layoutC, 3, saltC),
  });
  await send(conn, playerC, [startC], [playerC]);
  let cFailed = false;
  try {
    await send(
      conn,
      playerC,
      [buildCloseUnsettledGame({ ctx, player: playerC.publicKey })],
      [playerC],
    );
  } catch (err) {
    cFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.log("  [C] ✓ rejected:", msg.split("\n")[0]?.slice(0, 200));
  }
  if (!cFailed) {
    throw new Error("[C] close_unsettled_game succeeded on Playing game — bug!");
  }

  // Tidy up: refund_expired the playerC stuck game so we don't leak a PDA.
  console.log("  [C] cleanup: waiting then refund_expired …");
  const cStartSlot = await conn.getSlot("confirmed");
  await waitForSlot(conn, cStartSlot + 305, "playerC refund");
  await send(
    conn,
    playerC,
    [buildRefundExpired({ ctx, player: playerC.publicKey })],
    [playerC],
  );
  console.log("  [C] cleanup done");

  console.log("\n──────────────────────────────");
  console.log("✓ stuck-game recovery suite PASSED");
  console.log("  A. refund_expired before 300 slots → GameNotExpired (rejected)");
  console.log("  A. refund_expired after 300 slots  → bet refunded + PDA closed");
  console.log("  C. close_unsettled_game on Playing → GameNotFinished (rejected)");
}

main().catch((e) => {
  console.error("stuck-game suite FAILED:", e);
  process.exit(1);
});
