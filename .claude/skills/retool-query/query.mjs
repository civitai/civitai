#!/usr/bin/env node

/**
 * Retool Database Query Runner
 *
 * Usage:
 *   node .claude/skills/retool-query/query.mjs "SELECT * FROM \"UserNotes\" LIMIT 5"
 *   node .claude/skills/retool-query/query.mjs --writable "INSERT INTO ..."
 *   node .claude/skills/retool-query/query.mjs --file query.sql
 *   node .claude/skills/retool-query/query.mjs --timeout 60 "SELECT ..."
 *
 * Options:
 *   --writable      Allow write operations (requires explicit flag)
 *   --timeout <s>   Query timeout in seconds (default: 30)
 *   --file, -f      Read query from a file
 *   --json          Output results as JSON
 *   --quiet, -q     Only output results, no headers
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const projectRoot = resolve(__dirname, '../../..');

function loadEnv() {
  const envFiles = [
    resolve(skillDir, '.env'),
    resolve(projectRoot, '.env'),
  ];

  for (const envPath of envFiles) {
    try {
      const envContent = readFileSync(envPath, 'utf-8');
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
      // File not found, continue
    }
  }
}

loadEnv();

const { Client } = pg;
const DEFAULT_TIMEOUT_SECONDS = 30;

// Parse arguments
const args = process.argv.slice(2);
let query = '';
let writable = false;
let jsonOutput = false;
let quiet = false;
let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--writable') {
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
  --writable      Allow write operations (requires user permission)
  --timeout <s>   Query timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --file, -f      Read query from a file
  --json          Output results as JSON
  --quiet, -q     Minimal output

Examples:
  node query.mjs "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  node query.mjs "SELECT * FROM \\"UserNotes\\" LIMIT 5"
  node query.mjs --json "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'UserNotes'"`);
  process.exit(1);
}

const connectionString = process.env.RETOOL_DATABASE_URL;

if (!connectionString) {
  console.error('Error: RETOOL_DATABASE_URL not set');
  console.error('Create .claude/skills/retool-query/.env with the Retool database URL');
  console.error('See .env.example for details');
  process.exit(1);
}

// Safety check for write operations
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
      const mode = writable ? 'WRITABLE' : 'READ-ONLY';
      console.error(`Connected to Retool DB (${mode}, timeout: ${timeoutSeconds}s)\n`);
    }

    const start = Date.now();
    const result = await client.query(query);
    const elapsed = Date.now() - start;

    if (jsonOutput) {
      console.log(JSON.stringify({
        rows: result.rows,
        rowCount: result.rowCount,
        elapsed,
        fields: result.fields?.map(f => f.name)
      }, null, 2));
    } else {
      if (!quiet && result.fields) {
        console.log('Columns:', result.fields.map(f => f.name).join(', '));
        console.log('\u2500'.repeat(60));
      }

      if (result.rows.length === 0) {
        console.log('(no rows returned)');
      } else {
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
    } else {
      console.error('Query error:', err.message);
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
