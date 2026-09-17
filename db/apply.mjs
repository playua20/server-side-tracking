/**
 * Applies db/schema.sql to the Supabase database.
 *
 *   node --env-file=.env.local db/apply.mjs
 *
 * The schema is written to be idempotent — `create table if not exists`,
 * `alter table ... add column if not exists`, `create or replace view` — so
 * running it again is how a change reaches the database. Supabase's REST API
 * cannot execute DDL, hence a direct Postgres connection through the pooler.
 *
 * Needs SUPABASE_URL (for the project ref) and SUPABASE_DB_PASSWORD.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { SUPABASE_URL, SUPABASE_DB_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_DB_PASSWORD) {
  console.error('Missing env: SUPABASE_URL and SUPABASE_DB_PASSWORD');
  process.exit(2);
}

const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

// The region prefix has changed over time, so try the known pooler hosts in turn.
const HOSTS = [
  `aws-1-eu-west-1.pooler.supabase.com`,
  `aws-0-eu-west-1.pooler.supabase.com`,
  `db.${ref}.supabase.co`,
];

for (const host of HOSTS) {
  const client = new pg.Client({
    host, port: 5432, database: 'postgres', user: `postgres.${ref}`,
    password: SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    await client.query(sql);
    const { rows } = await client.query(`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`);
    console.log(`applied via ${host}`);
    console.log('tables and views:', rows.map(r => r.table_name).join(', '));
    await client.end();
    process.exit(0);
  } catch (e) {
    console.log(`${host} → ${e.message}`);
    try { await client.end(); } catch {}
  }
}

console.error('could not reach the database on any known host');
process.exit(1);
