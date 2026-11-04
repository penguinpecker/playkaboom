import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeVault, deriveVaultPda, ixDiscriminator } from "@playkaboom/sdk";
import { calcMultiplierBps } from "@playkaboom/shared";
import { getConnection } from "./connection";
import { programId } from "./env";

type VrfSettleTx = {
  slot: number;
  meta?: { err: unknown; preBalances: number[]; postBalances: number[] } | null;
  transaction: {
    message: {
      getAccountKeys: () => { staticAccountKeys: PublicKey[] };
      compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[];
    };
  };
};

const SETTLE_VRF_DISC = ixDiscriminator("settle_vrf");

/**
 * The accounts of the tx's settle_vrf, or null if this is not a successful
 * transaction made of exactly one top-level Kaboom settle_vrf plus compute-
 * budget ixs. Log text is not evidence (any program, even a Memo, can print
 * "Instruction: SettleVrf"), and balance deltas are tx-wide, so any other
 * top-level ix could tune the vault/treasury deltas the solver reads.
 * Account order: buildSettleVrf in packages/sdk/src/vrf.ts.
 */
export function settleVrfAccounts(
  tx: VrfSettleTx,
  pid: PublicKey,
): { player: PublicKey; claim: PublicKey; game: PublicKey; treasury: PublicKey } | null {
  if (!tx.meta || tx.meta.err != null) return null;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys().staticAccountKeys;
  let found: ReturnType<typeof settleVrfAccounts> = null;
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    if (prog?.equals(ComputeBudgetProgram.programId)) continue;
    if (found || !prog?.equals(pid)) return null;
    if (!Buffer.from(ix.data).subarray(0, 8).equals(SETTLE_VRF_DISC)) return null;
    const a = ix.accountKeyIndexes.map((i) => keys[i]);
    if (a.length < 9 || a.some((k) => !k)) return null;
    found = { player: a[1]!, claim: a[2]!, game: a[3]!, treasury: a[6]! };
  }
  return found;
}

/**
 * Verify a VRF settle from the transaction's lamport movements alone.
 *
 * VRF has no pre-committed layout to hash — randomness is drawn per click by
 * MagicBlock's ephemeral VRF oracle inside the rollup, so the commit-reveal
 * proof above simply does not apply. What IS provable here, with no database
 * and no trust in us, is that the money matched the rules:
 *
 *   bet       = treasury_cut x 1e8 / (house_edge_bps x treasury_split_bps)
 *   payout    = -vault_delta - treasury_cut - referral_cut
 *   multiplier must equal calc_multiplier(safe_reveals, mine_count, edge)
 *               for some LEGAL (mines, reveals) pair
 *
 * We solve for the unique (mines, reveals, referral tier) that reproduces the
 * observed vault delta exactly. If no combination fits, the payout did not
 * follow the published table and `verified` is false — which is the finding
 * that matters. Every input comes from the transaction the caller named.
 */
