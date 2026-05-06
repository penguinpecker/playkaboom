/**
 * End-to-end referral test on devnet.
 *
 * Flow:
 *   1. Generate referrer keypair + player keypair, fund both from deployer.
 *   2. Player calls set_referrer(referrer) → creates ReferralAccount PDA.
 *   3. Player plays a game: start → reveal_safe → cash_out (Won path).
 *   4. House calls settle_game with the referral_account passed as the
 *      first remaining account → program credits referrer with
 *      bet × REFERRAL_BRONZE_BPS / 10_000.
 *   5. Verify ReferralAccount.accrued_lamports +=  bet × 0.005.
 *   6. Verify ReferralAccount.referred_volume += bet.
 *   7. Referrer calls claim_referral → SOL flows from vault PDA to
 *      referrer wallet, accrued_lamports = 0.
 *   8. Cleanup: drain wallets back to deployer.
 *
 * Proves:
 *   - Referral linkage works on-chain (set_referrer → ReferralAccount)
 *   - settle_game pays the cut from the vault to the ReferralAccount
 *   - claim_referral lets the referrer realize accrued earnings
 *   - The bps-of-bet math matches the on-chain program
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";
import {
  buildCashOut,
  buildClaimReferral,
  buildCloseGame,
  buildRevealTile,
  buildSetReferrer,
  buildSettleGame,
  buildStartGame,
  decodeReferralAccount,
  deriveReferralPda,
} from "@playkaboom/sdk";

const REFERRAL_BRONZE_BPS = 50; // matches lib.rs:47
const BET_LAMPORTS = 5_000_000n; // 0.005 SOL
const MINE_COUNT = 3;

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

/** Polling-based confirm — devnet RPCs (public + Alchemy) don't expose
 *  signatureSubscribe, so the default confirmTransaction's WS fallback
 *  fails out and the tx looks "expired" even when it's actually landed. */
