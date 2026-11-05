import { ComputeBudgetProgram, PublicKey, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import {
  accountDiscriminator,
  decodeVault,
  decodeVrfGame,
  DELEGATION_PROGRAM,
  deriveVaultPda,
  ixDiscriminator,
  type VrfGameAccount,
} from "@playkaboom/sdk";
import { calcMultiplierBps } from "@playkaboom/shared";
import { getConnection } from "./connection";
import { programId } from "./env";

type VrfSettleTx = {
  slot: number;
  meta?: { err: unknown; preBalances: number[]; postBalances: number[] } | null;
  transaction: {
    signatures: string[];
    message: {
      getAccountKeys: () => { staticAccountKeys: PublicKey[] };
      compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[];
    };
  };
};

const SETTLE_VRF_DISC = ixDiscriminator("settle_vrf");
const REFUND_STALLED_VRF_DISC = ixDiscriminator("refund_stalled_vrf");
const START_GAME_VRF_DISC = ixDiscriminator("start_game_vrf");

/**
 * The accounts of the tx's settle_vrf (or refund_stalled_vrf: `refund` true),
 * or null if this is not a successful transaction made of exactly one top-level
 * Kaboom settle_vrf / refund_stalled_vrf plus compute-budget ixs. Log text is
 * not evidence (any program, even a Memo, can print "Instruction: SettleVrf"),
 * and balance deltas are tx-wide, so any other top-level ix could tune the
 * vault/treasury deltas the verifier reads.
 * Account order: buildSettleVrf / buildRefundStalledVrf in packages/sdk/src/vrf.ts.
 */
export function settleVrfAccounts(
  tx: VrfSettleTx,
  pid: PublicKey,
): {
  refund: boolean;
  player: PublicKey;
  claim: PublicKey;
  game: PublicKey;
  treasury: PublicKey | null;
  referral: PublicKey | null;
} | null {
  if (!tx.meta || tx.meta.err != null) return null;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys().staticAccountKeys;
  let found: ReturnType<typeof settleVrfAccounts> = null;
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    if (prog?.equals(ComputeBudgetProgram.programId)) continue;
    if (found || !prog?.equals(pid)) return null;
    const disc = Buffer.from(ix.data).subarray(0, 8);
    const a = ix.accountKeyIndexes.map((i) => keys[i]);
    if (a.some((k) => !k)) return null;
    if (disc.equals(SETTLE_VRF_DISC) && a.length >= 9) {
      found = { refund: false, player: a[1]!, claim: a[2]!, game: a[3]!, treasury: a[6]!, referral: a[9] ?? null };
    } else if (disc.equals(REFUND_STALLED_VRF_DISC) && a.length >= 6) {
      found = { refund: true, player: a[1]!, claim: a[2]!, game: a[3]!, treasury: null, referral: null };
    } else {
      return null;
    }
  }
  return found;
}

// ─── the round, read back from chain ────────────────────────────────────────

/** jsonParsed getTransaction, only the fields read here. */
type RawTx = {
  meta: { err: unknown } | null;
  transaction: { message: { instructions: { programId: string; accounts?: string[]; data?: string }[] } };
};

/**
 * MagicBlock's commit txs are v1 transactions, which web3.js 1.x refuses
 * ("version 1 not supported") — so ask for jsonParsed through the same client,
 * keeping its 429 retry.
 */
async function rawTx(conn: Connection, sig: string): Promise<RawTx | null> {
  const rpc = conn as unknown as {
    _rpcRequest(method: string, args: unknown[]): Promise<{ result?: RawTx | null; error?: { message: string } }>;
  };
  const res = await rpc._rpcRequest("getTransaction", [
    sig,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 },
  ]);
  if (res.error) throw new Error(`getTransaction ${sig}: ${res.error.message}`);
  return res.result ?? null;
}

