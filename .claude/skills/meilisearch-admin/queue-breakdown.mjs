#!/usr/bin/env node

/**
 * Meilisearch Queue Breakdown
 *
 * Categorizes enqueued tasks by type and shows what's clogging the queue.
 *
 * Usage:
 *   node .claude/skills/meilisearch-admin/queue-breakdown.mjs [--feed] [--json]
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

for (const p of [resolve(__dirname, '.env'), resolve(projectRoot, '.env')]) {
  try {
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq);
      if (!process.env[k]) process.env[k] = t.slice(eq + 1);
    }
  } catch {}
}

const args = process.argv.slice(2);
const useFeed = args.includes('--feed');
const jsonOutput = args.includes('--json');

const host = useFeed ? process.env.METRICS_SEARCH_HOST : process.env.SEARCH_HOST;
const apiKey = useFeed ? process.env.METRICS_SEARCH_API_KEY : process.env.SEARCH_API_KEY;

async function req(path) {
  const res = await fetch(`${host}${path}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
  return res.json();
}

async function fetchAll() {
  const tasks = [];
  let from = null;
  while (true) {
    let path = `/tasks?statuses=enqueued&limit=100`;
    if (from !== null) path += `&from=${from}`;
    const data = await req(path);
    tasks.push(...data.results);
    process.stderr.write(`\rFetched ${tasks.length} / ${data.total}...`);
    if (data.next == null || data.results.length === 0) break;
    from = data.next;
  }
  process.stderr.write('\n');
  return tasks;
}

function categorize(t) {
  if (t.type === 'documentAdditionOrUpdate') {
    return { category: 'add/update', docs: t.details.receivedDocuments || 0 };
  }
  if (t.type === 'documentDeletion') {
    if (t.details.originalFilter) {
      return { category: 'delete-by-filter', filter: t.details.originalFilter, docs: 0 };
    }
    return { category: 'delete-by-ids', docs: t.details.providedIds || 0 };
  }
  if (t.type === 'settingsUpdate') return { category: 'settings-update', docs: 0 };
  if (t.type === 'indexCreation') return { category: 'index-creation', docs: 0 };
  return { category: t.type, docs: 0 };
}

async function main() {
  const label = useFeed ? 'Feed/Metrics' : 'Main';
  console.log(`Using: ${label} Search (${host})\n`);

  const tasks = await fetchAll();
  if (tasks.length === 0) {
    console.log('No enqueued tasks.');
    return;
  }

  // Categorize
  const cats = {};
  const filters = {};
  let totalAddDocs = 0;
  let totalDelIds = 0;

  for (const t of tasks) {
    const c = categorize(t);
    if (!cats[c.category]) cats[c.category] = { count: 0, docs: 0 };
    cats[c.category].count++;
    cats[c.category].docs += c.docs;

    if (c.category === 'add/update') totalAddDocs += c.docs;
    if (c.category === 'delete-by-ids') totalDelIds += c.docs;
    if (c.filter) {
      // Extract filter pattern (e.g., "userId = X" -> "userId")
      const match = c.filter.match(/"(\w+)\s*=/);
      const key = match ? match[1] : c.filter;
      if (!filters[key]) filters[key] = 0;
      filters[key]++;
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ total: tasks.length, categories: cats, filterTypes: filters }, null, 2));
    return;
  }

  // Summary
  console.log('=== Queue Breakdown ===\n');
  console.log('Category'.padEnd(20), 'Count'.padStart(8), 'Docs/IDs'.padStart(10));
  console.log('-'.repeat(40));
  for (const [cat, data] of Object.entries(cats).sort((a, b) => b[1].count - a[1].count)) {
    console.log(cat.padEnd(20), String(data.count).padStart(8), String(data.docs).padStart(10));
  }
  console.log('-'.repeat(40));
  console.log('TOTAL'.padEnd(20), String(tasks.length).padStart(8));

  // Filter breakdown
  if (Object.keys(filters).length > 0) {
    console.log('\n=== Delete-by-Filter Breakdown ===\n');
    console.log('Filter field'.padEnd(20), 'Count'.padStart(8));
    console.log('-'.repeat(30));
    for (const [key, count] of Object.entries(filters).sort((a, b) => b - a)) {
      console.log(key.padEnd(20), String(count).padStart(8));
    }
  }

  // Add/update doc size distribution
  const addTasks = tasks.filter(t => t.type === 'documentAdditionOrUpdate');
  if (addTasks.length > 0) {
    const docs = addTasks.map(t => t.details.receivedDocuments || 0).sort((a, b) => a - b);
    console.log('\n=== Add/Update Doc Distribution ===\n');
    console.log(`  Count:   ${addTasks.length} tasks`);
    console.log(`  Total:   ${totalAddDocs.toLocaleString()} docs`);
    console.log(`  Min:     ${docs[0]}`);
    console.log(`  Median:  ${docs[Math.floor(docs.length / 2)]}`);
    console.log(`  Max:     ${docs[docs.length - 1]}`);
    console.log(`  Avg:     ${Math.round(totalAddDocs / addTasks.length)}`);

    // Histogram
    const buckets = [0, 50, 100, 200, 300, 500, 1000, Infinity];
    console.log('\n  Size distribution:');
    for (let i = 0; i < buckets.length - 1; i++) {
      const lo = buckets[i];
      const hi = buckets[i + 1];
      const count = docs.filter(d => d >= lo && d < hi).length;
      const bar = '#'.repeat(Math.ceil(count / Math.max(1, addTasks.length) * 40));
      const label = hi === Infinity ? `${lo}+` : `${lo}-${hi - 1}`;
      console.log(`    ${label.padEnd(10)} ${String(count).padStart(5)}  ${bar}`);
    }
  }

  // Delete-by-ids distribution
  const delIdTasks = tasks.filter(t => t.type === 'documentDeletion' && !t.details.originalFilter);
  if (delIdTasks.length > 0) {
    const ids = delIdTasks.map(t => t.details.providedIds || 0).sort((a, b) => a - b);
    console.log('\n=== Delete-by-IDs Distribution ===\n');
    console.log(`  Count:   ${delIdTasks.length} tasks`);
    console.log(`  Total:   ${totalDelIds.toLocaleString()} IDs`);
    console.log(`  Min:     ${ids[0]}`);
    console.log(`  Median:  ${ids[Math.floor(ids.length / 2)]}`);
    console.log(`  Max:     ${ids[ids.length - 1]}`);
  }

  // Timeline: how the categories distribute over time
  console.log('\n=== Category Timeline (per 10 min) ===\n');
  const byWindow = {};
  for (const t of tasks) {
    const c = categorize(t);
    // Round to 10-min window
    const dt = t.enqueuedAt.slice(0, 15) + '0';
    if (!byWindow[dt]) byWindow[dt] = {};
    if (!byWindow[dt][c.category]) byWindow[dt][c.category] = 0;
    byWindow[dt][c.category]++;
  }

  const allCats = Object.keys(cats).sort();
  const catHeaders = allCats.map(c => c.slice(0, 10));
  console.log('Window'.padEnd(18), ...catHeaders.map(h => h.padStart(12)));
  console.log('-'.repeat(18 + allCats.length * 13));

  for (const win of Object.keys(byWindow).sort()) {
    const row = byWindow[win];
    const cols = allCats.map(c => String(row[c] || 0).padStart(12));
    console.log(win.padEnd(18), ...cols);
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
