#!/usr/bin/env node
// One-shot copy of every PlayKaboom table from Supabase into the Railway Postgres.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//   DATABASE_URL=postgres://... node db/copy-from-supabase.mjs
//
// Run db/migrate.mjs on the target first. Stop the web app's writers (indexer,
// cron) on the Supabase side before copying, so the source does not move.
//
// - Reads through the Supabase REST API (PostgREST) with the service-role key,
//   1000 rows per page, keyset-paged on the primary key.
// - Every column is requested as ::text, so bigint/numeric values above 2^53
//   are copied exactly (PostgREST would otherwise send lossy JSON numbers).
// - Inserts with ON CONFLICT DO NOTHING and the source's own ids, so a re-run
//   copies only what is missing and never overwrites the target.
// - One transaction per table. For games the relay NOTIFY trigger is disabled
//   inside that transaction, so history rows are not broadcast as live games.
// - Not copied: schema_migrations. cron_indexer_state's 'kaboom' seed row stays
//   as the target has it (the old program's cursor rows are copied; harmless).
// - After the copy: serial sequences (points_ledger.id) are moved past max(id),
//   and source vs target row counts are printed.
// The service-role key is never printed.
import pg from "pg";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) {
  console.error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL");
  process.exit(1);
}
const PAGE = 1000;

// FK-safe order (referral_visits.code -> referral_codes.code). [table, primary key]
const TABLES = [
  ["games", "signature"],
  ["player_stats", "player"],
  ["referrals", "referrer"],
  ["referral_events", "signature"],
  ["processed_events", "signature"],
  ["cron_indexer_state", "program"],
  ["lp_positions", "user_address"],
  ["lp_actions", "signature"],
  ["vault_unit_value_history", "slot"],
  ["game_sessions", "game"],
  ["referral_codes", "code"],
  ["referral_visits", "id"],
  ["points_ledger", "id"],
];

const rest = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;
const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

async function get(url, extra = {}, method = "GET") {
  const res = await fetch(url, { method, headers: { ...headers, ...extra } });
  if (!res.ok)
    throw new Error(`${method} ${url.replace(rest, "")}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

async function sourceCount(table) {
  const res = await get(`${rest}/${table}?select=*&limit=1`, { Prefer: "count=exact" }, "HEAD");
  return Number(res.headers.get("content-range")?.split("/")[1]);
}

const db = new pg.Client({ connectionString: DATABASE_URL, options: "-c TimeZone=UTC" });
await db.connect();
try {
  // The target must have exactly these tables (it was migrated from the same files).
  const have = (
    await db.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'schema_migrations'",
    )
  ).rows.map((r) => r.table_name);
  const want = TABLES.map(([t]) => t);
  const diff = [...have.filter((t) => !want.includes(t)), ...want.filter((t) => !have.includes(t))];
  if (diff.length) throw new Error(`table list differs from the target schema: ${diff.join(", ")}`);

  console.log(`source ${new URL(SUPABASE_URL).host} -> target ${db.host}/${db.database}`);
  const report = [];
  for (const [table, key] of TABLES) {
    const cols = (
      await db.query(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position",
        [table],
      )
    ).rows.map((r) => r.column_name);
    const select = cols.map((c) => `${c}::text`).join(",");
    const colList = cols.map((c) => `"${c}"`).join(", ");

    await db.query("begin");
    let inserted = 0;
    let read = 0;
    try {
      if (table === "games")
        await db.query("alter table public.games disable trigger trg_games_notify_relay");
      let last = null;
      for (;;) {
        const filter = last === null ? "" : `&${key}=gt.${encodeURIComponent(last)}`;
        const rows = await (
          await get(`${rest}/${table}?select=${select}&order=${key}.asc&limit=${PAGE}${filter}`)
        ).json();
        if (rows.length === 0) break;
        read += rows.length;
        const res = await db.query(
          `insert into public."${table}" (${colList})
           select ${colList} from json_populate_recordset(null::public."${table}", $1::json)
           on conflict do nothing`,
          [JSON.stringify(rows)],
        );
        inserted += res.rowCount;
        last = rows[rows.length - 1][key];
        if (rows.length < PAGE) break;
      }
      if (table === "games")
        await db.query("alter table public.games enable trigger trg_games_notify_relay");
      await db.query("commit");
    } catch (e) {
      await db.query("rollback");
      throw new Error(`${table}: ${e.message}`);
    }
    const target = Number((await db.query(`select count(*) from public."${table}"`)).rows[0].count);
    report.push({ table, source: await sourceCount(table), read, inserted, target });
    console.log(`${table}: read ${read}, inserted ${inserted}, target now ${target}`);
  }

  // Serial columns: move each sequence past the copied ids.
  const serials = (
    await db.query(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and column_default like 'nextval(%'",
    )
  ).rows;
  for (const { table_name: t, column_name: c } of serials) {
    await db.query(
      `select setval(pg_get_serial_sequence('public."${t}"', '${c}'), coalesce(max("${c}"), 1), max("${c}") is not null) from public."${t}"`,
    );
    console.log(`sequence for ${t}.${c} set past max(${c})`);
  }

  console.table(report);
  const short = report.filter((r) => r.target < r.source);
  if (short.length) {
    console.error(`target has fewer rows than source for: ${short.map((r) => r.table).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("OK: every target table has at least the source's row count");
  }
} finally {
  await db.end();
}
