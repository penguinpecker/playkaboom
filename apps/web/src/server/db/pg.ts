import "server-only";
import pg from "pg";

/**
 * The one Postgres pool for the web server (Railway Postgres, DATABASE_URL).
 * The browser never talks to the database; every read and write goes through
 * an API route that uses this module.
 *
 * TLS: Railway's private network URL (`*.railway.internal`) needs none. For the
 * public TCP proxy add `?sslmode=no-verify` (its cert is self-signed) to the URL;
 * the `sslmode` in the URL is honoured as is.
 *
 * Value shapes match what supabase-js (PostgREST) returned, so callers did not
 * change: bigint and numeric come back as JS numbers (same 2^53 ceiling as
 * PostgREST's JSON numbers), timestamptz as "2026-11-04T10:00:00.123456+00:00".
 */

const INT8 = 20;
const NUMERIC = 1700;
const TIMESTAMPTZ = 1184;

/** "2026-11-04 10:00:00.123456+00" (session TimeZone=UTC) -> PostgREST format. */
function pgTimestamptzToIso(v: string): string {
  return v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
}

const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === INT8 || oid === NUMERIC) return Number;
    if (oid === TIMESTAMPTZ) return pgTimestamptzToIso;
    return pg.types.getTypeParser(oid, format as "text");
  },
} as unknown as pg.CustomTypesConfig;

let cached: pg.Pool | null = null;

export function db(): pg.Pool {
  if (cached) return cached;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");
  cached = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // UTC so timestamptz text (and the relay's pg_notify JSON) matches Supabase.
    // statement_timeout: a query stuck behind a lock fails after 30 s instead of
    // holding the tick lock (and every house cron pass) indefinitely.
    options: "-c TimeZone=UTC -c statement_timeout=30000",
    // A dead peer with no RST (DB restart, private-network drop) never answers;
    // query_timeout fails the call client-side, keepAlive surfaces the dead socket.
    query_timeout: 35_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    types,
  });
  // An idle client dying (DB restart, network blip) must not crash the server.
  cached.on("error", () => {});
  return cached;
}

// Errors thrown by query(): their messages can carry the DB host/IP and user
// (ENOTFOUND, ECONNREFUSED, auth failures), so API responses never echo them.
const dbErrors = new WeakSet<object>();
export function isDbError(err: unknown): boolean {
  return typeof err === "object" && err !== null && dbErrors.has(err);
}

/** Parameterized query. Throws pg's DatabaseError (`.code` = SQLSTATE). */
export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    return (await db().query<T>(sql, params)).rows;
  } catch (e) {
    if (typeof e === "object" && e !== null) dbErrors.add(e);
    throw e;
  }
}

// Identifiers below come from code, never from requests; the check keeps it so.
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier: ${name}`);
  return `"${name}"`;
}

/**
 * PostgREST `upsert(row, { onConflict, ignoreDuplicates })`: INSERT the given
 * columns; on conflict UPDATE exactly those columns (or DO NOTHING). Columns not
 * in `row` keep their default on insert and their value on update.
 * Returns the RETURNING rows (empty when ignoreDuplicates skipped the row).
 */
export async function upsert<T extends pg.QueryResultRow = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
  onConflict: string[],
  opts: { ignoreDuplicates?: boolean; returning?: string[] } = {},
): Promise<T[]> {
  const cols = Object.keys(row);
  const update = cols.filter((c) => !onConflict.includes(c));
  const action =
    opts.ignoreDuplicates || update.length === 0
      ? "do nothing"
      : `do update set ${update.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
  const returning = opts.returning?.length
    ? ` returning ${opts.returning.map(ident).join(", ")}`
    : "";
  const sql =
    `insert into public.${ident(table)} (${cols.map(ident).join(", ")}) ` +
    `values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ` +
    `on conflict (${onConflict.map(ident).join(", ")}) ${action}${returning}`;
  return query<T>(sql, Object.values(row));
}

/** PostgREST `rpc(fn, args)`: call a public function with named arguments. */
export async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  const names = Object.keys(args);
  const sql = `select public.${ident(fn)}(${names
    .map((n, i) => `${ident(n)} => $${i + 1}`)
    .join(", ")}) as r`;
  const rows = await query<{ r: T }>(sql, Object.values(args));
  return rows[0]?.r ?? null;
}

/** SQLSTATE of a pg error, if any. */
export function pgCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
