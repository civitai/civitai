#!/usr/bin/env node

/**
 * ClickHouse Query Runner
 *
 * Usage:
 *   node .claude/skills/clickhouse-query/query.mjs "SELECT * FROM views LIMIT 5"
 *   node .claude/skills/clickhouse-query/query.mjs --explain "SELECT * FROM views WHERE userId = 1"
 *   node .claude/skills/clickhouse-query/query.mjs --writable "INSERT INTO ..." (requires explicit flag)
 *   node .claude/skills/clickhouse-query/query.mjs --file query.sql
 *   node .claude/skills/clickhouse-query/query.mjs --timeout 60 "SELECT ..." (override 30s default)
 *
 * Options:
 *   --explain       Show query execution plan (EXPLAIN)
 *   --writable      Allow write operations (INSERT, ALTER, etc.)
 *   --timeout <s>   Query timeout in seconds (default: 30)
 *   --file, -f      Read query from a file
 *   --json          Output results as JSON
 *   --quiet, -q     Only output results, no headers
 */

import { createClient } from '@clickhouse/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

// Simple .env parser (avoid external dependencies)
function loadEnv() {
  try {
    const envPath = resolve(projectRoot, '.env');
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
    console.error('Warning: Could not load .env file');
  }
}

loadEnv();

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
  --explain       Show query execution plan
  --writable      Allow write operations (requires explicit permission)
  --timeout <s>   Query timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --file, -f      Read query from a file
  --json          Output results as JSON
  --quiet, -q     Minimal output

Examples:
  node query.mjs "SELECT count() FROM views"
  node query.mjs --explain "SELECT * FROM modelEvents WHERE modelId = 1"
  node query.mjs --timeout 60 "SELECT ... (long running query)"
  node query.mjs -f my-query.sql`);
  process.exit(1);
}

// Validate environment
if (!process.env.CLICKHOUSE_HOST || !process.env.CLICKHOUSE_USERNAME) {
  console.error('Error: CLICKHOUSE_HOST and CLICKHOUSE_USERNAME must be set in environment');
  process.exit(1);
}

// Safety check for writable operations
if (!writable) {
  const upperQuery = query.toUpperCase().trim();
  const writeOps = ['INSERT', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'RENAME', 'OPTIMIZE'];
  for (const op of writeOps) {
    if (upperQuery.startsWith(op)) {
      console.error(`Error: Write operation detected (${op}). Use --writable flag to confirm.`);
      console.error('This requires explicit user permission as it modifies the database.');
      process.exit(1);
    }
  }
}

async function main() {
  const client = createClient({
    host: process.env.CLICKHOUSE_HOST,
    username: process.env.CLICKHOUSE_USERNAME,
    password: process.env.CLICKHOUSE_PASSWORD,
    request_timeout: timeoutSeconds * 1000,
    clickhouse_settings: {
      max_execution_time: timeoutSeconds,
    },
  });

  try {
    if (!quiet) {
      console.error(`Connected to ClickHouse (timeout: ${timeoutSeconds}s)\n`);
    }

    const finalQuery = explain ? `EXPLAIN ${query}` : query;
    const start = Date.now();

    const result = await client.query({
      query: finalQuery,
      format: 'JSONEachRow',
    });

    const rows = await result.json();
    const elapsed = Date.now() - start;

    if (jsonOutput) {
      console.log(JSON.stringify({
        rows,
        rowCount: rows.length,
        elapsed,
      }, null, 2));
    } else if (explain) {
      // EXPLAIN output format
      for (const row of rows) {
        console.log(row.explain || JSON.stringify(row));
      }
      if (!quiet) {
        console.error(`\nQuery time: ${elapsed}ms`);
      }
    } else {
      if (rows.length === 0) {
        console.log('(no rows returned)');
      } else {
        // Show columns from first row
        if (!quiet) {
          console.log('Columns:', Object.keys(rows[0]).join(', '));
          console.log('─'.repeat(60));
        }

        // Pretty print rows
        for (const row of rows) {
          console.log(row);
        }
      }

      if (!quiet) {
        console.error(`\n${rows.length} row(s) in ${elapsed}ms`);
      }
    }
  } catch (err) {
    if (err.message.includes('timeout') || err.message.includes('TIMEOUT')) {
      console.error(`Error: Query timed out after ${timeoutSeconds} seconds`);
      console.error('Use --timeout <seconds> to increase the limit if needed.');
    } else {
      console.error('Query error:', err.message);
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
