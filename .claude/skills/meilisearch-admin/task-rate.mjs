#!/usr/bin/env node

/**
 * Meilisearch Task Rate Report
 *
 * Shows tasks grouped by minute and type for a given status.
 *
 * Usage:
 *   node .claude/skills/meilisearch-admin/task-rate.mjs [--feed] [--status enqueued] [--json]
 */

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
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {}
  }
}

loadEnv();

// Parse args
const args = process.argv.slice(2);
let useFeed = false;
let jsonOutput = false;
let status = 'enqueued';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--feed') useFeed = true;
  else if (args[i] === '--json') jsonOutput = true;
  else if (args[i] === '--status') status = args[++i];
}

const host = useFeed ? process.env.METRICS_SEARCH_HOST : process.env.SEARCH_HOST;
const apiKey = useFeed ? process.env.METRICS_SEARCH_API_KEY : process.env.SEARCH_API_KEY;

if (!host || !apiKey) {
  console.error(`Error: ${useFeed ? 'METRICS_SEARCH_HOST/METRICS_SEARCH_API_KEY' : 'SEARCH_HOST/SEARCH_API_KEY'} not configured`);
  process.exit(1);
}

async function request(path) {
  const res = await fetch(`${host}${path}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllTasks() {
  const tasks = [];
  let from = null;
  const batchSize = 100;

  while (true) {
    let path = `/tasks?statuses=${status}&limit=${batchSize}`;
    if (from !== null) path += `&from=${from}`;
    const data = await request(path);
    tasks.push(...data.results);
    process.stderr.write(`\rFetched ${tasks.length} / ${data.total} tasks...`);
    if (data.next == null || data.results.length === 0) break;
    from = data.next;
  }
  process.stderr.write('\n');
  return tasks;
}

function toMinuteKey(isoDate) {
  return isoDate.slice(0, 16); // "2026-02-17T20:54"
}

async function main() {
  const label = useFeed ? 'Feed/Metrics' : 'Main';
  console.error(`Using: ${label} Search (${host})\n`);

  const tasks = await fetchAllTasks();
  if (tasks.length === 0) {
    console.log(`No ${status} tasks found.`);
    return;
  }

  // Group by minute
  const byMinute = new Map();
  const allTypes = new Set();

  for (const t of tasks) {
    const minute = toMinuteKey(t.enqueuedAt);
    if (!byMinute.has(minute)) byMinute.set(minute, {});
    const bucket = byMinute.get(minute);
    const type = t.type;
    allTypes.add(type);
    bucket[type] = (bucket[type] || 0) + 1;
  }

  // Sort minutes chronologically
  const minutes = [...byMinute.keys()].sort();
  const types = [...allTypes].sort();

  if (jsonOutput) {
    const result = minutes.map(m => ({ minute: m, total: Object.values(byMinute.get(m)).reduce((a, b) => a + b, 0), ...byMinute.get(m) }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Table header
  const typeHeaders = types.map(t => t.replace('documentAdditionOrUpdate', 'add/update').replace('documentDeletion', 'deletion'));
  console.log(`${'Minute'.padEnd(18)} ${'Total'.padStart(6)} ${typeHeaders.map(h => h.padStart(12)).join(' ')}`);
  console.log('─'.repeat(18 + 7 + types.length * 13));

  let grandTotal = 0;
  const typeTotals = {};
  for (const t of types) typeTotals[t] = 0;

  for (const minute of minutes) {
    const bucket = byMinute.get(minute);
    const total = Object.values(bucket).reduce((a, b) => a + b, 0);
    grandTotal += total;
    const cols = types.map(t => {
      const count = bucket[t] || 0;
      typeTotals[t] += count;
      return String(count).padStart(12);
    });
    console.log(`${minute.padEnd(18)} ${String(total).padStart(6)} ${cols.join(' ')}`);
  }

  console.log('─'.repeat(18 + 7 + types.length * 13));
  const totalCols = types.map(t => String(typeTotals[t]).padStart(12));
  console.log(`${'TOTAL'.padEnd(18)} ${String(grandTotal).padStart(6)} ${totalCols.join(' ')}`);
  console.log(`\nSpan: ${minutes[0]} → ${minutes[minutes.length - 1]} (${minutes.length} minutes)`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
