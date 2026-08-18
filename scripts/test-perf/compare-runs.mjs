#!/usr/bin/env node
/**
 * Joins two runs' per-file timings and splits them into files a change SHOULD have touched and
 * files it should not, because that split is the only thing that separates a config win from box
 * drift. An aggregate delta between two runs taken at different times is unreadable on this box —
 * ambient load swings wall clock by up to ~68%.
 *
 * The control group is reported FIRST, deliberately. If the files a change cannot possibly have
 * touched moved anyway, the run pair is contaminated and the headline is not yours — and reading
 * that after the headline is how a drift gets published as a win.
 *
 *   node scripts/test-perf/compare-runs.mjs --before ctl --after treat --externals lodash-es,googleapis
 *
 * `--externals` names the packages the change targets; a file is "expected to move" when the
 * static inventory says its closure reaches at least one of them.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const load = (label) =>
  JSON.parse(readFileSync(path.join(repoRoot, `.test-perf/runs/${label}.perf.json`), 'utf8'));

const before = load(flag('before'));
const after = load(flag('after'));
const targets = (flag('externals', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const inventory = JSON.parse(
  readFileSync(path.join(repoRoot, '.test-perf/inventory.json'), 'utf8')
);
const reaches = new Map(
  inventory.files.map((f) => [f.file, targets.some((t) => f.externals.includes(t))])
);

const index = (run) => new Map(run.files.map((f) => [f.file.replace(/\\/g, '/'), f]));
const b = index(before);
const a = index(after);

const tests = (f) => (f.passed ?? 0) + (f.failed ?? 0) + (f.skipped ?? 0);
const groups = { expected: [], control: [], unclassified: [] };
for (const [file, bf] of b) {
  const af = a.get(file);
  if (!af) continue;
  const known = reaches.get(file);
  const group = known === undefined ? 'unclassified' : known ? 'expected' : 'control';
  groups[group].push({ file, before: bf, after: af });
}

const report = (name, rows) => {
  if (!rows.length) return console.log(`${name.padEnd(14)} (none)`);
  const sum = (rows, side, key) => rows.reduce((s, r) => s + (r[side][key] ?? 0), 0);
  const cb = sum(rows, 'before', 'collect');
  const ca = sum(rows, 'after', 'collect');
  const db = sum(rows, 'before', 'duration');
  const da = sum(rows, 'after', 'duration');
  const pct = (x, y) => (y === 0 ? 'n/a' : `${(((y - x) / x) * 100).toFixed(1)}%`);
  console.log(
    `${name.padEnd(14)} ${String(rows.length).padStart(4)} files   ` +
      `collect ${(cb / 1000).toFixed(0)}s -> ${(ca / 1000).toFixed(0)}s (${pct(cb, ca)})   ` +
      `duration ${(db / 1000).toFixed(0)}s -> ${(da / 1000).toFixed(0)}s (${pct(db, da)})`
  );
};

console.log(`before: ${before.label}   after: ${after.label}   targets: ${targets.join(', ')}\n`);
console.log('CONTROL GROUP FIRST — if this moved, the headline below is drift, not the change.\n');
report('control', groups.control);
report('expected', groups.expected);
report('unclassified', groups.unclassified);

const total = (run) => ({
  files: run.files.length,
  tests: run.files.reduce((s, f) => s + tests(f), 0),
  failed: run.files.reduce((s, f) => s + (f.failed ?? 0), 0),
  zero: run.files.filter((f) => tests(f) === 0).length,
});
const tb = total(before);
const ta = total(after);
console.log(
  `\ntotals   before ${tb.files} files ${tb.tests} tests ${tb.failed} failed ${tb.zero} zero-test` +
    `\n         after  ${ta.files} files ${ta.tests} tests ${ta.failed} failed ${ta.zero} zero-test`
);

const failedFiles = (run) => new Set(run.files.filter((f) => (f.failed ?? 0) > 0).map((f) => f.file));
const fb = failedFiles(before);
const fa = failedFiles(after);
const appeared = [...fa].filter((f) => !fb.has(f));
const cleared = [...fb].filter((f) => !fa.has(f));
if (appeared.length || cleared.length) {
  console.log('\nFAILURE SET CHANGED — a change that alters behaviour is not a change that alters timing:');
  appeared.forEach((f) => console.log(`  + ${f}`));
  cleared.forEach((f) => console.log(`  - ${f}`));
} else {
  console.log('\nfailure set unchanged');
}
