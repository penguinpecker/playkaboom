import "server-only";
import type { NextRequest } from "next/server";
import { PrivyClient, type AuthTokenClaims } from "@privy-io/server-auth";
import { PublicKey } from "@solana/web3.js";
import { ApiError } from "./api-helpers";

let cachedClient: PrivyClient | null = null;

function privy(): PrivyClient {
  if (cachedClient) return cachedClient;
  const appId =
    process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId) throw new Error("PRIVY_APP_ID not set");
  if (!appSecret) throw new Error("PRIVY_APP_SECRET not set");
  cachedClient = new PrivyClient(appId, appSecret);
  return cachedClient;
}

/**
 * Pulls the Privy access token from `Authorization: Bearer …` or the
 * `privy-token` cookie. The browser SDK sets the cookie automatically.
 */
function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  const cookieToken = req.cookies.get("privy-token")?.value;
  return cookieToken ?? null;
}

export interface VerifiedRequest {
  userId: string;
  /** All Solana wallet addresses linked to this Privy user. */
  wallets: PublicKey[];
}

/**
 * Verifies the request's Privy token, returns the user's id and linked
 * Solana wallets. Throws `ApiError(401)` if missing or invalid.
 */
export async function verifyPrivyAuth(req: NextRequest): Promise<VerifiedRequest> {
  const token = extractToken(req);
  if (!token) throw new ApiError(401, "Missing auth token");

  let claims: AuthTokenClaims;
  try {
    claims = await privy().verifyAuthToken(token);
  } catch {
    throw new ApiError(401, "Invalid auth token");
  }

  const userId = claims.userId;
  // Pull the user record so we know which wallets are theirs.
  const user = await privy().getUserById(userId).catch(() => null);
  if (!user) throw new ApiError(401, "User not found");

  const wallets: PublicKey[] = [];
  for (const acc of user.linkedAccounts ?? []) {
    if (
      (acc.type === "wallet" || acc.type === "smart_wallet") &&
      "chainType" in acc &&
      acc.chainType === "solana" &&
      "address" in acc &&
      typeof acc.address === "string"
    ) {
      try {
        wallets.push(new PublicKey(acc.address));
      } catch {
        /* skip malformed */
      }
    }
  }
  return { userId, wallets };
}

/**
 * Verifies auth AND that the claimed `player` pubkey belongs to the
 * authenticated user. Use this on every endpoint where the player identity
 * matters (commit, reveal, settle, cleanup, claim_referral).
 */
export async function verifyPlayerAuth(
  req: NextRequest,
  claimedPlayer: string,
): Promise<VerifiedRequest> {
  const verified = await verifyPrivyAuth(req);
  let claimedPk: PublicKey;
  try {
    claimedPk = new PublicKey(claimedPlayer);
  } catch {
    throw new ApiError(400, "Invalid player pubkey");
  }
  const owns = verified.wallets.some((w) => w.equals(claimedPk));
  if (!owns) {
    throw new ApiError(403, "Player wallet not linked to authenticated user");
  }
  return verified;
}
