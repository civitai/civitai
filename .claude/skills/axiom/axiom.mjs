#!/usr/bin/env node

/**
 * Axiom APL Query CLI
 *
 * Query Axiom datasets using APL (Axiom Processing Language).
 * Requires AXIOM_TOKEN env var.
 *
 * Usage: node axiom.mjs <command> [options]
 */

import https from 'https';
import './load-env.mjs';

// ── Config ──────────────────────────────────────────────────────────────────

const TOKEN = process.env.AXIOM_TOKEN;
const ORG_ID = process.env.AXIOM_ORG_ID;
const DOMAIN = process.env.AXIOM_DOMAIN || 'api.axiom.co';

// ── HTTP helper ─────────────────────────────────────────────────────────────

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    };
    if (ORG_ID) headers['X-Axiom-Org-Id'] = ORG_ID;

    const url = new URL(`https://${DOMAIN}${path}`);
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            resolve({ _error: true, statusCode: res.statusCode, ...json });
          } else {
            resolve(json);
          }
        } catch {
          if (res.statusCode >= 400) {
            resolve({ _error: true, statusCode: res.statusCode, body: data });
          } else {
            resolve({ raw: data });
          }
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

const commands = {};

// ─ Query ────────────────────────────────────────────────────────────────────

commands.query = {
  description: 'Run an APL query against Axiom',
  usage: 'query "<APL query>" [--start <time>] [--end <time>] [--format tabular|legacy]',
  run: async (args) => {
    const apl = args[0];
    if (!apl) die('APL query string is required as the first argument');

    const format = getFlag(args, '--format') || 'tabular';
    const startTime = getFlag(args, '--start');
    const endTime = getFlag(args, '--end');

    const body = { apl };
    if (startTime) body.startTime = startTime;
    if (endTime) body.endTime = endTime;

    const result = await request('POST', `/v1/datasets/_apl?format=${format}`, body);

    if (result._error) return result;

    // For tabular format, extract and flatten the results
    if (format === 'tabular' && result.tables) {
      return formatTabular(result);
    }

    return result;
  },
};

// ─ Datasets ─────────────────────────────────────────────────────────────────

commands.datasets = {
  description: 'List all available datasets',
  usage: 'datasets',
  run: async () => {
    const result = await request('GET', '/v1/datasets');
    if (result._error) return result;
    if (Array.isArray(result)) {
      return result.map((d) => ({
        name: d.name,
        description: d.description || '',
        created: d.created,
      }));
    }
    return result;
  },
};

// ─ Dataset info ─────────────────────────────────────────────────────────────

commands['dataset-info'] = {
  description: 'Get info about a specific dataset (fields, stats)',
  usage: 'dataset-info <dataset_name>',
  run: async (args) => {
    const name = args[0];
    if (!name) die('Dataset name is required');
    return request('GET', `/v1/datasets/${encodeURIComponent(name)}`);
  },
};

// ─ Convenience: search logs ─────────────────────────────────────────────────

commands.search = {
  description: 'Search logs by field values (convenience wrapper around APL query)',
  usage: 'search <dataset> --where "<field> == <value>" [--start <time>] [--end <time>] [--limit <n>]',
  run: async (args) => {
    const dataset = args[0];
    if (!dataset) die('Dataset name is required as the first argument');

    const where = getFlag(args, '--where');
    const start = getFlag(args, '--start');
    const end = getFlag(args, '--end');
    const limit = getFlag(args, '--limit') || '50';

    let apl = `['${dataset}']`;
    if (where) apl += ` | where ${where}`;
    apl += ` | sort by _time desc | take ${limit}`;

    const body = { apl };
    if (start) body.startTime = start;
    if (end) body.endTime = end;

    const result = await request('POST', '/v1/datasets/_apl?format=tabular', body);
    if (result._error) return result;
    if (result.tables) return formatTabular(result);
    return result;
  },
};

// ─ Count ────────────────────────────────────────────────────────────────────

commands.count = {
  description: 'Count events matching a filter',
  usage: 'count <dataset> [--where "<filter>"] [--start <time>] [--end <time>] [--by <field>]',
  run: async (args) => {
    const dataset = args[0];
    if (!dataset) die('Dataset name is required');

    const where = getFlag(args, '--where');
    const start = getFlag(args, '--start');
    const end = getFlag(args, '--end');
    const by = getFlag(args, '--by');

    let apl = `['${dataset}']`;
    if (where) apl += ` | where ${where}`;
    if (by) {
      apl += ` | summarize count() by ${by} | order by count_ desc`;
    } else {
      apl += ` | count`;
    }

    const body = { apl };
    if (start) body.startTime = start;
    if (end) body.endTime = end;

    const result = await request('POST', '/v1/datasets/_apl?format=tabular', body);
    if (result._error) return result;
    if (result.tables) return formatTabular(result);
    return result;
  },
};

// ─ Tail (most recent events) ────────────────────────────────────────────────

commands.tail = {
  description: 'Show the most recent events from a dataset',
  usage: 'tail <dataset> [--limit <n>] [--where "<filter>"] [--fields "<f1>,<f2>,..."]',
  run: async (args) => {
    const dataset = args[0];
    if (!dataset) die('Dataset name is required');

    const limit = getFlag(args, '--limit') || '20';
    const where = getFlag(args, '--where');
    const fields = getFlag(args, '--fields');

    let apl = `['${dataset}']`;
    if (where) apl += ` | where ${where}`;
    apl += ` | sort by _time desc | take ${limit}`;
    if (fields) apl += ` | project _time, ${fields}`;

    const result = await request('POST', '/v1/datasets/_apl?format=tabular', { apl });
    if (result._error) return result;
    if (result.tables) return formatTabular(result);
    return result;
  },
};

// ─ Top values ───────────────────────────────────────────────────────────────

commands.top = {
  description: 'Show top values for a field',
  usage: 'top <dataset> <field> [--limit <n>] [--where "<filter>"] [--start <time>] [--end <time>]',
  run: async (args) => {
    const dataset = args[0];
    const field = args[1];
    if (!dataset || !field) die('Dataset and field are required');

    const limit = getFlag(args, '--limit') || '20';
    const where = getFlag(args, '--where');
    const start = getFlag(args, '--start');
    const end = getFlag(args, '--end');

    let apl = `['${dataset}']`;
    if (where) apl += ` | where ${where}`;
    apl += ` | summarize count() by ${field} | order by count_ desc | take ${limit}`;

    const body = { apl };
    if (start) body.startTime = start;
    if (end) body.endTime = end;

    const result = await request('POST', '/v1/datasets/_apl?format=tabular', body);
    if (result._error) return result;
    if (result.tables) return formatTabular(result);
    return result;
  },
};

// ── Tabular format helper ───────────────────────────────────────────────────

function formatTabular(result) {
  const tables = result.tables || [];
  if (!tables.length) return { rows: [], count: 0 };

  const output = [];

  for (const table of tables) {
    const columns = table.fields || [];
    const colNames = columns.map((c) => c.name);
    const colData = columns.map((c) => c.data || []);
    const rowCount = colData[0]?.length || 0;

    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const row = {};
      for (let j = 0; j < colNames.length; j++) {
        row[colNames[j]] = colData[j]?.[i] ?? null;
      }
      rows.push(row);
    }
    output.push(...rows);
  }

  return { rows: output, count: output.length, status: result.status };
}

