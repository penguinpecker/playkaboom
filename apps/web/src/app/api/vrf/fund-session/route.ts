import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DISABLED — operator-sponsored session funding.
 *
 * This route used to send 0.03 SOL from the house wallet to a caller-named
 * session key after checking only that a Playing VrfGame existed with that key.
 * That check is satisfiable indefinitely and the route kept no record of having
 * paid, so it was a replayable faucet: a player could name their own wallet as
 * the session key (start_game_vrf takes it as an unconstrained argument), loop
 * the request, and drain the house signer — roughly 32 calls at its balance.
 * The blast radius was not limited to VRF either, since the same signer serves
 * the live commit-reveal game's reveal and settle routes.
 *
 * It was also deeply loss-making on its own terms: 0.03 SOL sponsored per game
 * against a 2% house edge means even a large bet lost money every round.
 *
 * REPLACEMENT: the player funds their own session key inside the start
 * transaction (SESSION_FUND_LAMPORTS in lib/vrf/client.ts). That is atomic with
 * `start_game_vrf`, which uses `init` — so funding can happen exactly once per
 * game and a replay simply fails. No house money is involved.
 *
 * Re-enabling sponsorship would need per-game idempotency in durable storage
 * (unique on game PDA + start slot, written BEFORE the transfer), a real
 * per-player budget, and an amount below the expected house edge per game.
 * Kept as a 410 rather than deleted so the decision is visible, not silent.
 */
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      error:
        "Operator session sponsorship is disabled; the session key is funded by the player in the start transaction.",
    },
    { status: 410 },
  );
}