// VrfGame layout: pinocchio/kaboom-p/src/state.rs `vrf_game`.
const VRF_GAME_SPACE = 621;
const VG_MINE_COUNT = 74;
const VG_MULTIPLIER_BPS = 85;

/** Apply one MagicBlock diff (DLP `DiffSet`: changed_len u32, n u32, n x (offset_in_diff, offset_in_data) u32 pairs, bytes). */
function applyDiff(diff: Buffer, s: Buffer): boolean {
  if (diff.readUInt32LE(0) !== s.length) return false;
  const n = diff.readUInt32LE(4);
  const body = diff.subarray(8 + 8 * n);
  for (let i = 0; i < n; i++) {
    const from = diff.readUInt32LE(8 + 8 * i);
    const at = diff.readUInt32LE(12 + 8 * i);
    const to = i + 1 < n ? diff.readUInt32LE(16 + 8 * i) : body.length;
    if (to <= from || to > body.length || at + (to - from) > s.length) return false;
    body.copy(s, at, from, to);
  }
  return true;
}

/**
 * The game state the rollup committed to L1, rebuilt by applying the round's
 * DLP commit ixs (oldest first) to the state start_game_vrf wrote — a diff is
 * relative to that L1 copy. Null if any commit kept its data in a buffer
 * account (the *FromBuffer variants), i.e. it is not in the tx.
 * DLP discriminators: magicblock-delegation-program-api `DlpDiscriminator`.
 */
function replayCommits(commits: Buffer[], mineCount: number): VrfGameAccount | null {
  const s = Buffer.alloc(VRF_GAME_SPACE);
  accountDiscriminator("VrfGame").copy(s, 0);
  s[VG_MINE_COUNT] = mineCount;
  s.writeBigUInt64LE(10_000n, VG_MULTIPLIER_BPS); // status Playing (0), counts/masks 0
  try {
    for (const d of commits) {
      const disc = d.readBigUInt64LE(0);
      if (disc === 1n) {
        // CommitState: nonce u64, lamports u64, allow_undelegation bool, data Vec<u8>
        const n = d.readUInt32LE(25);
        if (n !== s.length) return null;
        d.copy(s, 0, 29, 29 + n);
      } else if (disc === 16n) {
        // CommitDiff: diff Vec<u8>, nonce, lamports, allow_undelegation
        if (!applyDiff(d.subarray(12, 12 + d.readUInt32LE(8)), s)) return null;
      } else if (disc === 21n) {
        // CommitFinalize: 24-byte args (data_is_diff at +17), then the state or diff
        const body = d.subarray(32);
        if (d[25]) {
          if (!applyDiff(body, s)) return null;
        } else {
          if (body.length !== s.length) return null;
          body.copy(s);
        }
      } else if (disc === 13n || disc === 17n || disc === 22n) {
        return null;
      }
    }
    return decodeVrfGame(s);
  } catch {
    return null;
  }
}

// ponytail: a fixed window. A round is start + commit/undelegate (+ settle), so
// 10 is plenty; spam txs naming the game PDA could push the start out of it, and
// the verifier then says "cannot verify". Page further back if that ever happens.
const ROUND_HISTORY = 10;

/**
 * The round a settle/refund closed: its bet and mine count from the round's
 * start_game_vrf args (exactly what the claim recorded and settle paid on), and
 * the game state MagicBlock committed back to Solana. Walks the game PDA's
 * history back from the closing tx to the most recent start — a claim cannot
 * be re-opened until settle or refund closes it, so that start is this round's.
 */
