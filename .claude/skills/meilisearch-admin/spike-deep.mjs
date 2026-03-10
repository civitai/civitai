#!/usr/bin/env node
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

const host = process.env.METRICS_SEARCH_HOST;
const apiKey = process.env.METRICS_SEARCH_API_KEY;

async function req(path) {
  const res = await fetch(`${host}${path}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
  return res.json();
}

async function main() {
  // Fetch all tasks that were enqueued between 15:00 and 17:00 UTC (wide window around the spike)
  // These should all be succeeded by now
  console.log('Fetching tasks enqueued 15:00-17:00 UTC...\n');

  const allTasks = [];
  let from = null;
  while (true) {
    let path = `/tasks?afterEnqueuedAt=2026-02-17T15:00:00Z&beforeEnqueuedAt=2026-02-17T17:00:00Z&limit=100`;
    if (from !== null) path += `&from=${from}`;
    const data = await req(path);
    allTasks.push(...data.results);
    process.stderr.write(`\rFetched ${allTasks.length} / ${data.total}...`);
    if (data.next == null || data.results.length === 0) break;
    from = data.next;
  }
  process.stderr.write('\n\n');

  // Group by batchUid
  const batches = new Map();
  for (const t of allTasks) {
    const bid = t.batchUid;
    if (bid == null) continue;
    if (!batches.has(bid)) batches.set(bid, []);
    batches.get(bid).push(t);
  }

  console.log(`Total tasks: ${allTasks.length}, Batches: ${batches.size}\n`);

  // For each batch, summarize
  console.log(
    'Batch'.padEnd(8),
    'Tasks'.padStart(6),
    'Adds'.padStart(6),
    'DelFlt'.padStart(7),
    'DelIds'.padStart(7),
    'AddDocs'.padStart(8),
    'Duration'.padStart(10),
    '  Enq(first)          Started              Finished             Status'
  );
  console.log('-'.repeat(140));

  const sortedBatches = [...batches.entries()].sort((a, b) => a[0] - b[0]);

  for (const [bid, tasks] of sortedBatches) {
    let adds = 0, delFilter = 0, delIds = 0, addDocs = 0;
    for (const t of tasks) {
      if (t.type === 'documentAdditionOrUpdate') {
        adds++;
        addDocs += t.details.receivedDocuments || 0;
      } else if (t.type === 'documentDeletion') {
        if (t.details.originalFilter) delFilter++;
        else delIds++;
      }
    }

    const first = tasks.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt))[0];
    const started = first.startedAt || '-';
    const finished = first.finishedAt || '-';
    const status = first.status;

    let durStr = '-';
    if (first.duration) {
      const m = first.duration.match(/PT(\d+\.?\d*)S/);
      if (m) {
        const sec = parseFloat(m[1]);
        durStr = sec >= 60 ? (sec / 60).toFixed(1) + 'm' : sec.toFixed(1) + 's';
      }
    }

    console.log(
      String(bid).padEnd(8),
      String(tasks.length).padStart(6),
      String(adds).padStart(6),
      String(delFilter).padStart(7),
      String(delIds).padStart(7),
      String(addDocs).padStart(8),
      durStr.padStart(10),
      ' ', (first.enqueuedAt || '').slice(0, 19),
      ' ', (started).slice(0, 19),
      ' ', (finished).slice(0, 19),
      ' ', status
    );
  }

  // Show the timeline: when did the queue start falling behind?
  console.log('\n\n=== Queue Lag Analysis ===\n');
  console.log('For each batch: time from enqueue to start (wait time)\n');
  console.log('Batch'.padEnd(8), 'Tasks'.padStart(6), 'Type'.padEnd(12), 'Enqueued'.padEnd(22), 'Started'.padEnd(22), 'Wait'.padStart(10), 'Duration'.padStart(10));
  console.log('-'.repeat(100));

  for (const [bid, tasks] of sortedBatches) {
    const first = tasks.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt))[0];
    if (!first.startedAt) continue;

    const enqTime = new Date(first.enqueuedAt).getTime();
    const startTime = new Date(first.startedAt).getTime();
    const waitMs = startTime - enqTime;
    const waitMin = (waitMs / 60000).toFixed(1);

    let adds = 0, dels = 0;
    for (const t of tasks) {
      if (t.type === 'documentAdditionOrUpdate') adds++;
      else dels++;
    }
    const typeStr = adds > 0 && dels > 0 ? `${adds}A+${dels}D` : adds > 0 ? `${adds} adds` : `${dels} dels`;

    let durStr = '-';
    if (first.duration) {
      const m = first.duration.match(/PT(\d+\.?\d*)S/);
      if (m) {
        const sec = parseFloat(m[1]);
        durStr = sec >= 60 ? (sec / 60).toFixed(1) + 'm' : sec.toFixed(1) + 's';
      }
    }

    console.log(
      String(bid).padEnd(8),
      String(tasks.length).padStart(6),
      typeStr.padEnd(12),
      first.enqueuedAt.slice(11, 19).padEnd(22),
      first.startedAt.slice(11, 19).padEnd(22),
      (waitMin + 'm').padStart(10),
      durStr.padStart(10)
    );
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
