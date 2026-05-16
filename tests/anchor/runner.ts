/**
 * Anchor program integration tests.
 *
 * Runs against the validator started by `anchor test`. Covers the critical
 * security invariants:
 *
 *   smoke: PDA derivations match between SDK and on-chain
 *   happy: init → fund → init_v2 → start → reveal(safe) → cashout → settle → close
 *   double_start: two start_game's at same PDA fail (`init` constraint)
 *   cashout_no_reveals: cash_out before any reveal fails (NoTilesRevealed)
 *   settle_wrong_layout: settle with bad layout fails (CommitmentMismatch)
 *   refund_too_early: refund_expired before GAME_EXPIRY_SLOTS fails (GameNotExpired)
 *
 * Run a single test:
 *   ANCHOR_TEST_ONLY=happy anchor test
 */
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
  type Signer,
  type Connection,
} from "@solana/web3.js";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import {
  buildInitializeVault,
  buildFundVault,
  buildInitializeV2,
  buildStartGame,
  buildRevealTile,
  buildCashOut,
  buildSettleGame,
  buildRefundExpired,
  buildCloseGame,
  deriveVaultPda,
  deriveV2StatePda,
  deriveGamePda,
  deriveGameV2Pda,
  derivePlayerStatsPda,
  computeCommitment,
  type BuildContext,
} from "@playkaboom/sdk";

// ── Config ──────────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "4rPEGzWoD2i8k3Pr5tnJsBV7AZEK2zQJCXZe4YgwcixT",
);
const CTX: BuildContext = { programId: PROGRAM_ID };
const ONLY = process.env.ANCHOR_TEST_ONLY?.trim() || null;

const [vaultPda] = deriveVaultPda(PROGRAM_ID);
const [v2Pda] = deriveV2StatePda(PROGRAM_ID);

// ── Test framework ──────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  run: () => Promise<void>;
}
const TESTS: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  TESTS.push({ name, run });
}

async function expectErrorMatching(
  fn: () => Promise<unknown>,
  pattern: string,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    const logs = JSON.stringify((err as { logs?: unknown }).logs ?? "");
    const haystack = (msg + " " + logs).toLowerCase();
    assert.ok(
      haystack.includes(pattern.toLowerCase()),
      `expected error matching "${pattern}", got: ${msg}\n  logs: ${logs}`,
    );
  }
  assert.ok(threw, `expected throw matching "${pattern}", call succeeded`);
}

// ── On-chain helpers ────────────────────────────────────────────────────────

