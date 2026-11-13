#!/usr/bin/env node

/**
 * PostgreSQL Query Runner
 *
 * Usage:
 *   node .claude/skills/postgres-query/query.mjs "SELECT * FROM \"User\" LIMIT 5"
 *   node .claude/skills/postgres-query/query.mjs --explain "SELECT * FROM \"User\" WHERE id = 1"
 *   node .claude/skills/postgres-query/query.mjs --writable "UPDATE ..." (requires explicit flag)
 *   node .claude/skills/postgres-query/query.mjs --file query.sql
 *   node .claude/skills/postgres-query/query.mjs --timeout 60 "SELECT ..." (override 30s default)
 *
 * Options:
 *   --explain       Run EXPLAIN ANALYZE on the query
 *   --writable      Use the primary database (DATABASE_URL) instead of replica
 *   --timeout <s>   Query timeout in seconds (default: 30)
 *   --file, -f      Read query from a file
 *   --json          Output results as JSON
 *   --quiet, -q     Only output results, no headers
 */

import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from skill directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '.env');

// Simple .env parser (avoid external dependencies)
function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error('Error: .env file not found in skill directory');
    console.error('');
    console.error('Setup:');
    console.error('  1. Copy .env-example to .env in the skill directory');
    console.error('  2. Add your PostgreSQL connection URLs');
    process.exit(1);
  }

  try {
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.error('Error: Could not load .env file:', e.message);
    process.exit(1);
  }
}

loadEnv();

const { Client } = pg;

// `timestamp` (OID 1114) carries no offset and node-postgres parses it in the
// reader's local timezone, silently shifting every value we print as UTC.
const parseTimestamp = pg.types.getTypeParser(1114);
pg.types.setTypeParser(1114, (value) =>
  /^-?infinity$/i.test(value) ? parseTimestamp(value) : new Date(value + 'Z')
);

const DEFAULT_TIMEOUT_SECONDS = 30;

// Parse arguments
const args = process.argv.slice(2);
let query = '';
let explain = false;
let writable = false;
let jsonOutput = false;
let quiet = false;
let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--explain') {
    explain = true;
  } else if (arg === '--writable') {
    writable = true;
  } else if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--quiet' || arg === '-q') {
    quiet = true;
  } else if (arg === '--timeout' || arg === '-t') {
    const val = args[++i];
    if (!val || isNaN(parseInt(val, 10))) {
      console.error('Error: --timeout requires a number (seconds)');
      process.exit(1);
    }
    timeoutSeconds = parseInt(val, 10);
  } else if (arg === '--file' || arg === '-f') {
    const filePath = args[++i];
    if (!filePath) {
      console.error('Error: --file requires a path argument');
      process.exit(1);
    }
    query = readFileSync(resolve(process.cwd(), filePath), 'utf-8');
  } else if (!arg.startsWith('-')) {
    query = arg;
  }
}

if (!query) {
  console.error(`Usage: node query.mjs [options] "SQL query"

Options:
  --explain       Run EXPLAIN ANALYZE on the query
  --writable      Use primary database (requires explicit permission)
  --timeout <s>   Query timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --file, -f      Read query from a file
  --json          Output results as JSON
  --quiet, -q     Minimal output

Examples:
  node query.mjs "SELECT id, username FROM \\"User\\" LIMIT 5"
  node query.mjs --explain "SELECT * FROM \\"Model\\" WHERE id = 1"
  node query.mjs --timeout 60 "SELECT ... (long running query)"
  node query.mjs -f my-query.sql`);
  process.exit(1);
}

// Select connection string
const connectionString = writable
  ? process.env.DATABASE_URL
  : (process.env.DATABASE_REPLICA_URL || process.env.DATABASE_URL);

if (!connectionString) {
  console.error('Error: No database connection string found in environment');
  process.exit(1);
}

// Safety check for writable operations
if (!writable) {
  const upperQuery = query.toUpperCase().trim();
  const writeOps = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
  for (const op of writeOps) {
    if (upperQuery.startsWith(op)) {
      console.error(`Error: Write operation detected (${op}). Use --writable flag to confirm.`);
      console.error('This requires explicit user permission as it modifies the database.');
      process.exit(1);
    }
  }
}