export async function verifyVrfSettle(tx: VrfSettleTx): Promise<Record<string, unknown> | null> {
  const meta = tx.meta;
  if (!meta) return null;
  const pid = programId();
  const ixAccounts = settleVrfAccounts(tx, pid);
  if (!ixAccounts) return null;
  const conn = getConnection();
  const [vaultPda] = deriveVaultPda(pid);

  const vi = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!vi) return null;
  const vault = decodeVault(vi.data as Buffer);
  // From the ix, not balances: the program checked these when the tx landed.
  const accountsOut = {
    player: ixAccounts.player.toBase58(),
    game: ixAccounts.game.toBase58(),
    claim: ixAccounts.claim.toBase58(),
  };
  const edgeBps = vault.houseEdgeBps;
  const splitBps = vault.treasurySplitBps;

  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const delta = (pk: PublicKey) => {
    const i = keys.findIndex((k) => k.equals(pk));
    return i >= 0 ? meta.postBalances[i]! - meta.preBalances[i]! : 0;
  };
  const vaultDelta = delta(vaultPda);
  const treasuryCut = delta(ixAccounts.treasury);
  if (treasuryCut <= 0 || vaultDelta >= 0) return null;

  // treasury_cut = bet x edge_bps/1e4 x split_bps/1e4
  const bet = Math.round((treasuryCut * 10_000 * 10_000) / (edgeBps * splitBps));
  const paidOut = -vaultDelta;

  // Solve for the (mines, reveals, tier) that reproduces the vault delta.
  const TIERS = [0, 50, 60, 70]; // none / bronze / silver / gold, in bps of bet

  // A LOSS PAYS NOTHING — and that is still a verifiable outcome.
  //
  // The solver below starts at reveals >= 1, so it can only ever describe a
  // WIN. On a loss the vault pays out just the treasury cut and the referral
  // rakeback, no payout at all, so no (mines, reveals) pair could satisfy it
  // and every losing game reported "cannot verify" — on a page whose entire
  // purpose is proving the house played fair. Losses are exactly the outcome a
  // player most wants to check.
  for (const refBps of TIERS) {
    if (treasuryCut + Math.floor((bet * refBps) / 10_000) === paidOut) {
      return {
        mode: "vrf",
        verified: true,
        outcome: "lost",
        ...accountsOut,
        slot: String(tx.slot),
        betLamports: String(bet),
        payoutLamports: "0",
        vaultPaidLamports: String(paidOut),
        treasuryCutLamports: String(treasuryCut),
        referralCutLamports: String(Math.floor((bet * refBps) / 10_000)),
        howThisIsVerified: [
          `bet = treasury_cut x 1e8 / (house_edge_bps ${edgeBps} x treasury_split_bps ${splitBps})`,
          "a LOST round pays the player nothing, so the vault's only outflow is the treasury cut plus referral rakeback — and that is exactly what this transaction moved",
          "the mine was drawn per click by MagicBlock's ephemeral VRF oracle in the rollup; there is no pre-committed layout to hash",
        ],
        note:
          "Every figure above was derived from this transaction's own balance changes. Re-derive them yourself with: solana confirm -v <signature>",
      };
    }
  }
  let solution: { mines: number; reveals: number; multBps: number; payout: number; refBps: number } | null =
    null;
  outer: for (let mines = 1; mines <= 15 && !solution; mines++) {
    for (let reveals = 1; reveals <= 16 - mines; reveals++) {
      const multBps = Number(calcMultiplierBps(reveals, mines, edgeBps));
      const payout = Math.floor((bet * multBps) / 10_000);
      for (const refBps of TIERS) {
        if (payout + treasuryCut + Math.floor((bet * refBps) / 10_000) === paidOut) {
          solution = { mines, reveals, multBps, payout, refBps };
          break outer;
        }
      }
    }
  }

  return {
    mode: "vrf",
    verified: solution !== null,
    outcome: solution ? "won" : "unknown",
    ...accountsOut,
    slot: String(tx.slot),
    betLamports: String(bet),
    vaultPaidLamports: String(paidOut),
    treasuryCutLamports: String(treasuryCut),
    ...(solution
      ? {
          mineCount: solution.mines,
          safeReveals: solution.reveals,
          multiplierBps: solution.multBps,
          payoutLamports: String(solution.payout),
          referralCutLamports: String(Math.floor((bet * solution.refBps) / 10_000)),
        }
      : {}),
    howThisIsVerified: [
      `bet = treasury_cut x 1e8 / (house_edge_bps ${edgeBps} x treasury_split_bps ${splitBps})`,
      "payout + treasury_cut + referral_cut must equal the vault's lamport decrease",
      "multiplier must equal C(16,r)/C(16-m,r) x (1 - edge), the same table commit-reveal uses",
      "randomness itself is drawn per click by MagicBlock's ephemeral VRF oracle in the rollup — there is no pre-committed layout to hash, so fairness here is proven over the PAYOUT, not a salt",
    ],
    note:
      "Every figure above was derived from this transaction's own balance changes. Re-derive them yourself with: solana confirm -v <signature>",
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
