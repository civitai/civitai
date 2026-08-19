#!/usr/bin/env node
/**
 * Computes a graph-affinity file order for the unit suite.
 *
 * Under `isolate: false` a worker builds ONE module registry and keeps it, so its cost is the union
 * of everything its files import — not the sum. Vitest hands files out from a shared queue, so with
 * N workers in flight the file ORDER decides how much those unions overlap. Run graph-similar files
 * next to each other and each worker loads a slice of the suite instead of all of it.
 *
 * Greedy nearest-neighbour on closure overlap. Not optimal — this is a queue-ordering heuristic, and
 * the thing it has to beat is alphabetical.
 *
 *   node scripts/test-perf/graph.mjs      # writes .test-perf/closures.json
 *   node scripts/test-perf/order.mjs      # writes .test-perf/file-order.json
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { modules, closures } = JSON.parse(
  readFileSync(path.join(repoRoot, '.test-perf/closures.json'), 'utf8')
);

const files = Object.keys(closures);
const sets = files.map((f) => new Set(closures[f]));
const sizes = sets.map((s) => s.size);

/** Modules already loaded by the notional worker, so cost is what a file ADDS, not what it holds. */
function added(set, loaded) {
  let n = 0;
  for (const m of set) if (!loaded.has(m)) n++;
  return n;
}

// Start from the largest closure: it pulls in the shared core, and everything after it is measured
// against what is already loaded, which is what a real worker experiences.
const remaining = new Set(files.map((_, i) => i));
let cur = sizes.indexOf(Math.max(...sizes));
const order = [cur];
remaining.delete(cur);
const loaded = new Set(sets[cur]);

while (remaining.size) {
  let best = -1;
  let bestAdded = Infinity;
  for (const i of remaining) {
    const a = added(sets[i], loaded);
    if (a < bestAdded) {
      bestAdded = a;
      best = i;
      if (a === 0) break; // nothing cheaper exists
    }
  }
  order.push(best);
  remaining.delete(best);
  for (const m of sets[best]) loaded.add(m);
}

const ordered = order.map((i) => files[i]);

// What the order is worth, stated the way the pool will experience it: split the sequence into W
// contiguous slices and measure each slice's union. This is optimistic (a real pool interleaves)
// but it is the right upper bound to check before spending a suite run on it.
function report(list, w) {
  const per = Math.ceil(list.length / w);
  let total = 0;
  for (let s = 0; s < w; s++) {
    const u = new Set();
    for (const f of list.slice(s * per, (s + 1) * per)) for (const m of closures[f]) u.add(m);
    total += u.size;
  }
  return Math.round(total / w);
}

const alpha = [...files].sort();
console.log(`union across the whole suite: ${modules.length} modules`);
console.log('mean per-worker union, contiguous slices:');
console.log('  workers   alphabetical   affinity');
for (const w of [4, 8, 16, 24, 31]) {
  console.log(`  ${String(w).padStart(7)}   ${String(report(alpha, w)).padStart(12)}   ${String(report(ordered, w)).padStart(8)}`);
}

writeFileSync(
  path.join(repoRoot, '.test-perf/file-order.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), order: ordered }, null, 0)
);
console.log(`\nwrote .test-perf/file-order.json (${ordered.length} files)`);
