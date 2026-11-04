import pino from "pino";
import { logLevel } from "./env";

/**
 * Centralized pino logger.
 *
 * Transport: stdout → Railway service logs.
 *
 * Wiring a managed log sink (Axiom / Better Stack / Logflare) is a separate
 * operational decision — pick a vendor, set env vars, add a `pino-*-send`
 * transport here. Until then this stays stdout-only; logs are visible in
 * the Railway dashboard.
 *
 * Redact list (2026-05-11): deliberately wide. Covers secrets, credentials,
 * embedded session ciphertext, and the on-chain commit preimage fields. If
 * any future code path puts these in a log context, pino replaces with
 * `[redacted]` before the record leaves the process. Adding a new secret
 * to the env? Add its names here too.
 */
const REDACT_PATHS = [
  // Request-scoped
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-helius-signature']",
  "req.headers['x-cron-secret']",
  // Game session secrets — the unsealed layout + salt; never log even by
  // accident. AES-GCM ciphertext also redacted because the key may someday
  // leak and the cipher would then be decryptable.
  "*.gameToken",
  "*.salt",
  "*.mineLayout",
  "*.layout",
  "*.commitment",
  "*.preimage",
  // Server-side secrets — defensive. None of these are currently logged in
  // any code path, but if a future logger.info({ env }) creeps in we want
  // it neutered before it ships.
  "*.CRON_SECRET",
  "*.cronSecret",
  "*.HELIUS_WEBHOOK_AUTH",
  "*.heliusWebhookAuth",
  "*.HOUSE_SECRET_KEY", // the raw house keypair
  "*.houseSecretKey",
  "*.secretKey",
  "*.SESSION_ENC_KEY",
  "*.sessionEncKey",
  "*.PRIVY_APP_SECRET",
  "*.privyAppSecret",
  "*.DATABASE_URL", // carries the Postgres password
  "*.databaseUrl",
  "*.connectionString",
  // Generic fall-throughs.
  "*.secret",
  "*.privateKey",
  "*.apiKey",
  "*.token",
];

export const logger = pino({
  level: logLevel(),
  base: undefined,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
