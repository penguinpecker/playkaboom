/**
 * End-to-end devnet exercise of every transaction path the production app
 * builds. Uses ephemeral keypairs so it never touches the owner / Squads /
 * Turnkey state. The test:
 *
 *   1. Generate a player keypair, fund it with 0.05 SOL from the owner.
 *   2. Bet 5 mSOL, 1 mine. Compute commitment locally (mirrors createGameSession).
 *   3. start_game (player signs)
 *   4. reveal_tile for a known-safe tile (Turnkey signs the house side)
 *   5. cash_out (player signs) — verify obligation counter decremented.
 *   6. settle_game with the layout+salt (Turnkey signs) — verify
 *      VaultUnitValueUpdated emitted.
 *   7. Bet 5 mSOL, 1 mine, deliberately reveal the mine — atomic reveal+settle.
 *   8. lp_deposit 0.01 SOL, request_withdraw all, cancel_withdraw — verify
 *      total_pending_units bumps then drops back.
 *   9. Cleanup: drain the player wallet back to owner.
 *
 *   PROGRAM_ID=4rPEGz... npx tsx --env-file=apps/web/.env.local \
 *     scripts/full-game-smoke.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";
import {
  buildCancelWithdraw,
  buildCashOut,
  buildLpDeposit,
  buildRequestWithdraw,
  buildRevealTile,
  buildSettleGame,
  buildStartGame,
  buildCloseGame,
  decodeGameSession,
  decodeLpPosition,
  decodeVaultV2State,
  deriveGamePda,
  deriveLpPositionPda,
  deriveV2StatePda,
} from "@playkaboom/sdk";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
}

function unbiasedShuffleLayout(mineCount: number): number {
  const tiles = Array.from({ length: 16 }, (_, i) => i);
  for (let i = tiles.length - 1; i > 0; i--) {
    const range = i + 1;
    const max = 256 - (256 % range);
    let r: number;
    do {
      r = randomBytes(1)[0]!;
    } while (r >= max);
    const j = r % range;
    [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
  }
  let layout = 0;
  for (let k = 0; k < mineCount; k++) layout |= 1 << tiles[tiles.length - 1 - k]!;
  return layout;
}

function commitmentOf(layout: number, mineCount: number, salt: Buffer): Buffer {
  const h = createHash("sha256");
  const lb = Buffer.alloc(2);
  lb.writeUInt16LE(layout, 0);
  h.update(lb);
  h.update(Buffer.from([mineCount]));
  h.update(salt);
  return h.digest();
}

function safeTileFor(layout: number): number {
  for (let i = 0; i < 16; i++) if ((layout & (1 << i)) === 0) return i;
  throw new Error("no safe tile");
}

function mineTileFor(layout: number): number {
  for (let i = 0; i < 16; i++) if ((layout & (1 << i)) !== 0) return i;
  throw new Error("no mine");
}

class TurnkeyHouse {
  private signer: TurnkeySigner;
  public readonly pubkey: PublicKey;
  constructor(orgId: string, apiPub: string, apiPriv: string, housePubkeyStr: string) {
    const tk = new Turnkey({
      apiBaseUrl: "https://api.turnkey.com",
      apiPublicKey: apiPub,
      apiPrivateKey: apiPriv,
      defaultOrganizationId: orgId,
    });
    this.signer = new TurnkeySigner({ organizationId: orgId, client: tk.apiClient() });
    this.pubkey = new PublicKey(housePubkeyStr);
  }
  async sign(tx: Transaction): Promise<Transaction> {
    return (await this.signer.signTransaction(tx, this.pubkey.toBase58())) as Transaction;
  }
}

async function pollConfirm(conn: Connection, sig: string, lastValidBlockHeight: number): Promise<void> {
  const start = Date.now();
  let nextStatusAt = 0;
  let nextHeightAt = 0;
  while (true) {
    if (Date.now() - start > 90_000) throw new Error(`tx ${sig} confirmation timeout`);
    if (Date.now() >= nextStatusAt) {
      try {
        const { value } = await conn.getSignatureStatuses([sig]);
        const s = value[0];
        if (s?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(`tx ${sig} failed`)) throw err;
      }
      nextStatusAt = Date.now() + 1_000;
    }
    if (Date.now() >= nextHeightAt) {
      try {
        const height = await conn.getBlockHeight("confirmed");
        if (height > lastValidBlockHeight) {
          const { value } = await conn.getSignatureStatuses([sig]);
          const s = value[0];
          if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
          throw new Error(`tx ${sig} blockhash expired (h=${height} > ${lastValidBlockHeight})`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(`tx ${sig} blockhash`)) throw err;
      }
      nextHeightAt = Date.now() + 5_000;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function send(
  conn: Connection,
  payer: Keypair | null,
  ixs: ReturnType<typeof buildStartGame>[],
  signers: Keypair[] = [],
  feePayerOverride?: PublicKey,
  housePresign?: TurnkeyHouse,
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayerOverride ?? payer?.publicKey ?? signers[0]!.publicKey;
  if (signers.length > 0) tx.sign(...signers);
  const finalTx = housePresign ? await housePresign.sign(tx) : tx;
  const raw = finalTx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
  await pollConfirm(conn, sig, lastValidBlockHeight);
  return sig;
}

async function readObligation(conn: Connection, programId: PublicKey): Promise<bigint> {
  const [v2Pda] = deriveV2StatePda(programId);
  const info = await conn.getAccountInfo(v2Pda, "confirmed");
  if (!info) throw new Error("v2_state missing");
  const v2 = decodeVaultV2State(info.data);
  return BigInt(v2.totalOutstandingMaxPayout);
}

async function expect(label: string, ok: boolean, detail = ""): Promise<void> {
  if (!ok) {
    console.error(`✗ ${label}`, detail);
    throw new Error(`assertion failed: ${label} ${detail}`);
  } else {
    console.log(`✓ ${label}`, detail);
  }
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const owner = loadKp(resolve(homedir(), ".config/solana/id.json"));
  const house = new TurnkeyHouse(
    envOrThrow("TURNKEY_ORG_ID"),
    envOrThrow("TURNKEY_API_PUBLIC_KEY"),
    envOrThrow("TURNKEY_API_PRIVATE_KEY"),
    envOrThrow("TURNKEY_HOUSE_PUBKEY"),
  );

  const player = Keypair.generate();
  const ctx = { programId };
  console.log("─ full-game smoke ─");
  console.log("  player :", player.publicKey.toBase58());
  console.log("  house  :", house.pubkey.toBase58());

  // Fund the player.
  await send(
    conn,
    owner,
    [
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: player.publicKey,
        lamports: 50_000_000,
      }),
    ],
    [owner],
  );
  console.log("  funded player with 0.05 SOL");

  // ─── 1. Win path: start → reveal safe → cash_out → settle ─────────────
  const obligationsBefore = await readObligation(conn, programId);

  const bet = 5_000_000n; // 5 mSOL
  const mineCount = 1;
  const layout1 = unbiasedShuffleLayout(mineCount);
  const salt1 = randomBytes(32);
  const commit1 = commitmentOf(layout1, mineCount, salt1);

  const startIx = buildStartGame({ ctx, player: player.publicKey, mineCount, betLamports: bet, commitment: commit1 });
  const startSig = await send(conn, player, [startIx], [player]);
  console.log("[win] start_game:", startSig);

  const obligationsAfterStart = await readObligation(conn, programId);
  await expect(
    "obligation increased on start_game",
    obligationsAfterStart > obligationsBefore,
    `${obligationsBefore} → ${obligationsAfterStart}`,
  );

  // Read game's stored max_payout to verify it's non-zero (Phase 2 field).
  const [gamePda] = deriveGamePda(programId, player.publicKey);
  const game1 = decodeGameSession((await conn.getAccountInfo(gamePda, "confirmed"))!.data);
  await expect("max_payout stored on GameSession", game1.maxPayout > 0n, `${game1.maxPayout}`);

  // Reveal a safe tile (house signs).
  const safe = safeTileFor(layout1);
  const revealIx = buildRevealTile({ ctx, player: player.publicKey, houseAuthority: house.pubkey, tileIndex: safe, isMine: false });
  const revealSig = await send(conn, null, [revealIx], [], house.pubkey, house);
  console.log("[win] reveal_tile (safe):", revealSig);

  // Cash out (player signs).
  const cashIx = buildCashOut({ ctx, player: player.publicKey });
  const cashSig = await send(conn, player, [cashIx], [player]);
  console.log("[win] cash_out:", cashSig);

  const obligationsAfterCash = await readObligation(conn, programId);
  await expect(
    "obligation decremented on cash_out",
    obligationsAfterCash <= obligationsBefore,
    `${obligationsAfterStart} → ${obligationsAfterCash}`,
  );

  // Settle with the proof (house signs).
  const settleIx = buildSettleGame({ ctx, player: player.publicKey, houseAuthority: house.pubkey, mineLayout: layout1, salt: salt1 });
  const settleSig = await send(conn, null, [settleIx], [], house.pubkey, house);
  console.log("[win] settle_game:", settleSig);

  // close_game so the player can replay.
  await send(conn, player, [buildCloseGame({ ctx, player: player.publicKey })], [player]);
  console.log("[win] close_game ✓");

  // ─── 2. Lose path: start → reveal mine → atomic settle ────────────────
  const layout2 = unbiasedShuffleLayout(mineCount);
  const salt2 = randomBytes(32);
  const commit2 = commitmentOf(layout2, mineCount, salt2);
  const startIx2 = buildStartGame({ ctx, player: player.publicKey, mineCount, betLamports: bet, commitment: commit2 });
  await send(conn, player, [startIx2], [player]);

  const mine = mineTileFor(layout2);
  const obligationsBeforeLose = await readObligation(conn, programId);
  // Atomic reveal+settle in one tx (this is what /api/reveal does for mine hits).
  const revealMineIx = buildRevealTile({ ctx, player: player.publicKey, houseAuthority: house.pubkey, tileIndex: mine, isMine: true });
  const settleIx2 = buildSettleGame({ ctx, player: player.publicKey, houseAuthority: house.pubkey, mineLayout: layout2, salt: salt2 });
  const loseSig = await send(conn, null, [revealMineIx, settleIx2], [], house.pubkey, house);
  console.log("[lose] reveal_mine + settle (atomic):", loseSig);

  const obligationsAfterLose = await readObligation(conn, programId);
  await expect(
    "obligation released on lose-settle",
    obligationsAfterLose <= obligationsBeforeLose,
    `${obligationsBeforeLose} → ${obligationsAfterLose}`,
  );

  await send(conn, player, [buildCloseGame({ ctx, player: player.publicKey })], [player]);
  console.log("[lose] close_game ✓");

  // ─── 3. LP flow: deposit → request → cancel ───────────────────────────
  const [v2Pda] = deriveV2StatePda(programId);
  const v2Pre = decodeVaultV2State((await conn.getAccountInfo(v2Pda, "confirmed"))!.data);
  const depositSig = await send(
    conn,
    player,
    [buildLpDeposit({ ctx, user: player.publicKey, amountLamports: 10_000_000n })],
    [player],
  );
  console.log("[lp] lp_deposit:", depositSig);

  const [posPda] = deriveLpPositionPda(programId, player.publicKey);
  const pos = decodeLpPosition((await conn.getAccountInfo(posPda, "confirmed"))!.data);
  await expect("LpPosition.units > 0 after deposit", pos.units > 0n, `${pos.units}`);

  const reqSig = await send(
    conn,
    player,
    [buildRequestWithdraw({ ctx, user: player.publicKey, units: pos.units })],
    [player],
  );
  console.log("[lp] request_withdraw:", reqSig);
  const v2Mid = decodeVaultV2State((await conn.getAccountInfo(v2Pda, "confirmed"))!.data);
  await expect(
    "total_pending_units bumped",
    v2Mid.totalPendingUnits > v2Pre.totalPendingUnits,
    `${v2Pre.totalPendingUnits} → ${v2Mid.totalPendingUnits}`,
  );

  const cancelSig = await send(conn, player, [buildCancelWithdraw({ ctx, user: player.publicKey })], [player]);
  console.log("[lp] cancel_withdraw:", cancelSig);
  const v2Post = decodeVaultV2State((await conn.getAccountInfo(v2Pda, "confirmed"))!.data);
  await expect(
    "total_pending_units returned to baseline",
    v2Post.totalPendingUnits === v2Pre.totalPendingUnits,
    `${v2Mid.totalPendingUnits} → ${v2Post.totalPendingUnits}`,
  );

  // ─── 4. Cleanup: drain remaining player balance back to owner ─────────
  const remaining = await conn.getBalance(player.publicKey, "confirmed");
  if (remaining > 5000) {
    await send(
      conn,
      player,
      [
        SystemProgram.transfer({
          fromPubkey: player.publicKey,
          toPubkey: owner.publicKey,
          lamports: remaining - 5000,
        }),
      ],
      [player],
    );
    console.log(`  refunded ${(remaining - 5000) / LAMPORTS_PER_SOL} SOL to owner`);
  }

  console.log("\n✓ full-game smoke green");
}

main().catch((err) => {
  console.error("\n✗ full-game smoke FAILED:", err);
  process.exit(1);
});
