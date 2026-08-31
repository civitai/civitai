#!/usr/bin/env node

/**
 * PostgreSQL Query Runner
 *
 * Usage:
 *   node .claude/skills/postgres-query/query.mjs --prod "SELECT * FROM \"User\" LIMIT 5"
 *   node .claude/skills/postgres-query/query.mjs --dev --explain "SELECT * FROM \"User\" WHERE id = 1"
 *   node .claude/skills/postgres-query/query.mjs --prod --writable "UPDATE ..." (requires explicit flag)
 *   node .claude/skills/postgres-query/query.mjs --dev --file query.sql
 *   node .claude/skills/postgres-query/query.mjs --prod --timeout 60 "SELECT ..." (override 30s default)
 *
 * Targets (pick one; defaults to --prod):
 *   --prod          Production main database
 *   --dev           Dev cnpg database (DEV_DATABASE_URL)
 *   --data-packet   DataPacket logical replica
 *   --notifications notifications-db replica
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
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env files (skill-specific first, then project root as fallback)
const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const projectRoot = resolve(__dirname, '../../..');

// Simple .env parser (avoid external dependencies)
function loadEnv() {
  const envFiles = [
    resolve(skillDir, '.env'),      // Skill-specific (priority)
    resolve(projectRoot, '.env'),   // Project root (fallback)
  ];

  let loaded = false;
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
        // Presence wins, not truthiness: `DATABASE_REPLICA_URL=` left empty in the skill's .env
        // must not hand the run to the root .env, which names a different database.
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
      loaded = true;
    } catch (e) {
      // File not found, continue to next
    }
  }

  if (!loaded) {
    console.error('Warning: Could not load any .env file');
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

const TARGETS = {
  prod: {
    flag: '--prod',
    label: 'PROD',
    envVar: (writable) => (writable ? 'DATABASE_URL' : 'DATABASE_REPLICA_URL'),
    fallbackEnvVar: 'DATABASE_URL',
    readOnly: false,
  },
  dev: {
    flag: '--dev',
    label: 'DEV',
    envVar: () => 'DEV_DATABASE_URL',
    readOnly: false,
    hint: 'Start the SSH bastion tunnel and add DEV_DATABASE_URL to the skill .env (see SKILL.md).',
  },
  'data-packet': {
    flag: '--data-packet',
    label: 'DATA-PACKET REPLICA',
    envVar: () => 'DATABASE_DATA_PACKET_URL',
    readOnly: true,
  },
  notifications: {
    flag: '--notifications',
    label: 'NOTIFICATIONS-DB REPLICA',
    envVar: () => 'NOTIFICATION_DB_REPLICA_URL',
    readOnly: true,
    hint: 'Start the SSH bastion tunnel and add NOTIFICATION_DB_REPLICA_URL to the skill .env (see SKILL.md).',
  },
};

const DEFAULT_TARGET = 'prod';

// Parse arguments
const args = process.argv.slice(2);
let query = '';
let explain = false;
let writable = false;
let jsonOutput = false;
let quiet = false;
let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
const requestedTargets = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const targetName = Object.keys(TARGETS).find((name) => TARGETS[name].flag === arg);
  if (targetName) {
    if (!requestedTargets.includes(targetName)) requestedTargets.push(targetName);
  } else if (arg === '--explain') {
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
  } else if (arg.startsWith('-') && !/^--(\s|$)/.test(arg) && !/\s/.test(arg)) {
    // A swallowed typo falls through to the default target, which is production. SQL opening with
    // a `--` comment is still SQL, hence the two exceptions above.
    console.error(`Error: unknown option "${arg}".`);
    console.error(`Targets: ${Object.values(TARGETS).map((t) => t.flag).join(', ')}`);
    console.error('Options: --explain --writable --timeout <s> --file <path> --json --quiet');
    process.exit(1);
  } else {
    query = arg;
  }
}

if (!query) {
  console.error(`Usage: node query.mjs [--prod|--dev] [options] "SQL query"

Targets (pick one, defaults to --prod):
  --prod          Production main database
  --dev           Dev cnpg database (needs SSH bastion tunnel)
  --data-packet   DataPacket logical replica (read-only)
  --notifications notifications-db replica (read-only, needs tunnel)

Options:
  --explain       Run EXPLAIN ANALYZE on the query
  --writable      Use primary database (requires explicit permission)
  --timeout <s>   Query timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --file, -f      Read query from a file
  --json          Output results as JSON
  --quiet, -q     Minimal output

Examples:
  node query.mjs --prod "SELECT id, username FROM \\"User\\" LIMIT 5"
  node query.mjs --dev --explain "SELECT * FROM \\"Model\\" WHERE id = 1"
  node query.mjs --prod --timeout 60 "SELECT ... (long running query)"
  node query.mjs --dev -f my-query.sql`);
  process.exit(1);
}

if (requestedTargets.length > 1) {
  console.error(
    `Error: pick one target. Got ${requestedTargets.map((t) => TARGETS[t].flag).join(' and ')}.`
  );
  process.exit(1);
}

const targetName = requestedTargets[0] ?? DEFAULT_TARGET;
const target = TARGETS[targetName];
const targetWasExplicit = requestedTargets.length === 1;

const candidateVars = [...new Set([target.envVar(writable), target.fallbackEnvVar].filter(Boolean))];
const connectionVar = candidateVars.find((name) => process.env[name]);
const connectionString = connectionVar && process.env[connectionVar];

if (!connectionString) {
  console.error(`Error: ${target.flag} needs ${candidateVars.join(' or ')} set, and it is not.`);
  if (target.hint) console.error(target.hint);
  process.exit(1);
}

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  statement_timeout: timeoutSeconds * 1000,
  query_timeout: timeoutSeconds * 1000,
});

// The wrong-database failure is silent by construction: this skill's .env and the app's root .env
// name different databases under the same key names. Report the parameters pg itself resolved —
// not a re-parse of the string — so the line can't disagree with what the query actually hit.
function describeConnection() {
  const { user, host, port, database } = client.connectionParameters ?? {};
  if (!host) return '(connection parameters unavailable)';
  return `${user ? `${user}@` : ''}${host}:${port}/${database ?? '(default db)'}`;
}

const onFallback = connectionVar !== target.envVar(writable);
const access =
  writable && !target.readOnly
    ? 'writable'
    : onFallback
      ? 'read-only, but pointed at the primary'
      : 'read-only';
console.error(
  `Target: ${target.label} (${access}) -> ${describeConnection()} ` +
    `[${connectionVar}, timeout ${timeoutSeconds}s]`
);
if (!targetWasExplicit) {
  console.error(
    `No target flag given, defaulted to ${target.flag}. Pass --prod or --dev to be explicit.`
  );
}
console.error('');

if (writable && target.readOnly) {
  console.error(`Error: ${target.flag} is a read-only replica; --writable cannot apply to it.`);
  process.exit(1);
}

// Client-side write guard. It matches each statement's leading keyword, so it catches an accidental
// write, not a determined one: anything nested deeper than a leading CTE gets through, and only
// the role you connect as stops that. Comments and string literals are blanked first, so
// `/* note */ DELETE` can't slip past and a SELECT mentioning "delete" in a literal isn't blocked.
//
// EVERY statement, not just the first. A migration file opens with a comment block, then
// `SET lock_timeout`, then `BEGIN` — so a guard reading only the leading keyword of the whole string
// sees `SET`, passes it, and runs the `ALTER TABLE`s underneath without --writable. Splitting on `;`
// is not a parser (a dollar-quoted body containing a semicolon can be split mid-body), but the
// failure direction is a spurious refusal rather than a wave-through, which is the right way round.
if (!writable || target.readOnly) {
  const blanked = query
    .replace(/'([^']|'')*'/g, "''")
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .toUpperCase();
  const writeOps = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
  for (const statement of blanked.split(';')) {
    const upperQuery = statement.trim();
    if (!upperQuery) continue;
    for (const op of writeOps) {
      const nested = upperQuery.startsWith('WITH') && new RegExp(`\\(\\s*${op}\\b`).test(upperQuery);
      if (upperQuery.startsWith(op) || nested) {
        const ctx = target.readOnly
          ? `${target.flag} is read-only.`
          : 'Use --writable flag to confirm.';
        console.error(`Error: Write operation detected (${op}). ${ctx}`);
        console.error('This requires explicit user permission as it modifies the database.');
        process.exit(1);
      }
    }
  }
}

async function main() {
  try {
    await client.connect();

    const finalQuery = explain ? `EXPLAIN ANALYZE ${query}` : query;
    const start = Date.now();
    const queryResult = await client.query(finalQuery);
    const elapsed = Date.now() - start;

    // A MULTI-STATEMENT query resolves to an ARRAY of Results, one per statement, not to a single
    // Result. Reading `.rows` off that array yields undefined and `.rows.length` throws — which the
    // catch below reported as `Query error: Cannot read properties of undefined (reading 'length')`
    // AFTER the server had already executed and committed every statement. So the tool announced a
    // failure for work it had done: two people read that message as "the DDL was refused" and went
    // looking for a permissions problem that did not exist. Normalise to a list and render each.
    const results = Array.isArray(queryResult) ? queryResult : [queryResult];

    if (jsonOutput) {
      const shape = (r) => ({
        rows: r.rows ?? [],
        rowCount: r.rowCount,
        command: r.command,
        fields: r.fields?.map((f) => f.name),
      });
      // Single statement keeps the original flat shape so existing callers parsing this don't break.
      console.log(
        JSON.stringify(
          results.length === 1
            ? { ...shape(results[0]), elapsed }
            : { statements: results.map(shape), elapsed },
          null,
          2
        )
      );
    } else if (explain) {
      console.log(
        results
          .flatMap((r) => (r.rows ?? []).map((row) => row['QUERY PLAN']))
          .join('\n')
      );
      if (!quiet) {
        console.error(`\nQuery time: ${elapsed}ms`);
      }
    } else {
      results.forEach((result, i) => {
        // Only label the statements when there is more than one — a single-statement run should look
        // exactly as it always has.
        if (!quiet && results.length > 1) {
          console.log(`\n── statement ${i + 1}/${results.length}${result.command ? ` (${result.command})` : ''}`);
        }

        if (!quiet && result.fields?.length) {
          console.log('Columns:', result.fields.map((f) => f.name).join(', '));
          console.log('─'.repeat(60));
        }

        const rows = result.rows ?? [];
        if (!result.fields?.length) {
          // A DDL / SET / BEGIN statement returns no field descriptors and no rows. Say what it did
          // rather than "(no rows returned)", which reads like a query that found nothing.
          if (!quiet) console.log(`${result.command ?? 'OK'} — no result set`);
        } else if (rows.length === 0) {
          console.log('(no rows returned)');
        } else {
          for (const row of rows) {
            console.log(row);
          }
        }
      });

      if (!quiet) {
        const total = results.reduce((sum, r) => sum + (r.rowCount ?? 0), 0);
        const label =
          results.length > 1
            ? `${results.length} statement(s), ${total} row(s)`
            : `${results[0]?.rowCount ?? 0} row(s)`;
        console.error(`\n${label} in ${elapsed}ms`);
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
