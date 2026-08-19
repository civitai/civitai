#!/usr/bin/env node
// Query Retool's own Postgres (the `retool_db` resource in app exports).
//
//   node retool-db.mjs "SELECT * FROM \"UserStrikes\" LIMIT 5"
//   node retool-db.mjs --tables            # list tables with row counts
//   node retool-db.mjs --describe UserStrikes
//   node retool-db.mjs --json "SELECT ..."
//
// READ-ONLY. This database is the source for a one-way data migration into Civitai's Postgres; nothing
// here should ever write to it, and the moderator app must not read it at runtime. Writes are refused.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env reader — no dependency, same approach as the sibling postgres-query skill.
const envFile = path.join(dir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const connectionString = process.env.RETOOL_DATABASE_URL;
if (!connectionString) {
  console.error(
    'RETOOL_DATABASE_URL is not set.\n' +
      `Copy ${path.relative(process.cwd(), path.join(dir, '.env.example'))} to .env and fill it in.`
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rest = args.filter((a) => a !== '--json');

let query;
if (rest[0] === '--tables') {
  query = `
    SELECT table_name,
           (xpath('/row/c/text()',
             query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
             false, true, '')))[1]::text::bigint AS rows
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY rows DESC NULLS LAST`;
} else if (rest[0] === '--describe') {
  if (!rest[1]) {
    console.error('usage: node retool-db.mjs --describe <table>');
    process.exit(1);
  }
  query = `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = '${rest[1].replace(/'/g, "''")}'
           ORDER BY ordinal_position`;
} else {
  query = rest.join(' ');
}

if (!query) {
  console.error('usage: node retool-db.mjs [--tables|--describe <table>|--json] "<sql>"');
  process.exit(1);
}

// Refuse writes outright rather than gating them behind a flag: this database is a migration SOURCE.
if (/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i.test(query)) {
  console.error('Refused: retool-db.mjs is read-only. This database is a migration source.');
  process.exit(1);
}

// Strip sslmode and set `ssl` explicitly: pg 8.16 warns loudly that it treats `require` as
// `verify-full`, which would reject Retool's cert chain. We want encrypted-but-unverified.
const sslDisabled = /sslmode=disable/.test(connectionString);
const client = new pg.Client({
  connectionString: connectionString.replace(/[?&]sslmode=[^&]*/g, (m) => (m[0] === '?' ? '?' : '')),
  ssl: sslDisabled ? false : { rejectUnauthorized: false },
  statement_timeout: 30_000,
});

try {
  await client.connect();
  const result = await client.query(query);
  if (asJson) console.log(JSON.stringify(result.rows, null, 2));
  else if (result.rows.length === 0) console.log('(no rows)');
  else {
    for (const row of result.rows) console.log(row);
    console.log(`\n${result.rows.length} row(s)`);
  }
} catch (e) {
  console.error(`Query failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
