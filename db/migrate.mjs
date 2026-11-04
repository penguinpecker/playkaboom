#!/usr/bin/env node
// Applies db/migrations/*.sql in filename order, each in its own transaction,
// recording applied files in public.schema_migrations. Re-running is a no-op.
// Usage: DATABASE_URL=postgres://... node db/migrate.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // Serialise concurrent runners (e.g. two replicas booting at once).
  await client.query("select pg_advisory_lock(hashtext('kaboom_migrate'))");
  await client.query(`create table if not exists public.schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set(
    (await client.query("select name from public.schema_migrations")).rows.map((r) => r.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    await client.query("begin");
    try {
      await client.query(readFileSync(join(dir, f), "utf8"));
      await client.query("insert into public.schema_migrations (name) values ($1)", [f]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      console.error(`FAILED ${f}: ${e.message}`);
      process.exitCode = 1;
      break;
    }
    console.log(`applied ${f}`);
    applied++;
  }
  if (!process.exitCode) console.log(`${applied} applied, ${files.length - applied} already up to date`);
} finally {
  await client.end(); // closing the session releases the advisory lock
}
