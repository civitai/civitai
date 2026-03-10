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

const useFeed = process.argv.includes('--feed');
const host = useFeed ? process.env.METRICS_SEARCH_HOST : process.env.SEARCH_HOST;
const apiKey = useFeed ? process.env.METRICS_SEARCH_API_KEY : process.env.SEARCH_API_KEY;

async function req(path) {
  const res = await fetch(`${host}${path}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
  return res.json();
}

async function main() {
  // Fetch last 200 succeeded tasks to analyze batch history
  const limit = parseInt(process.argv.find(a => a.match(/^\d+$/)) || '200');
  const allTasks = [];
  let from = null;
  while (allTasks.length < limit) {
    let path = `/tasks?statuses=succeeded&limit=${Math.min(100, limit - allTasks.length)}`;
    if (from !== null) path += `&from=${from}`;
    const data = await req(path);
    allTasks.push(...data.results);
    if (data.next == null || data.results.length === 0) break;
    from = data.next;
  }

  // Group by batchUid
  const batches = new Map();
  for (const t of allTasks) {
    const bid = t.batchUid;
    if (!batches.has(bid)) batches.set(bid, { tasks: [], startedAt: t.startedAt, finishedAt: t.finishedAt, duration: t.duration });
    batches.get(bid).tasks.push(t);
  }

  console.log(`Analyzed ${allTasks.length} succeeded tasks across ${batches.size} batches\n`);
  console.log(
    'Batch'.padEnd(8),
    'Tasks'.padStart(6),
    'Adds'.padStart(6),
    'Dels'.padStart(6),
    'Docs'.padStart(8),
    'Duration'.padStart(10),
    '  Started              Finished'
  );
  console.log('-'.repeat(100));

  for (const [bid, b] of [...batches.entries()].sort((a, b) => a[0] - b[0])) {
    let adds = 0, dels = 0, docs = 0, delDocs = 0;
    for (const t of b.tasks) {
      if (t.type === 'documentAdditionOrUpdate') {
        adds++;
        docs += t.details.receivedDocuments || 0;
      } else {
        dels++;
        delDocs += t.details.deletedDocuments || 0;
      }
    }

    let durStr = '-';
    const durMatch = b.duration ? b.duration.match(/PT(\d+\.?\d*)S/) : null;
    if (durMatch) {
      const sec = parseFloat(durMatch[1]);
      durStr = sec >= 60 ? (sec / 60).toFixed(1) + 'm' : sec.toFixed(1) + 's';
    }

    console.log(
      String(bid).padEnd(8),
      String(b.tasks.length).padStart(6),
      String(adds).padStart(6),
      String(dels).padStart(6),
      String(docs).padStart(8),
      durStr.padStart(10),
      ' ', b.startedAt.slice(0, 19),
      ' ', b.finishedAt.slice(0, 19)
    );
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
