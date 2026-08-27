#!/usr/bin/env node
/** Merges the per-worker `.test-perf/trace/*.json` snapshots into a ranked report. */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Must honour the same override `trace-setup.ts` writes to, or exporting it puts the snapshots
// somewhere this tool then reports as "run a traced suite first" — the exact silent-zero this
// tooling exists to avoid.
const dir = process.env.TESTPERF_TRACE_DIR ?? path.join(repoRoot, '.test-perf/trace');
if (!existsSync(dir)) {
  console.error(`no ${dir} — run a traced suite first`);
  process.exit(2);
}

const merged = new Map();
let workers = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  workers++;
  const data = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  for (const [id, e] of Object.entries(data)) {
    const cur = merged.get(id) ?? { loads: 0, selfMs: 0, totalMs: 0 };
    cur.loads += e.loads;
    cur.selfMs += e.selfMs;
    cur.totalMs += e.totalMs;
    merged.set(id, cur);
  }
}

const rows = [...merged.entries()].map(([module, e]) => ({
  module,
  loads: e.loads,
  selfMs: Math.round(e.selfMs),
  totalMs: Math.round(e.totalMs),
  msPerLoad: +(e.selfMs / e.loads).toFixed(2),
}));

const totalSelf = rows.reduce((a, r) => a + r.selfMs, 0);
const totalLoads = rows.reduce((a, r) => a + r.loads, 0);

const out = {
  generatedAt: new Date().toISOString(),
  workers,
  distinctModules: rows.length,
  totalLoads,
  totalSelfMs: totalSelf,
  bySelfMs: [...rows].sort((a, b) => b.selfMs - a.selfMs).slice(0, 120),
  byLoads: [...rows].sort((a, b) => b.loads - a.loads).slice(0, 120),
  slowestPerLoad: [...rows].filter((r) => r.loads > 5).sort((a, b) => b.msPerLoad - a.msPerLoad).slice(0, 60),
  all: rows,
};

// `.test-perf/` is gitignored, and with TESTPERF_TRACE_DIR pointed elsewhere nothing else creates
// it — so on a fresh clone this write used to throw ENOENT after all the merging was done and
// before anything was printed, which reads as operator error rather than as a missing directory.
const reportPath = path.join(repoRoot, '.test-perf/trace.json');
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(out, null, 2));
console.log(`${workers} worker snapshots | ${rows.length} distinct modules | ${totalLoads.toLocaleString()} executions | ${(totalSelf / 1000).toFixed(0)}s self time`);
console.log('\nTop 25 by total self time (the cost of the module body itself, excluding its imports):');
for (const r of out.bySelfMs.slice(0, 25))
  console.log(`  ${String(Math.round(r.selfMs)).padStart(7)}ms  x${String(r.loads).padStart(5)}  ${r.msPerLoad.toFixed(2)}ms/load  ${r.module}`);
console.log('\nTop 25 by execution count (what isolation is making you re-run):');
for (const r of out.byLoads.slice(0, 25))
  console.log(`  x${String(r.loads).padStart(5)}  ${String(Math.round(r.selfMs)).padStart(7)}ms  ${r.module}`);
