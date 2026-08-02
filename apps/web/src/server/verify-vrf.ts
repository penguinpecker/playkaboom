import { PublicKey } from "@solana/web3.js";
import { decodeVault, deriveVaultPda } from "@playkaboom/sdk";
import { calcMultiplierBps } from "@playkaboom/shared";
import { getConnection } from "./connection";
import { programId } from "./env";

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
export async function verifyVrfSettle(tx: {
  slot: number;
  meta?: { preBalances: number[]; postBalances: number[] } | null;
  transaction: { message: { getAccountKeys: () => { staticAccountKeys: PublicKey[] } } };
}): Promise<Record<string, unknown> | null> {
  const meta = tx.meta;
  if (!meta) return null;
  const conn = getConnection();
  const pid = programId();
  const [vaultPda] = deriveVaultPda(pid);

  const vi = await conn.getAccountInfo(vaultPda, "confirmed");
  if (!vi) return null;
  const vault = decodeVault(vi.data as Buffer);
  const edgeBps = vault.houseEdgeBps;
  const splitBps = vault.treasurySplitBps;

  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const delta = (pk: PublicKey) => {
    const i = keys.findIndex((k) => k.equals(pk));
    return i >= 0 ? meta.postBalances[i]! - meta.preBalances[i]! : 0;
  };
  const vaultDelta = delta(vaultPda);
  const treasuryCut = delta(vault.treasury);
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