async function airdrop(
  conn: Connection,
  to: PublicKey,
  amountSol: number,
): Promise<void> {
  const sig = await conn.requestAirdrop(to, amountSol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function freshPlayer(
  conn: Connection,
  solAmount: number,
): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(conn, kp.publicKey, solAmount);
  return kp;
}

async function sendTx(
  conn: Connection,
  ixs: TransactionInstruction[],
  feePayer: PublicKey,
  signers: Signer[],
): Promise<string> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = feePayer;
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

interface GamePlan {
  mineCount: number;
  mineLayout: number;
  salt: Buffer;
  commitment: Buffer;
}
function generateGamePlan(mineCount: number): GamePlan {
  assert.ok(mineCount >= 1 && mineCount <= 15);
  const indices = Array.from({ length: 16 }, (_, i) => i);
  for (let i = 15; i > 16 - mineCount; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [indices[i], indices[j]] = [indices[j]!, indices[i]!];
  }
  const minePositions = indices.slice(16 - mineCount);
  let mineLayout = 0;
  for (const p of minePositions) mineLayout |= 1 << p;
  const salt = randomBytes(32);
  const commitment = computeCommitment(mineLayout, mineCount, salt);
  return { mineCount, mineLayout, salt, commitment };
}

async function ensureVaultInitialized(
  conn: Connection,
  owner: Keypair,
  houseAuthority: PublicKey,
): Promise<void> {
  const info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (info && info.owner.equals(PROGRAM_ID)) return;
  await sendTx(
    conn,
    [
      buildInitializeVault({
        ctx: CTX,
        owner: owner.publicKey,
        houseAuthority,
        treasury: owner.publicKey,
        houseEdgeBps: 200,
        maxBetBps: 1000,
        maxPayoutBps: 5000,
      }),
    ],
    owner.publicKey,
    [owner],
  );
}

async function fundVaultIfNeeded(
  conn: Connection,
  owner: Keypair,
  minLamports: number,
): Promise<void> {
  const info = await conn.getAccountInfo(vaultPda, "confirmed");
  if (info && info.lamports >= minLamports) return;
  const need = minLamports - (info?.lamports ?? 0);
  await sendTx(
    conn,
    [buildFundVault({ ctx: CTX, funder: owner.publicKey, amount: BigInt(need) })],
    owner.publicKey,
    [owner],
  );
}

async function ensureV2Initialized(conn: Connection, owner: Keypair): Promise<void> {
  const info = await conn.getAccountInfo(v2Pda, "confirmed");
  if (info && info.owner.equals(PROGRAM_ID)) return;
  await sendTx(
    conn,
    [buildInitializeV2({ ctx: CTX, owner: owner.publicKey })],
    owner.publicKey,
    [owner],
  );
}

// ── Test cases ──────────────────────────────────────────────────────────────

test("smoke: PDA derivations deterministic and player-distinct", async () => {
  const a = Keypair.generate();
  const b = Keypair.generate();
  const [ga] = deriveGamePda(PROGRAM_ID, a.publicKey);
  const [gb] = deriveGamePda(PROGRAM_ID, b.publicKey);
  const [ga2] = deriveGamePda(PROGRAM_ID, a.publicKey);
  assert.notEqual(ga.toBase58(), gb.toBase58());
  assert.equal(ga.toBase58(), ga2.toBase58());
  const [sa] = derivePlayerStatsPda(PROGRAM_ID, a.publicKey);
  assert.notEqual(sa.toBase58(), ga.toBase58());
});

test("er-smoke: GameV2 PDA is distinct from legacy GamePda for the same player", async () => {
  // Magicblock ER uses a separate `game_v2` seed so the L1 and ER games can
  // coexist for a single player without colliding. If the seed bytes ever
  // drift between the SDK's GAME_V2_SEED (shared/constants.ts) and the
  // Anchor program's `GAME_V2_SEED = b"game_v2"`, every start_game_er would
  // fail an account constraint with no obvious clue. This test catches that
  // class of seed-drift bug at the wire-format level.
  //
  // Does NOT exercise the live Magicblock ER endpoint — the local validator
  // has no delegation program. End-to-end V1–V9 verification runs on devnet
  // per MAGICBLOCK_PLAN.md §4. This is the minimum local guard.
  const a = Keypair.generate();
  const [gameV1] = deriveGamePda(PROGRAM_ID, a.publicKey);
  const [gameV2] = deriveGameV2Pda(PROGRAM_ID, a.publicKey);
  const [gameV2dup] = deriveGameV2Pda(PROGRAM_ID, a.publicKey);
  assert.notEqual(
    gameV1.toBase58(),
    gameV2.toBase58(),
    "GameV2 PDA must NOT collide with legacy GamePda for the same player",
  );
  assert.equal(
    gameV2.toBase58(),
    gameV2dup.toBase58(),
    "GameV2 PDA must be deterministic",
  );
  // Spot-check the seed bytes haven't been silently re-encoded (e.g. utf-8
  // vs latin-1). The Anchor program literal is `b"game_v2"` = [103, 97, 109,
  // 101, 95, 118, 50] = 7 bytes.
  const expectedSeedBytes = Buffer.from([103, 97, 109, 101, 95, 118, 50]);
  const [manual] = PublicKey.findProgramAddressSync(
    [expectedSeedBytes, a.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  assert.equal(
    gameV2.toBase58(),
    manual.toBase58(),
    "SDK GAME_V2_SEED bytes drifted from the Anchor program literal b\"game_v2\"",
  );
});

test("happy: full win flow init → start → reveal → cashout → settle → close", async () => {
  const provider = anchor.AnchorProvider.env();
  const conn = provider.connection;
  const ownerKp = (provider.wallet as anchor.Wallet).payer;
  await ensureVaultInitialized(conn, ownerKp, ownerKp.publicKey);
  await fundVaultIfNeeded(conn, ownerKp, 10 * LAMPORTS_PER_SOL);
  await ensureV2Initialized(conn, ownerKp);

  const player = await freshPlayer(conn, 0.5);
  const plan = generateGamePlan(3);
  const bet = 0.01 * LAMPORTS_PER_SOL;

  await sendTx(
    conn,
    [
      buildStartGame({
        ctx: CTX,
        player: player.publicKey,
        mineCount: plan.mineCount,
        betLamports: BigInt(bet),
        commitment: plan.commitment,
      }),
    ],
    player.publicKey,
    [player],
  );

  let safeTile = -1;
  for (let i = 0; i < 16; i++) {
    if ((plan.mineLayout & (1 << i)) === 0) {
      safeTile = i;
      break;
    }
  }
  assert.ok(safeTile >= 0);
  await sendTx(
    conn,
    [
      buildRevealTile({
        ctx: CTX,
        player: player.publicKey,
        houseAuthority: ownerKp.publicKey,
        tileIndex: safeTile,
        isMine: false,
      }),
    ],
    ownerKp.publicKey,
    [ownerKp],
  );

  const playerBalBefore = await conn.getBalance(player.publicKey, "confirmed");
  await sendTx(
    conn,
    [buildCashOut({ ctx: CTX, player: player.publicKey })],
    player.publicKey,
    [player],
  );
  const playerBalAfter = await conn.getBalance(player.publicKey, "confirmed");
  assert.ok(
    playerBalAfter > playerBalBefore,
    `cashout should net positive: ${playerBalBefore} -> ${playerBalAfter}`,
  );

  await sendTx(
    conn,
    [
      buildSettleGame({
        ctx: CTX,
        player: player.publicKey,
        houseAuthority: ownerKp.publicKey,
        mineLayout: plan.mineLayout,
        salt: plan.salt,
      }),
    ],
    ownerKp.publicKey,
    [ownerKp],
  );

  await sendTx(
    conn,
    [buildCloseGame({ ctx: CTX, player: player.publicKey })],
    player.publicKey,
    [player],
  );

  const [gamePda] = deriveGamePda(PROGRAM_ID, player.publicKey);
  const after = await conn.getAccountInfo(gamePda, "confirmed");
  assert.equal(after, null, "game PDA must be closed");
});

test("double_start: second start_game at same PDA fails (init constraint)", async () => {
  const provider = anchor.AnchorProvider.env();
  const conn = provider.connection;
  const ownerKp = (provider.wallet as anchor.Wallet).payer;
  await ensureVaultInitialized(conn, ownerKp, ownerKp.publicKey);
  await fundVaultIfNeeded(conn, ownerKp, 10 * LAMPORTS_PER_SOL);
  await ensureV2Initialized(conn, ownerKp);

  const player = await freshPlayer(conn, 0.5);
  const plan1 = generateGamePlan(3);
  const bet = 0.01 * LAMPORTS_PER_SOL;
  await sendTx(
    conn,
    [
      buildStartGame({
        ctx: CTX,
        player: player.publicKey,
        mineCount: plan1.mineCount,
        betLamports: BigInt(bet),
        commitment: plan1.commitment,
      }),
    ],
    player.publicKey,
    [player],
  );

  const plan2 = generateGamePlan(5);
  await expectErrorMatching(
    () =>
      sendTx(
        conn,
        [
          buildStartGame({
            ctx: CTX,
            player: player.publicKey,
            mineCount: plan2.mineCount,
            betLamports: BigInt(bet),
            commitment: plan2.commitment,
          }),
        ],
        player.publicKey,
        [player],
      ),
    "already in use",
  );
});

test("cashout_no_reveals: cash_out before any reveal fails NoTilesRevealed", async () => {
  const provider = anchor.AnchorProvider.env();
  const conn = provider.connection;
  const ownerKp = (provider.wallet as anchor.Wallet).payer;
  await ensureVaultInitialized(conn, ownerKp, ownerKp.publicKey);
  await fundVaultIfNeeded(conn, ownerKp, 10 * LAMPORTS_PER_SOL);
  await ensureV2Initialized(conn, ownerKp);

  const player = await freshPlayer(conn, 0.5);
  const plan = generateGamePlan(3);
  await sendTx(
    conn,
    [
      buildStartGame({
        ctx: CTX,
        player: player.publicKey,
        mineCount: plan.mineCount,
        betLamports: BigInt(0.01 * LAMPORTS_PER_SOL),
        commitment: plan.commitment,
      }),
    ],
    player.publicKey,
    [player],
  );
  await expectErrorMatching(
    () =>
      sendTx(
        conn,
        [buildCashOut({ ctx: CTX, player: player.publicKey })],
        player.publicKey,
        [player],
      ),
    "NoTilesRevealed",
  );
});

test("settle_wrong_layout: settle with bad layout fails CommitmentMismatch", async () => {
  const provider = anchor.AnchorProvider.env();
  const conn = provider.connection;
  const ownerKp = (provider.wallet as anchor.Wallet).payer;
  await ensureVaultInitialized(conn, ownerKp, ownerKp.publicKey);
  await fundVaultIfNeeded(conn, ownerKp, 10 * LAMPORTS_PER_SOL);
  await ensureV2Initialized(conn, ownerKp);

  const player = await freshPlayer(conn, 0.5);
  const plan = generateGamePlan(3);
  await sendTx(
    conn,
    [
      buildStartGame({
        ctx: CTX,
        player: player.publicKey,
        mineCount: plan.mineCount,
        betLamports: BigInt(0.01 * LAMPORTS_PER_SOL),
        commitment: plan.commitment,
      }),
    ],
    player.publicKey,
    [player],
  );
  let safeTile = -1;
  for (let i = 0; i < 16; i++) {
    if ((plan.mineLayout & (1 << i)) === 0) {
      safeTile = i;
      break;
    }
  }
  await sendTx(
    conn,
    [
      buildRevealTile({
        ctx: CTX,
        player: player.publicKey,
        houseAuthority: ownerKp.publicKey,
        tileIndex: safeTile,
        isMine: false,
      }),
    ],
    ownerKp.publicKey,
    [ownerKp],
  );
  await sendTx(
    conn,
    [buildCashOut({ ctx: CTX, player: player.publicKey })],
    player.publicKey,
    [player],
  );
  const wrongLayout = plan.mineLayout ^ 0x0001;
  await expectErrorMatching(
    () =>
      sendTx(
        conn,
        [
          buildSettleGame({
            ctx: CTX,
            player: player.publicKey,
            houseAuthority: ownerKp.publicKey,
            mineLayout: wrongLayout,
            salt: plan.salt,
          }),
        ],
        ownerKp.publicKey,
        [ownerKp],
      ),
    "CommitmentMismatch",
  );
});

test("refund_too_early: refund_expired before deadline fails GameNotExpired", async () => {
  const provider = anchor.AnchorProvider.env();
  const conn = provider.connection;
  const ownerKp = (provider.wallet as anchor.Wallet).payer;
  await ensureVaultInitialized(conn, ownerKp, ownerKp.publicKey);
  await fundVaultIfNeeded(conn, ownerKp, 10 * LAMPORTS_PER_SOL);
  await ensureV2Initialized(conn, ownerKp);

  const player = await freshPlayer(conn, 0.5);
  const plan = generateGamePlan(3);
  await sendTx(
    conn,
    [
      buildStartGame({
        ctx: CTX,
        player: player.publicKey,
        mineCount: plan.mineCount,
        betLamports: BigInt(0.01 * LAMPORTS_PER_SOL),
        commitment: plan.commitment,
      }),
    ],
    player.publicKey,
    [player],
  );
  await expectErrorMatching(
    () =>
      sendTx(
        conn,
        [buildRefundExpired({ ctx: CTX, player: player.publicKey })],
        player.publicKey,
        [player],
      ),
    "GameNotExpired",
  );
});

// ── Runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  console.log("──────────────────────────────────────────────────");
  console.log("Provider :", provider.wallet.publicKey.toBase58());
  console.log("Program  :", PROGRAM_ID.toBase58());
  console.log("Vault    :", vaultPda.toBase58());
  console.log("V2 State :", v2Pda.toBase58());
  if (ONLY) console.log("Filter   :", ONLY);
  console.log("──────────────────────────────────────────────────");

  const cases = ONLY ? TESTS.filter((t) => t.name.includes(ONLY)) : TESTS;
  if (cases.length === 0) {
    console.error(`No tests matched filter "${ONLY}"`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  for (const t of cases) {
    process.stdout.write(`  ${t.name} ... `);
    try {
      await t.run();
      console.log("✓");
      passed++;
    } catch (err) {
      console.log("✗");
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ${msg}`);
      const logs = (err as { logs?: string[] }).logs;
      if (logs && Array.isArray(logs)) {
        for (const line of logs.slice(0, 10)) console.error(`    ${line}`);
      }
      failed++;
    }
  }
  console.log("──────────────────────────────────────────────────");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
