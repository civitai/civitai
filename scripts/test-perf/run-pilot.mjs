#!/usr/bin/env node
/**
 * Run the shared-mock pilot file set at a given worker count and isolation mode, and
 * write the per-file timing/failure JSON under `.test-perf/runs/`.
 *
 *   node scripts/test-perf/run-pilot.mjs --label pilot-before-4 --workers 4 --no-isolate
 *
 * Separate from bench.mjs because the pilot set is a moving list (`.test-perf/pilot.txt`),
 * not the fixed yardstick subset — the two must not be compared with each other.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const label = flag('label', 'pilot');
const workers = flag('workers', '4');
const listPath = path.join(repoRoot, flag('list', '.test-perf/pilot.txt'));
const files = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

// Spawned as `node node_modules/vitest/vitest.mjs`, NOT through the `.bin` shim with
// `shell: true`. A few hundred file paths overrun cmd.exe's 8191-character command line
// ("The command line is too long."), and the failure is reported as a normal non-zero
// exit — it reads like a failing suite. Bypassing the shell raises the ceiling to
// CreateProcess's 32767.
const bin = process.execPath;
const args = [
  path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
  'run',
  '--project',
  'unit',
  `--max-workers=${workers}`,
  '--reporter=default',
  `--reporter=${path.join(repoRoot, 'scripts/test-perf/reporter.mjs').replace(/\\/g, '/')}`,
  ...argv.filter((a) => a === '--no-isolate'),
  ...files,
];

const started = Date.now();
const res = spawnSync(bin, args, {
  cwd: repoRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, TESTPERF_LABEL: label },
});
console.log(`\n[pilot] ${label} (${files.length} files) exited ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(res.status ?? 1);
