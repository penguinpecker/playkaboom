import "server-only";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { PrivyClient, type AuthTokenClaims } from "@privy-io/server-auth";
import { PublicKey } from "@solana/web3.js";
import { ApiError } from "./api-helpers";
import { logger } from "./logger";

let cachedClient: PrivyClient | null = null;

// In-memory cache of verified Privy auth keyed by sha256(token). Privy's
// verifyAuthToken + getUserById together cost 300-700ms p50; a single 8-tile
// game hits this 10+ times so the cache pays for itself instantly.
//
// 60s TTL is short enough that revoked tokens stop working within a minute,
// long enough to cover one full game session. Cache lives in the function
// process — Vercel cold starts naturally re-prime; warm functions keep it
// across requests.
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX_ENTRIES = 1_000;
type CachedAuth = { value: VerifiedRequest; expiresAt: number };
const authCache = new Map<string, CachedAuth>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function evictExpired(now: number): void {
  if (authCache.size < AUTH_CACHE_MAX_ENTRIES) return;
  for (const [k, v] of authCache) {
    if (v.expiresAt <= now) authCache.delete(k);
  }
  // If still full after expiring, drop the oldest insertion (Map iteration
  // is insertion-ordered).
  while (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldest = authCache.keys().next().value;
    if (!oldest) break;
    authCache.delete(oldest);
  }
}

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
 *
 * Cached for 60s by token-hash to avoid double-roundtrip to Privy on every
 * authed request (verifyAuthToken + getUserById ≈ 360ms p50, 1.3s p99).
 */
export async function verifyPrivyAuth(req: NextRequest): Promise<VerifiedRequest> {
  const token = extractToken(req);
  if (!token) throw new ApiError(401, "Missing auth token");

  const now = Date.now();
  const cacheKey = tokenKey(token);
  const cached = authCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached) authCache.delete(cacheKey);

  let claims: AuthTokenClaims;
  try {
    claims = await privy().verifyAuthToken(token);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "verifyAuthToken failed",
    );
    throw new ApiError(401, "Invalid auth token");
  }

  const userId = claims.userId;
  // Pull the user record so we know which wallets are theirs. Surface the
  // actual error in the response — silently swallowing made every
  // mis-configuration look like "User not found" which masked the real cause
  // (most often: PRIVY_APP_SECRET mismatched with NEXT_PUBLIC_PRIVY_APP_ID).
  let user: Awaited<ReturnType<PrivyClient["getUserById"]>> | null;
  try {
    user = await privy().getUserById(userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ userId, err: msg }, "getUserById failed");
    throw new ApiError(401, `Privy lookup failed: ${msg}`);
  }
  if (!user) {
    logger.warn({ userId }, "getUserById returned null");
    throw new ApiError(401, "User not found in Privy");
  }

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
  const verified: VerifiedRequest = { userId, wallets };
  evictExpired(now);
  authCache.set(cacheKey, { value: verified, expiresAt: now + AUTH_CACHE_TTL_MS });
  return verified;
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
