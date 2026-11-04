#!/usr/bin/env node
// Least-privilege login roles for Railway Postgres. Run once as the template's
// `postgres` superuser, after migrate.mjs (re-running is safe and re-hands any
// object a later owner-run migration created):
//
//   kaboom_app    LOGIN, not superuser. Owns every object in schema public, so
//                 kaboom-web and its pre-deploy migrate run as it. No superuser
//                 powers: no COPY ... PROGRAM, no other roles, no other databases.
//   kaboom_relay  LOGIN, CONNECT only. Enough to LISTEN kaboom_events; it can
//                 read, write and execute nothing in public.
//
// Passwords come from the env and are never printed. They go into URLs, so
// they must be URL-safe: 24+ letters/digits (`openssl rand -hex 32`).
//
//   DATABASE_URL=<owner url> KABOOM_APP_DB_PASSWORD=... KABOOM_RELAY_DB_PASSWORD=... node db/roles.mjs
import pg from "pg";

const url = process.env.DATABASE_URL;
const passwords = {
  kaboom_app: process.env.KABOOM_APP_DB_PASSWORD,
  kaboom_relay: process.env.KABOOM_RELAY_DB_PASSWORD,
};
if (!url || !passwords.kaboom_app || !passwords.kaboom_relay) {
  console.error("DATABASE_URL, KABOOM_APP_DB_PASSWORD and KABOOM_RELAY_DB_PASSWORD must be set");
  process.exit(1);
}
for (const [role, pw] of Object.entries(passwords)) {
  if (!/^[A-Za-z0-9]{24,}$/.test(pw)) {
    console.error(`password for ${role} must be 24+ letters/digits (URL-safe)`);
    process.exit(1);
  }
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const {
    rows: [me],
  } = await c.query(
    "select current_database() as db, rolsuper from pg_roles where rolname = current_user",
  );
  if (!me?.rolsuper) throw new Error("run as the database superuser (Railway's postgres user)");
  const db = c.escapeIdentifier(me.db);

  await c.query("begin");
  for (const [role, pw] of Object.entries(passwords)) {
    await c.query(
      `do $$ begin if not exists (select from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`,
    );
    await c.query(
      `alter role ${role} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${c.escapeLiteral(pw)}`,
    );
  }
  await c.query(`revoke all on database ${db} from public`);
  await c.query(`grant connect, temporary on database ${db} to kaboom_app`);
  await c.query(`grant connect on database ${db} to kaboom_relay`);
  await c.query("revoke all on schema public from public");
  await c.query("grant usage, create on schema public to kaboom_app");
  // Hand every object in public to kaboom_app. Sequences owned by a table move
  // with it; extension members stay with their extension.
  await c.query(`do $$
    declare r record;
    begin
      for r in
        select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and pg_get_userbyid(c.relowner) <> 'kaboom_app'
          and not exists (select from pg_depend d where d.objid = c.oid and d.deptype = 'e')
      loop
        execute format('alter %s public.%I owner to kaboom_app',
          case r.relkind when 'v' then 'view' when 'm' then 'materialized view'
                         when 'f' then 'foreign table' else 'table' end, r.relname);
      end loop;
      for r in
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'S' and pg_get_userbyid(c.relowner) <> 'kaboom_app'
          and not exists (select from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i', 'e'))
      loop
        execute format('alter sequence public.%I owner to kaboom_app', r.relname);
      end loop;
      for r in
        select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and pg_get_userbyid(p.proowner) <> 'kaboom_app'
          and not exists (select from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      loop
        execute format('alter routine %s owner to kaboom_app', r.sig);
      end loop;
    end $$`);
  // Functions are executable by PUBLIC by default; only the owner needs them.
  await c.query("revoke execute on all functions in schema public from public");
  await c.query(
    "alter default privileges for role kaboom_app in schema public revoke execute on functions from public",
  );
  await c.query("commit");

  const {
    rows: [left],
  } = await c.query(`select
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and pg_get_userbyid(c.relowner) <> 'kaboom_app')::int as rels,
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and pg_get_userbyid(p.proowner) <> 'kaboom_app')::int as funcs`);
  console.log(
    `roles kaboom_app (owner of public) and kaboom_relay (connect only) ready on ${me.db}; ` +
      `objects in public not owned by kaboom_app: ${left.rels} relations, ${left.funcs} functions`,
  );
  if (left.rels || left.funcs) process.exitCode = 1;
} catch (e) {
  await c.query("rollback").catch(() => {});
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