// ── Arg parsing helpers ─────────────────────────────────────────────────────

function getFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ── Output ──────────────────────────────────────────────────────────────────

function formatOutput(data, jsonMode) {
  if (jsonMode) return JSON.stringify(data, null, 2);

  if (data._error) {
    return `Error (${data.statusCode}): ${data.message || data.body || JSON.stringify(data)}`;
  }

  // Tabular results with rows
  if (data.rows && Array.isArray(data.rows)) {
    if (data.rows.length === 0) return 'No results.';

    const lines = [`Results: ${data.count} row(s)\n`];

    // For small result sets, print each row
    if (data.rows.length <= 100) {
      for (const row of data.rows) {
        // Compact single-line for simple rows, multi-line for complex
        const keys = Object.keys(row);
        if (keys.length <= 4) {
          const parts = keys.map((k) => `${k}=${formatValue(row[k])}`);
          lines.push(`  ${parts.join('  ')}`);
        } else {
          lines.push('---');
          for (const [k, v] of Object.entries(row)) {
            if (k === '_sysTime' || k === '_rowId') continue; // skip internal fields
            lines.push(`  ${k}: ${formatValue(v)}`);
          }
        }
      }
    } else {
      lines.push(`(${data.rows.length} rows — use --json for full output)`);
      // Show first 5
      for (const row of data.rows.slice(0, 5)) {
        lines.push('---');
        for (const [k, v] of Object.entries(row)) {
          if (k === '_sysTime' || k === '_rowId') continue;
          lines.push(`  ${k}: ${formatValue(v)}`);
        }
      }
      lines.push(`... and ${data.rows.length - 5} more`);
    }

    return lines.join('\n');
  }

  // Dataset list
  if (Array.isArray(data)) {
    if (data.length === 0) return 'No datasets found.';
    const lines = [`Datasets (${data.length}):\n`];
    for (const d of data) {
      lines.push(`  ${d.name}${d.description ? ` — ${d.description}` : ''}`);
    }
    return lines.join('\n');
  }

  return JSON.stringify(data, null, 2);
}

function formatValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && v.length > 120) return v.slice(0, 117) + '...';
  return String(v);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);
  const jsonMode = hasFlag(rawArgs, '--json');
  const args = rawArgs.filter((a) => a !== '--json');

  const command = args[0];
  const cmdArgs = args.slice(1);

  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  if (!TOKEN) {
    die(
      'AXIOM_TOKEN environment variable is required.\n' +
        'Set it in ~/.claude/skills/axiom/.env or pass it inline.'
    );
  }

  const cmd = commands[command];
  if (!cmd) {
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
  }

  try {
    const result = await cmd.run(cmdArgs);
    console.log(formatOutput(result, jsonMode));
  } catch (err) {
    console.error(`Request failed: ${err.message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log('Axiom APL Query CLI\n');
  console.log('Usage: node axiom.mjs <command> [options]\n');
  console.log('Global flags:');
  console.log('  --json       Output raw JSON\n');
  console.log('Commands:');
  for (const [name, cmd] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(16)} ${cmd.description}`);
    console.log(`  ${''.padEnd(16)} ${cmd.usage}\n`);
  }
  console.log('Time formats:');
  console.log('  ISO 8601:    2026-03-01T00:00:00Z');
  console.log('  Relative:    Use ago() in APL queries, e.g. _time > ago(24h)');
  console.log('  Date only:   2026-03-01 (interpreted as start of day UTC)\n');
  console.log('APL cheatsheet:');
  console.log('  Filter:      | where name == "value"');
  console.log('  Time range:  | where _time > ago(7d)');
  console.log('  Count:       | summarize count() by field');
  console.log('  Sort:        | sort by _time desc');
  console.log('  Limit:       | take 50');
  console.log('  Project:     | project _time, field1, field2');
  console.log('  Contains:    | where field contains "substring"');
  console.log('  Regex:       | where field matches regex "pattern"');
}

main();