async function vrfRound(
  conn: Connection,
  pid: PublicKey,
  closeSig: string,
  game: PublicKey,
  claim: PublicKey,
): Promise<{ bet: bigint; mineCount: number; startSig: string; state: VrfGameAccount | null } | null> {
  const sigs = await conn.getSignaturesForAddress(game, { before: closeSig, limit: ROUND_HISTORY }, "confirmed");
  const commits: Buffer[] = []; // newest first
  // A tx that could not be read may be a commit: the replay is then unknown
  // (null), but the start's bet and mine count still stand.
  let gap = false;
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rawTx(conn, s.signature).catch(() => null);
    if (!tx) {
      gap = true;
      continue;
    }
    if (tx.meta?.err != null) continue;
    const ixs = tx.transaction.message.instructions;
    for (let i = ixs.length - 1; i >= 0; i--) {
      const ix = ixs[i]!;
      if (!ix.data || !ix.accounts) continue;
      const data = Buffer.from(bs58.decode(ix.data));
      if (ix.programId === DELEGATION_PROGRAM.toBase58() && ix.accounts[1] === game.toBase58()) {
        commits.push(data);
      } else if (
        ix.programId === pid.toBase58() &&
        data.length >= 17 &&
        data.subarray(0, 8).equals(START_GAME_VRF_DISC) &&
        ix.accounts[3] === claim.toBase58() &&
        ix.accounts[4] === game.toBase58()
      ) {
        // start_game_vrf args: mine_count u8, bet u64, session_key
        const mineCount = data[8]!;
        return {
          bet: data.readBigUInt64LE(9),
          mineCount,
          startSig: s.signature,
          state: gap ? null : replayCommits(commits.reverse(), mineCount),
        };
      }
    }
  }
  return null;
}

/**
 * Verify a VRF settle (or refund) from chain data alone.
 *
 * VRF has no pre-committed layout to hash — randomness is drawn per click by
 * MagicBlock's ephemeral VRF oracle inside the rollup, so the commit-reveal
 * proof simply does not apply. What IS provable here, with no database and no
 * trust in us, is that the money matched the rules:
 *
 *   bet, mines = this round's start_game_vrf args (what the claim recorded)
 *   reveals    = the game state MagicBlock committed to Solana
 *   payout     = -vault_delta - treasury_delta - referral_delta
 *   payout     = bet x calc_multiplier(reveals, mines, edge) / 1e4 on a win,
 *                0 on a loss, the bet itself on a refund
 *
 * The bet is never back-solved from the treasury cut: that cut uses settle-time
 * fees and is capped when the vault is short. If the start is not found the
 * result is `verified: false`.
 */
