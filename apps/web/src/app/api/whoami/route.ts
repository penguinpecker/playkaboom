import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/server/api-helpers";
import { verifyPrivyAuth } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnostic endpoint. Hits the same Privy-auth path as /api/commit so we
 * can isolate auth failures from anything else in the game flow.
 *
 * Anonymous: returns only the authenticated=false flag + the auth-failure
 * reason (no env disclosure — the previous version leaked PRIVY_APP_ID,
 * cluster, and the RPC host hostname to any unauthenticated caller).
 * Authed   : returns userId + linked Solana wallets + the env-binding view
 * (which Privy app id is configured, whether the secret env var is set;
 * secrets are NEVER returned, only "set/unset"). Available only to logged-
 * in users since it identifies our auth infrastructure.
 */
export async function GET(req: NextRequest) {
  try {
    const verified = await verifyPrivyAuth(req);
    const env = {
      privyAppId:
        process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? null,
      privyAppSecretConfigured: !!process.env.PRIVY_APP_SECRET,
      cluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? null,
      rpcHost: (() => {
        try {
          return new URL(process.env.SOLANA_RPC ?? "").host;
        } catch {
          return null;
        }
      })(),
    };
    return NextResponse.json({
      authenticated: true,
      userId: verified.userId,
      wallets: verified.wallets.map((w) => w.toBase58()),
      env,
    });
  } catch (err) {
    if (err instanceof Error && /Missing auth token|Invalid auth token|Privy lookup failed|User not found/.test(err.message)) {
      return NextResponse.json(
        { authenticated: false, reason: err.message },
        { status: 200 },
      );
    }
    return jsonError(err);
  }
}
