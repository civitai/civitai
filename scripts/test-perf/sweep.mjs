#!/usr/bin/env node
/**
 * Runs the fixed subset across a matrix of pool / isolation / worker-count settings.
 *
 * Sequentially and in one process, so the runs sit next to each other in time — wall clock on this
 * box swings up to ~68% with ambient load, and two numbers measured hours apart are not comparable.
 * Each config is also run twice by default and the FASTER run kept, because contention only ever
 * makes a run slower.
 *
 *   node scripts/test-perf/sweep.mjs --workers 4,16 --repeat 2
 */
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};

const workerCounts = flag('workers', '4,16').split(',');
const repeat = Number(flag('repeat', '2'));
const pools = flag('pools', 'forks,threads,vmThreads').split(',');
const isolations = flag('isolate', 'true,false').split(',');

const results = [];
for (const workers of workerCounts) {
  for (const pool of pools) {
    for (const iso of isolations) {
      const label = `sweep-${pool}-${iso === 'true' ? 'iso' : 'noiso'}-w${workers}`;
      let best = null;
      for (let i = 0; i < repeat; i++) {
        const args = [
          path.join(repoRoot, 'scripts/test-perf/bench.mjs'),
          '--label',
          label,
          '--workers',
          workers,
          `--pool=${pool}`,
        ];
        if (iso === 'false') args.push('--no-isolate');
        const started = Date.now();
        const r = spawnSync(process.execPath, args, {
          cwd: repoRoot,
          stdio: ['ignore', 'ignore', 'inherit'],
        });
        const wall = (Date.now() - started) / 1000;
        let perf = null;
        const p = path.join(repoRoot, `.test-perf/runs/${label}.perf.json`);
        if (existsSync(p)) {
          try {
            perf = JSON.parse(readFileSync(p, 'utf8'));
          } catch {}
        }
        const row = {
          label,
          pool,
          isolate: iso === 'true',
          workers: Number(workers),
          attempt: i + 1,
          wallS: +wall.toFixed(1),
          exit: r.status,
          collectS: perf ? +(perf.totals.collectMs / 1000).toFixed(1) : null,
          setupS: perf ? +(perf.totals.setupMs / 1000).toFixed(1) : null,
          testS: perf ? +(perf.totals.testMs / 1000).toFixed(1) : null,
          failed: perf ? perf.totals.failed : null,
          files: perf ? perf.totals.files : null,
        };
        console.log(
          `${label} #${i + 1}: wall ${row.wallS}s collect ${row.collectS}s failed ${row.failed} exit ${row.exit}`
        );
        if (!best || row.wallS < best.wallS) best = row;
      }
      results.push(best);
    }
  }
}

results.sort((a, b) => a.wallS - b.wallS);
writeFileSync(path.join(repoRoot, '.test-perf/sweep.json'), JSON.stringify(results, null, 2));
console.log('\n=== sweep, fastest first (90-file subset) ===');
console.log('wall   collect  setup  tests  failed  config');
for (const r of results) {
  console.log(
    `${String(r.wallS).padStart(6)} ${String(r.collectS).padStart(8)} ${String(r.setupS).padStart(6)} ${String(
      r.testS
    ).padStart(6)} ${String(r.failed).padStart(7)}  ${r.pool} ${r.isolate ? 'isolate' : 'no-isolate'} w${r.workers}`
  );
}
