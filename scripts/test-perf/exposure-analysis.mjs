#!/usr/bin/env node
/**
 * Does the measured effect track EXPOSURE to the change, or is it uniform?
 *
 * A uniform speedup across files with nothing in common is drift. A speedup that scales with how
 * much of a file's import cost the targeted packages account for is the change. The movers/non-movers
 * split answers this coarsely; this answers it by degree, which matters when the control group is
 * too cheap to carry a null (352 files holding 2.4% of collect cannot distinguish 8s of drift from
 * 8s of effect).
 *
 *   node scripts/test-perf/exposure-analysis.mjs --before pre-ctl --after pre-treat --externals a,b,c
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
const targets = flag('externals', '').split(',').map((s) => s.trim()).filter(Boolean);
const inventory = JSON.parse(readFileSync(path.join(repoRoot, '.test-perf/inventory.json'), 'utf8'));
const exposure = new Map(
  inventory.files.map((f) => [f.file, targets.filter((t) => f.externals.includes(t)).length])
);

const norm = (s) => s.split('\\').join('/');
const before = new Map(load(flag('before')).files.map((f) => [norm(f.file), f]));
const after = new Map(load(flag('after')).files.map((f) => [norm(f.file), f]));

const rows = [];
for (const [file, bf] of before) {
  const af = after.get(file);
  if (!af) continue;
  rows.push({ file, exposure: exposure.get(file) ?? 0, cb: bf.collect ?? 0, ca: af.collect ?? 0 });
}

const line = (label, group) => {
  const cb = group.reduce((s, r) => s + r.cb, 0);
  const ca = group.reduce((s, r) => s + r.ca, 0);
  const pct = cb === 0 ? 'n/a' : `${(((ca - cb) / cb) * 100).toFixed(1)}%`;
  console.log(
    `  ${label.padEnd(22)} files ${String(group.length).padStart(4)}   ` +
      `collect ${(cb / 1000).toFixed(0).padStart(5)}s -> ${(ca / 1000).toFixed(0).padStart(5)}s   ` +
      `${pct.padStart(7)}   mean/file ${(cb / group.length / 1000).toFixed(2)}s`
  );
};

console.log(`targets: ${targets.join(', ')}\n`);
console.log('BY EXPOSURE (how many of the targeted packages a file\'s closure reaches):');
const levels = [...new Set(rows.map((r) => r.exposure))].sort((a, b) => a - b);
for (const level of levels) line(`reaches ${level}`, rows.filter((r) => r.exposure === level));

// The control group's own percentage is suspect when its files are cheap: a fixed per-file cost
// dominates there, so a small absolute wobble reads as a large percentage. Split it by cost.
console.log('\nCONTROL GROUP (exposure 0) SPLIT BY PER-FILE COST:');
const control = rows.filter((r) => r.exposure === 0).sort((a, b) => b.cb - a.cb);
const mid = Math.floor(control.length / 2);
line('costlier half', control.slice(0, mid));
line('cheaper half', control.slice(mid));

console.log('\nEXPECTED GROUP SPLIT BY PER-FILE COST:');
const expected = rows.filter((r) => r.exposure > 0).sort((a, b) => b.cb - a.cb);
const emid = Math.floor(expected.length / 2);
line('costlier half', expected.slice(0, emid));
line('cheaper half', expected.slice(emid));