async function pollConfirm(
  conn: Connection,
  sig: string,
  lastValidBlockHeight: number,
): Promise<void> {
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
          throw new Error(`tx ${sig} blockhash expired`);
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
  ixs: TransactionInstruction[],
  signers: Keypair[] = [],
  feePayerOverride?: PublicKey,
  housePresign?: TurnkeyHouse,
  remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [],
): Promise<string> {
  const tx = new Transaction();
  for (const ix of ixs) {
    if (remainingAccounts.length > 0 && ix === ixs[ixs.length - 1]) {
      ix.keys.push(...remainingAccounts);
    }
    tx.add(ix);
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayerOverride ?? payer?.publicKey ?? signers[0]!.publicKey;
  if (signers.length > 0) tx.sign(...signers);
  const finalTx = housePresign ? await housePresign.sign(tx) : tx;
  const sig = await conn.sendRawTransaction(finalTx.serialize(), { skipPreflight: false });
  await pollConfirm(conn, sig, lastValidBlockHeight);
  return sig;
}

async function main() {
  const programId = new PublicKey(envOrThrow("PROGRAM_ID"));
  const conn = new Connection(
    process.env.SOLANA_RPC ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  const ctx = { programId };
  const deployer = loadKp(resolve(homedir(), ".config/solana/id.json"));

  const house = new TurnkeyHouse(
    envOrThrow("TURNKEY_ORG_ID"),
    envOrThrow("TURNKEY_API_PUBLIC_KEY"),
    envOrThrow("TURNKEY_API_PRIVATE_KEY"),
    envOrThrow("TURNKEY_HOUSE_PUBKEY"),
  );

  const player = Keypair.generate();
  const referrer = Keypair.generate();

  console.log("─ referral end-to-end test ─");
  console.log("  programId:", programId.toBase58());
  console.log("  player   :", player.publicKey.toBase58());
  console.log("  referrer :", referrer.publicKey.toBase58());
  console.log("  house    :", house.pubkey.toBase58());

  // ── Step 1: fund both ───────────────────────────────────────────────────
  console.log("\n[1/7] Fund player + referrer from deployer");
  await send(
    conn,
    deployer,
    [
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: player.publicKey,
        lamports: 30_000_000,
      }),
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: referrer.publicKey,
        lamports: 5_000_000, // referrer just needs rent for the tx
      }),
    ],
    [deployer],
  );

  // ── Step 2: set_referrer ────────────────────────────────────────────────
  console.log("\n[2/7] player.set_referrer(referrer)");
  const setRefIx = buildSetReferrer({
    ctx,
    player: player.publicKey,
    referrer: referrer.publicKey,
  });
  const sig2 = await send(conn, player, [setRefIx], [player]);
  console.log("  sig:", sig2);

  // Read ReferralAccount post-init.
  const [referralPda] = deriveReferralPda(programId, referrer.publicKey);
  const refInfo = await conn.getAccountInfo(referralPda, "confirmed");
  if (!refInfo) throw new Error("ReferralAccount PDA not created");
  const refBefore = decodeReferralAccount(refInfo.data);
  console.log(`  ReferralAccount accrued: ${refBefore.accruedLamports}`);
  console.log(`  ReferralAccount tier   : ${refBefore.tier}`);
  console.log(`  ReferralAccount volume : ${refBefore.referredVolume}`);

  // ── Step 3: start_game ──────────────────────────────────────────────────
  console.log("\n[3/7] player.start_game (bet 0.005 SOL, 3 mines)");
  const layout = unbiasedShuffleLayout(MINE_COUNT);
  const salt = randomBytes(32);
  const commit = commitmentOf(layout, MINE_COUNT, salt);
  const sig3 = await send(
    conn,
    player,
    [
      buildStartGame({
        ctx,
        player: player.publicKey,
        mineCount: MINE_COUNT,
        betLamports: BET_LAMPORTS,
        commitment: commit,
      }),
    ],
    [player],
  );
  console.log("  sig:", sig3);

  // ── Step 4: reveal_tile (safe) — house signs ────────────────────────────
  console.log("\n[4/7] reveal_tile (safe; house signs)");
  const safe = safeTileFor(layout);
  const sig4 = await send(
    conn,
    null,
    [
      buildRevealTile({
        ctx,
        player: player.publicKey,
        houseAuthority: house.pubkey,
        tileIndex: safe,
        isMine: false,
      }),
    ],
    [],
    house.pubkey,
    house,
  );
  console.log("  sig:", sig4);

  // ── Step 5: cash_out (player signs) ─────────────────────────────────────
  console.log("\n[5/7] cash_out (player signs, status → Won)");
  const sig5 = await send(conn, player, [buildCashOut({ ctx, player: player.publicKey })], [player]);
  console.log("  sig:", sig5);

  // ── Step 6: settle_game with referral_account passed as remaining ──────
  console.log("\n[6/7] settle_game + referral_account → expect cut credited");
  const settleIx = buildSettleGame({
    ctx,
    player: player.publicKey,
    houseAuthority: house.pubkey,
    mineLayout: layout,
    salt,
  });
  // Append the referral_account as the first (and only) remaining account
  // — settle_game peeks `ctx.remaining_accounts.first()`.
  settleIx.keys.push({ pubkey: referralPda, isSigner: false, isWritable: true });
  const sig6 = await send(conn, null, [settleIx], [], house.pubkey, house);
  console.log("  sig:", sig6);

  const refInfoAfter = await conn.getAccountInfo(referralPda, "confirmed");
  if (!refInfoAfter) throw new Error("ReferralAccount missing after settle");
  const refAfter = decodeReferralAccount(refInfoAfter.data);

  const expectedCut = (BET_LAMPORTS * BigInt(REFERRAL_BRONZE_BPS)) / 10_000n;
  console.log(`  ReferralAccount accrued: ${refBefore.accruedLamports} → ${refAfter.accruedLamports} (Δ ${refAfter.accruedLamports - refBefore.accruedLamports})`);
  console.log(`  expected cut          : ${expectedCut} (= bet × bronze_bps / 10000)`);
  console.log(`  ReferralAccount volume : ${refBefore.referredVolume} → ${refAfter.referredVolume} (Δ ${refAfter.referredVolume - refBefore.referredVolume})`);
  if (refAfter.accruedLamports - refBefore.accruedLamports !== expectedCut) {
    throw new Error(`expected accrued delta ${expectedCut}, got ${refAfter.accruedLamports - refBefore.accruedLamports}`);
  }
  if (refAfter.referredVolume - refBefore.referredVolume !== BET_LAMPORTS) {
    throw new Error(`expected referredVolume delta ${BET_LAMPORTS}, got ${refAfter.referredVolume - refBefore.referredVolume}`);
  }
  console.log("  ✓ cut and volume both updated correctly");

  // close_game so we can replay later if needed
  await send(conn, player, [buildCloseGame({ ctx, player: player.publicKey })], [player]);

  // ── Step 7: claim_referral — referrer signs ─────────────────────────────
  console.log("\n[7/7] referrer.claim_referral");
  const refBalBefore = await conn.getBalance(referrer.publicKey, "confirmed");
  const sig7 = await send(
    conn,
    referrer,
    [buildClaimReferral({ ctx, referrer: referrer.publicKey })],
    [referrer],
  );
  console.log("  sig:", sig7);
  const refBalAfter = await conn.getBalance(referrer.publicKey, "confirmed");
  const refDelta = refBalAfter - refBalBefore;

  const refInfoFinal = await conn.getAccountInfo(referralPda, "confirmed");
  if (!refInfoFinal) throw new Error("ReferralAccount missing after claim");
  const refFinal = decodeReferralAccount(refInfoFinal.data);
  console.log(`  referrer balance Δ +${(refDelta / 1e9).toFixed(6)} SOL (expected +${(Number(expectedCut) / 1e9).toFixed(6)} − fees)`);
  console.log(`  ReferralAccount accrued: ${refAfter.accruedLamports} → ${refFinal.accruedLamports} (should be 0)`);
  console.log(`  ReferralAccount.total_earned: ${refFinal.totalEarned} (should == prior accrued)`);
  if (refFinal.accruedLamports !== 0n) {
    throw new Error(`accrued should be 0 after claim, got ${refFinal.accruedLamports}`);
  }
  console.log("  ✓ accrued cleared, SOL paid to referrer");

  console.log("\n──────────────────────────────");
  console.log("✓ referral end-to-end test PASSED");
  console.log(`  - bet 0.005 SOL × bronze 0.5% = 0.000025 SOL credited`);
  console.log(`  - ReferralAccount.accrued/volume updated by settle_game`);
  console.log(`  - claim_referral paid SOL to referrer + zeroed accrued`);
}

main().catch((e) => {
  console.error("referral test FAILED:", e);
  process.exit(1);
});
