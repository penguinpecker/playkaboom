import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { ixDiscriminator } from "@playkaboom/sdk";
import { ApiError, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { getConnection } from "@/server/connection";
import { programId } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { recordSetReferrerConfirmation } from "@/server/referral-tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  wallet: z.string().refine((v) => {
    try {
      new PublicKey(v);
      return true;
    } catch {
      return false;
    }
  }, "Invalid wallet"),
  // Solana signatures are 87-88 base58 chars; allow a small margin for safety.
  signature: z.string().min(86).max(90),
});

/**
 * Called by the client after a set_referrer tx confirms on-chain. Tags
 * the latest unconfirmed visit row for this wallet with the tx
 * signature + bumps confirmed_count on referral_codes. Provides the
 * "click → signup → confirmed" three-stage funnel attribution.
 *
 * Authed — only the wallet's owner can claim a confirmation, otherwise
 * anyone could call this with someone else's wallet to inflate someone's
 * confirmed_count.
 *
 * 2026-05-11 hardening: also fetch the tx from RPC and verify it actually
 * contains a `set_referrer` instruction targeting `body.wallet` as the
 * player. Without this check, any plausible-looking base58 string would
 * inflate `confirmed_count`.
 *
 * If there's no visit row for this wallet (e.g. they came in via
 * the legacy ?ref=<wallet> form), we silently no-op — the on-chain
 * set_referrer is what actually matters; this is just analytics.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, Body);
    await verifyPlayerAuth(req, body.wallet);

    // Rate-limit per-(ip, wallet) — prevents one user with many sessions
    // from spamming confirmations.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rl = await enforceRateLimit(`ref:confirm:${ip}:${body.wallet}`);
    if (!rl.ok) {
      return NextResponse.json({ error: "Rate limited" }, { status: 429 });
    }

    // CRITICAL: chain-verify the signature actually contains a set_referrer
    // ix with body.wallet as the player. Without this, an authenticated user
    // can pass any plausible base58 string and inflate confirmed_count.
    const verified = await verifySetReferrerOnChain(body.signature, body.wallet);
    if (!verified) {
      return NextResponse.json(
        { error: "Signature does not contain a set_referrer for this wallet" },
        { status: 400 },
      );
    }

    const ok = await recordSetReferrerConfirmation(body.wallet, body.signature);
    return NextResponse.json({ attributed: ok });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return jsonError(err);
  }
}

/** Fetch the tx and confirm: (a) it touches the kaboom program, (b) one of
 *  its instructions has the `set_referrer` discriminator, (c) that ix's
 *  player account (last writable signer per the SDK builder) equals the
 *  claimed wallet. Returns false on any mismatch — caller treats as auth
 *  failure. */
async function verifySetReferrerOnChain(
  signature: string,
  walletBase58: string,
): Promise<boolean> {
  const conn = getConnection();
  const tx = await conn.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return false;
  if (tx.meta?.err) return false;

  const program = programId();
  const disc = ixDiscriminator("set_referrer"); // 8-byte buffer
  const msg = tx.transaction.message;
  // Get account keys; for v0 txs include loaded addresses.
  const accountKeys = msg.getAccountKeys
    ? msg.getAccountKeys({
        accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined,
      })
    : null;
  const keysArr =
    accountKeys?.keySegments().flat() ??
    ((msg as unknown as { accountKeys?: PublicKey[] }).accountKeys ?? []);

  for (const ix of msg.compiledInstructions) {
    const programKey = keysArr[ix.programIdIndex];
    if (!programKey || !programKey.equals(program)) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 8) continue;
    if (!data.subarray(0, 8).equals(disc)) continue;
    // SetReferrer Accounts struct order from instructions.ts:131-136:
    //   [0] statsPda (writable)
    //   [1] referrer (readonly)
    //   [2] referralPda (writable)
    //   [3] player (writable, signer)
    //   [4] system_program (readonly)
    const playerKeyIdx = ix.accountKeyIndexes[3];
    if (playerKeyIdx === undefined) continue;
    const playerKey = keysArr[playerKeyIdx];
    if (playerKey && playerKey.toBase58() === walletBase58) return true;
  }
  return false;
}
