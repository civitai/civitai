#!/usr/bin/env node
/**
 * Rebuilds scripts/test-shard/unit-timings.json from the per-file timings CI records.
 *
 * Every `Unit tests` shard uploads `.test-perf/runs/unit-shard-<n>.perf.json` (written by
 * scripts/test-perf/reporter.mjs) as its `unit-perf-<n>` artifact (~0.2 MB, kept 14 days). Download
 * those of several green runs (each run's shards land on different runners, which is what lets the
 * runner speed be divided out) and point this at them:
 *
 *   gh run download <run-id> -R civitai/civitai -p 'unit-perf-*' -D /tmp/unit-timings/<run-id>
 *   node scripts/test-shard/update-timings.mjs /tmp/unit-timings
 *
 * A file's cost is its worker time — environment + prepare + import/collect + setup + tests — the
 * MEDIAN across the runs given, after dividing out each runner's speed (see buildTimings). Give it
 * several runs: a file measured once carries its one runner's error. The JSON reporter's own per-file times are NOT usable for this:
 * they span only the test bodies, and import is most of this suite's cost.
 *
 * Staleness is safe, not silent: a file missing from the table is dealt round-robin (assign.mjs),
 * so an old table costs balance, never coverage. Refresh when the shard durations drift apart.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { TIMINGS_PATH } from './sequencer.mjs';

export const fileCost = (f) =>
  (f.env || 0) + (f.prepare || 0) + (f.collect || 0) + (f.setup || 0) + (f.duration || 0);

function findPerfFiles(p, out = []) {
  if (statSync(p).isDirectory()) {
    for (const name of readdirSync(p)) findPerfFiles(path.join(p, name), out);
  } else if (p.endsWith('.perf.json')) out.push(p);
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Each perf.json comes from ONE runner, and runners differ in speed: within a single run, the same
 * files cost 0.77x on one shard's runner and 1.27x on another's (Lint run 44092626209, 8 shards,
 * median over each shard's heavy files). Taken raw, a file inherits the speed of whichever runners
 * happened to measure it, and every file that shared a shard shares that error — which is exactly
 * the error a shard split cannot afford.
 *
 * So each perf.json gets a speed factor: the median, over its files, of (its cost / the file's
 * consensus cost). Costs are divided by their run's factor and the consensus is re-taken, a few
 * rounds. Factors are normalised to a median of 1, so the table stays in real seconds. With a
 * single perf.json there is nothing to compare against and the factor is 1.
 *
 * @param {Array<{files: Array<object>}>} perfs  parsed perf.json documents
 * @param {{ rounds?: number }} [opts]
 * @returns {{ files: Record<string, number>, factors: number[] }}
 */
export function buildTimings(perfs, { rounds = 5 } = {}) {
  const runs = perfs.map((perf) =>
    (perf.files ?? []).filter((f) => typeof f.file === 'string').map((f) => [f.file, fileCost(f)])
  );
  const samplesWith = (factors) => {
    const samples = new Map();
    runs.forEach((run, r) => {
      for (const [file, cost] of run) {
        if (!samples.has(file)) samples.set(file, []);
        samples.get(file).push(cost / factors[r]);
      }
    });
    return samples;
  };
  // The consensus used to ESTIMATE factors is a geometric mean, not a median: with two or three
  // samples per file the median IS one run's own sample, so that run's ratios come out exactly 1
  // for most of its files and its factor sticks at 1.00 whatever its speed.
  const geomean = (xs) => Math.exp(xs.reduce((a, x) => a + Math.log(Math.max(x, 1)), 0) / xs.length);

  let factors = runs.map(() => 1);
  for (let round = 0; round < rounds && runs.length > 1; round++) {
    const consensus = new Map([...samplesWith(factors)].map(([file, xs]) => [file, geomean(xs)]));
    const raw = runs.map((run) => {
      const ratios = run
        .filter(([file, cost]) => cost > 0 && consensus.get(file) > 0)
        .map(([file, cost]) => cost / consensus.get(file));
      return ratios.length ? median(ratios) : 1;
    });
    const mid = median(raw);
    factors = raw.map((x) => x / mid);
  }
  const files = {};
  const final = samplesWith(factors);
  for (const key of [...final.keys()].sort()) files[key] = Math.round(median(final.get(key)));
  return { files, factors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error('usage: update-timings.mjs <dir-or-perf.json>...');
    process.exit(2);
  }
  const paths = inputs.flatMap((p) => findPerfFiles(p));
  if (paths.length === 0) {
    console.error(`no *.perf.json under ${inputs.join(', ')} — nothing to build from.`);
    process.exit(1);
  }
  const perfs = paths.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const { files, factors } = buildTimings(perfs);
  const n = Object.keys(files).length;
  console.log(
    `runner speed factors: ${paths.map((p, i) => `${path.basename(path.dirname(path.dirname(path.dirname(p))))}=${factors[i].toFixed(2)}`).join(' ')}`
  );
  writeFileSync(
    TIMINGS_PATH,
    JSON.stringify(
      {
        comment:
          'Per-file unit-suite worker time in ms, median over CI runs. Generated by scripts/test-shard/update-timings.mjs; do not hand-edit.',
        generatedAt: new Date().toISOString().slice(0, 10),
        perfFiles: paths.length,
        files,
      },
      null,
      1
    ) + '\n'
  );
  console.log(`wrote ${n} file costs from ${paths.length} perf.json file(s) to ${TIMINGS_PATH}`);
}