async function main() {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    statement_timeout: timeoutSeconds * 1000,
    query_timeout: timeoutSeconds * 1000,
  });

  try {
    await client.connect();

    if (!quiet) {
      const dbType = writable ? 'PRIMARY (writable)' : 'REPLICA (read-only)';
      console.error(`Connected to ${dbType} (timeout: ${timeoutSeconds}s)\n`);
    }

    // READ-ONLY BY CONSTRUCTION. Every run without --writable runs in a READ ONLY transaction, so the
    // SERVER refuses a write, whatever the SQL is and whatever server it lands on (this copy falls
    // back to DATABASE_URL when no replica URL is set, and after a failover a read pooler can hold
    // connections to the new primary). Three parts, each needed:
    //   1. BEGIN READ ONLY, and the query below runs inside it.
    //   2. A SELECT pins the snapshot. After it, Postgres refuses to turn transaction_read_only off
    //      ("transaction read-write mode must be set before any query"), even from inside a function.
    //   3. The user's SQL goes out as ONE statement on the extended protocol, so it cannot COMMIT the
    //      read-only transaction and then run a second statement outside it. Several statements fail
    //      with "cannot insert multiple commands into a prepared statement".
    // The transaction is rolled back, never committed.
    // Part 3 needs a pg that honours `queryMode: 'extended'`. An older pg (8.11.3 was measured) ignores
    // the option and sends the simple protocol, where `COMMIT; INSERT ...` ends the read-only
    // transaction and the INSERT lands. Refuse rather than run unprotected.
    const readOnlyRun = !writable;
    if (readOnlyRun && !new pg.Query({ text: 'SELECT 1', queryMode: 'extended' }).requiresPreparation()) {
      console.error('Error: the installed pg package cannot send a single extended-protocol statement, so a read cannot be kept read-only. Upgrade pg.');
      await client.end();
      process.exit(1);
    }
    if (readOnlyRun) {
      await client.query('BEGIN READ ONLY');
      const { rows } = await client.query("SELECT current_setting('transaction_read_only') AS ro");
      if (rows[0]?.ro !== 'on') {
        console.error(`Error: could not open a read-only transaction (transaction_read_only=${rows[0]?.ro}).`);
        await client.end();
        process.exit(1);
      }
    }

    const finalQuery = explain ? `EXPLAIN ANALYZE ${query}` : query;
    const start = Date.now();
    const result = await client.query(
      readOnlyRun ? { text: finalQuery, queryMode: 'extended' } : finalQuery
    );
    const elapsed = Date.now() - start;
    if (readOnlyRun) await client.query('ROLLBACK');

    if (jsonOutput) {
      console.log(JSON.stringify({
        rows: result.rows,
        rowCount: result.rowCount,
        elapsed,
        fields: result.fields?.map(f => f.name)
      }, null, 2));
    } else if (explain) {
      console.log(result.rows.map(r => r['QUERY PLAN']).join('\n'));
      if (!quiet) {
        console.error(`\nQuery time: ${elapsed}ms`);
      }
    } else {
      if (!quiet && result.fields) {
        console.log('Columns:', result.fields.map(f => f.name).join(', '));
        console.log('─'.repeat(60));
      }

      if (result.rows.length === 0) {
        console.log('(no rows returned)');
      } else {
        // Pretty print rows
        for (const row of result.rows) {
          console.log(row);
        }
      }

      if (!quiet) {
        console.error(`\n${result.rowCount} row(s) in ${elapsed}ms`);
      }
    }
  } catch (err) {
    if (err.message.includes('timeout') || err.message.includes('canceling statement')) {
      console.error(`Error: Query timed out after ${timeoutSeconds} seconds`);
      console.error('Use --timeout <seconds> to increase the limit if needed.');
    } else if (err.message.includes('multiple commands into a prepared statement')) {
      console.error('Error: a read runs ONE statement (it stays inside a read-only transaction). Run each statement on its own.');
    } else {
      console.error('Query error:', err.message);
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