export async function verifyVrfSettle(
  tx: VrfSettleTx,
  connection?: Connection,
): Promise<Record<string, unknown> | null> {
  const meta = tx.meta;
  if (!meta) return null;
  const pid = programId();
  const ixAccounts = settleVrfAccounts(tx, pid);
  if (!ixAccounts) return null;
  const conn = connection ?? getConnection();
  const [vaultPda] = deriveVaultPda(pid);

  const [vi, round] = await Promise.all([
    conn.getAccountInfo(vaultPda, "confirmed"),
    vrfRound(conn, pid, tx.transaction.signatures[0]!, ixAccounts.game, ixAccounts.claim),
  ]);
  if (!vi) return null;
  const vault = decodeVault(vi.data as Buffer);
  const edgeBps = vault.houseEdgeBps;

  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const delta = (pk: PublicKey | null) => {
    const i = pk ? keys.findIndex((k) => k.equals(pk)) : -1;
    return i >= 0 ? meta.postBalances[i]! - meta.preBalances[i]! : 0;
  };
  const paidOut = -delta(vaultPda);
  const treasuryCut = delta(ixAccounts.treasury);
  const referralCut = delta(ixAccounts.referral);
  const payout = paidOut - treasuryCut - referralCut;

  const out: Record<string, unknown> = {
    mode: "vrf",
    // From the ix, not balances: the program checked these when the tx landed.
    player: ixAccounts.player.toBase58(),
    game: ixAccounts.game.toBase58(),
    claim: ixAccounts.claim.toBase58(),
    slot: String(tx.slot),
    vaultPaidLamports: String(paidOut),
    treasuryCutLamports: String(treasuryCut),
    referralCutLamports: String(referralCut),
    note:
      "Every figure above was derived from this transaction, the round's start transaction and MagicBlock's commit to Solana. Re-derive them yourself with: solana confirm -v <signature>",
  };
  if (!round) {
    return {
      ...out,
      verified: false,
      outcome: "unknown",
      howThisIsVerified: [
        "this round's start_game_vrf was not found in the game account's recent history, so the bet cannot be read and nothing is claimed",
      ],
    };
  }

  const bet = round.bet;
  const g = round.state;
  const sourceLine = `bet ${bet} and mine count ${round.mineCount} = the start_game_vrf arguments of this round's start transaction ${round.startSig}${g ? "; safe reveals = the game state MagicBlock committed to Solana" : ""}`;
  // The /verify page prints won/lost lines verbatim. Its first line stays the
  // published copy until the owner approves `sourceLine` in its place (no copy
  // changes in the 11-05 data pass); the bet itself is read from the start tx.
  const pageLine = `bet = treasury_cut x 1e8 / (house_edge_bps ${edgeBps} x treasury_split_bps ${vault.treasurySplitBps})`;
  Object.assign(out, { betLamports: String(bet), mineCount: round.mineCount, startSignature: round.startSig });

  // A refund pays back exactly the bet and nothing else.
  if (ixAccounts.refund) {
    return {
      ...out,
      verified: BigInt(paidOut) === bet,
      outcome: "expired",
      payoutLamports: String(paidOut),
      multiplierBps: 10_000,
      safeReveals: g?.safeReveals ?? null,
      howThisIsVerified: [
        sourceLine,
        "a refunded round pays back exactly the bet: the vault's lamport decrease must equal it, with no treasury or referral cut",
      ],
    };
  }

  const won = payout > 0;
  const mult = (r: number) => {
    try {
      return calcMultiplierBps(r, round.mineCount, edgeBps);
    } catch {
      return -1n;
    }
  };
  // A LOSS PAYS NOTHING — and that is still a verifiable outcome: losses are
  // exactly what a player most wants to check.
  let reveals: number | null = g ? g.safeReveals : null;
  if (won && reveals === null) {
    for (let r = 1; r <= 16 - round.mineCount && reveals === null; r++) {
      if ((bet * mult(r)) / 10_000n === BigInt(payout)) reveals = r;
    }
  }
  const multBps = won && reveals !== null ? mult(reveals) : 0n;
  const stateOk = !g || (g.status === (won ? "Won" : "Lost") && (!won || g.multiplierBps === multBps));
  const verified = stateOk && (won ? reveals !== null && multBps > 0n && (bet * multBps) / 10_000n === BigInt(payout) : payout === 0);

  return {
    ...out,
    verified,
    outcome: !verified ? "unknown" : won ? "won" : "lost",
    payoutLamports: String(payout),
    multiplierBps: Number(multBps),
    safeReveals: reveals,
    howThisIsVerified: won
      ? [
          pageLine,
          "payout + treasury_cut + referral_cut must equal the vault's lamport decrease",
          "multiplier must equal C(16,r)/C(16-m,r) x (1 - edge), the same table commit-reveal uses",
          "randomness itself is drawn per click by MagicBlock's ephemeral VRF oracle in the rollup — there is no pre-committed layout to hash, so fairness here is proven over the PAYOUT, not a salt",
        ]
      : [
          pageLine,
          "a LOST round pays the player nothing, so the vault's only outflow is the treasury cut plus referral rakeback — and that is exactly what this transaction moved",
          "the mine was drawn per click by MagicBlock's ephemeral VRF oracle in the rollup; there is no pre-committed layout to hash",
        ],
  };
}

/**
 * True for a base58 string that decodes to the 64 bytes of a Solana tx
 * signature. Both verify routes check this before calling the RPC, which
 * otherwise answers a malformed sig with a raw error ("Invalid param:
 * WrongSize") that the route returned as a 500.
 */
export function isTxSignature(s: string): boolean {
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}
