import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { extractEventsFromLogs } from "@playkaboom/sdk";
import { getConnection } from "@/server/connection";
import { jsonError } from "@/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ signature: string }>;
}

/**
 * Public provably-fair verifier. Anyone can hit this with a settle_game
 * tx signature and get back the commitment + revealed (mine_layout, salt)
 * pair, plus the SHA-256 we re-computed locally so the caller can confirm
 * the layout was committed at start_game (not picked after the fact).
 *
 * The math the verifier reproduces (matches lib.rs:462-471):
 *
 *   computed = SHA-256( mine_layout (u16 LE) || mine_count (u8) || salt (32) )
 *   verified = (computed == on-chain commitment)
 *
 * No server secrets are required — every byte we return came from a
 * Solana transaction's log events. This is intentional: a player can
 * also fetch the same tx logs themselves with `solana confirm <sig>` and
 * compute the hash locally. We provide the endpoint as a convenience.
 *
 * Authentication: none. The data is already public on-chain.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { signature } = await ctx.params;
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(signature)) {
      return NextResponse.json({ error: "Invalid signature format" }, { status: 400 });
    }
    const conn = getConnection();
    const tx = await conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }
    const logs = tx.meta?.logMessages ?? [];
    const events = extractEventsFromLogs(logs);
    const settled = events.find((e) => e.kind === "GameSettled");
    if (!settled || settled.kind !== "GameSettled") {
      return NextResponse.json(
        {
          error:
            "No GameSettled event in this transaction. Provide a settle_game signature.",
          eventsFound: events.map((e) => e.kind),
        },
        { status: 400 },
      );
    }

    // Recompute the commitment exactly as the on-chain verifier does
    // (lib.rs:463-467): mine_layout LE bytes || mine_count || salt.
    const layoutBytes = Buffer.alloc(2);
    layoutBytes.writeUInt16LE(settled.mineLayout, 0);
    const computed = createHash("sha256")
      .update(layoutBytes)
      .update(Buffer.from([settled.mineCount]))
      .update(settled.salt)
      .digest();
    const verified = computed.equals(settled.commitment);

    // The on-chain settle_game ix already enforces this — `verified` is
    // always `true` in the emitted event because the program would have
    // failed the tx otherwise (CommitmentMismatch error). We re-verify
    // here client-side anyway so a third party doesn't have to trust our
    // event decoder.
    return NextResponse.json({
      verified,
      slot: settled.slot.toString(),
      player: settled.player.toBase58(),
      game: settled.game.toBase58(),
      mineCount: settled.mineCount,
      mineLayout: settled.mineLayout,
      mineLayoutBinary: settled.mineLayout.toString(2).padStart(12, "0"),
      saltHex: settled.salt.toString("hex"),
      commitmentHex: settled.commitment.toString("hex"),
      computedHex: computed.toString("hex"),
      verifyLocally: {
        formula: "SHA-256(mine_layout_le || mine_count || salt)",
        bash:
          'echo -n "" | { ' +
          `printf '\\x%02x\\x%02x' $((${settled.mineLayout} & 0xff)) $((${settled.mineLayout} >> 8)); ` +
          `printf '\\x%02x' ${settled.mineCount}; ` +
          `echo -n "${settled.salt.toString("hex")}" | xxd -r -p; ` +
          "} | shasum -a 256",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
