#!/usr/bin/env node
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

// Load env
for (const envPath of [resolve(__dirname, '.env'), resolve(projectRoot, '.env')]) {
  try {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1);
    }
  } catch {}
}

const host = process.env.METRICS_SEARCH_HOST;
const apiKey = process.env.METRICS_SEARCH_API_KEY;

async function req(path) {
  const res = await fetch(`${host}${path}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
  return res.json();
}

async function main() {
  console.log('=== Finding the spike around 16:30 UTC ===\n');

  // Step 1: Narrow the window
  const windows = [
    ['15:00', '18:00'],
    ['16:00', '17:00'],
    ['16:15', '16:45'],
    ['16:25', '16:35'],
    ['16:28', '16:32'],
  ];

  for (const [start, end] of windows) {
    const d = await req(`/tasks?afterEnqueuedAt=2026-02-17T${start}:00Z&beforeEnqueuedAt=2026-02-17T${end}:00Z&limit=0`);
    console.log(`${start}-${end} UTC: ${d.total} tasks`);
  }

  // Step 2: Get per-minute breakdown for 16:00-17:50 (to cover the spike and runup to current queue)
  console.log('\n=== Per-minute breakdown 16:00-17:50 UTC ===\n');

  const allTasks = [];
  let from = null;
  while (true) {
    let path = `/tasks?afterEnqueuedAt=2026-02-17T16:00:00Z&beforeEnqueuedAt=2026-02-17T17:50:00Z&limit=100`;
    if (from !== null) path += `&from=${from}`;
    const data = await req(path);
    allTasks.push(...data.results);
    process.stderr.write(`\rFetched ${allTasks.length} / ${data.total}...`);
    if (data.next == null || data.results.length === 0) break;
    from = data.next;
  }
  process.stderr.write('\n');

  // Group by minute
  const byMinute = {};
  for (const t of allTasks) {
    const min = t.enqueuedAt.slice(0, 16);
    if (!byMinute[min]) byMinute[min] = { add: 0, del: 0, delFilter: 0, delIds: 0, other: 0, total: 0, statuses: {} };
    const b = byMinute[min];
    b.total++;
    b.statuses[t.status] = (b.statuses[t.status] || 0) + 1;

    if (t.type === 'documentAdditionOrUpdate') {
      b.add++;
    } else if (t.type === 'documentDeletion') {
      b.del++;
      if (t.details.originalFilter) b.delFilter++;
      else b.delIds++;
    } else {
      b.other++;
    }
  }

  console.log('Minute'.padEnd(18), 'Total'.padStart(6), 'add'.padStart(6), 'del-flt'.padStart(8), 'del-ids'.padStart(8), 'other'.padStart(6), '  statuses');
  console.log('-'.repeat(80));

  for (const min of Object.keys(byMinute).sort()) {
    const b = byMinute[min];
    const statStr = Object.entries(b.statuses).map(([s, c]) => `${s}:${c}`).join(' ');
    console.log(
      min.padEnd(18),
      String(b.total).padStart(6),
      String(b.add).padStart(6),
      String(b.delFilter).padStart(8),
      String(b.delIds).padStart(8),
      String(b.other).padStart(6),
      ' ', statStr
    );
  }

  // Step 3: Zoom into the spike minute(s) and show individual tasks
  console.log('\n=== Sample tasks from spike (16:28-16:32 UTC) ===\n');
  const spikeTasks = allTasks
    .filter(t => t.enqueuedAt >= '2026-02-17T16:28:00Z' && t.enqueuedAt < '2026-02-17T16:32:00Z')
    .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));

  for (const t of spikeTasks.slice(0, 50)) {
    const type = t.type === 'documentAdditionOrUpdate' ? 'ADD' : t.type === 'documentDeletion' ? 'DEL' : t.type;
    let detail = '';
    if (t.type === 'documentAdditionOrUpdate') {
      detail = `${t.details.receivedDocuments} docs`;
      if (t.details.indexedDocuments != null) detail += ` (indexed: ${t.details.indexedDocuments})`;
    } else if (t.type === 'documentDeletion') {
      if (t.details.originalFilter) {
        detail = t.details.originalFilter;
        if (t.details.deletedDocuments != null) detail += ` (deleted: ${t.details.deletedDocuments})`;
      } else {
        detail = `${t.details.providedIds} ids`;
        if (t.details.deletedDocuments != null) detail += ` (deleted: ${t.details.deletedDocuments})`;
      }
    }
    console.log(`[${t.uid}] ${t.status.padEnd(10)} ${type.padEnd(4)} ${t.enqueuedAt.slice(11, 19)}  ${detail}`);
  }

  if (spikeTasks.length > 50) {
    console.log(`... and ${spikeTasks.length - 50} more`);
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
