#!/usr/bin/env node
/**
 * Which test files kill a thread-based vitest pool?
 *
 * `sharp` 0.32.6's addon is not context-aware, so a worker_thread that has executed a libvips
 * operation segfaults when the thread is torn down — after the tests pass and the summary prints.
 * That kills the whole run under `threads` / `vmThreads`, so the pool can only be adopted if the
 * offending files are routed to a process-based pool.
 *
 * Importing sharp is safe; only executing an operation is fatal, so the static graph
 * (`externals.includes('sharp')`, 100 files) is an over-approximation. This runs each candidate
 * alone and records the exit code, which is the only way to get the real set.
 *
 *   node scripts/test-perf/scan-native-crash.mjs --pool threads
 *   node scripts/test-perf/scan-native-crash.mjs --pool threads --files a.test.ts,b.test.ts
 *
 * Writes .test-perf/native-crash.<pool>.json. Resumable: re-running skips files already recorded
 * unless --fresh is passed.
 */
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const pool = flag('pool', 'threads');
const marker = flag('marker', 'sharp');
const out = path.join(repoRoot, `.test-perf/native-crash.${pool}.json`);

let candidates = flag('files', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!candidates.length) {
  const inv = JSON.parse(readFileSync(path.join(repoRoot, '.test-perf/inventory.json'), 'utf8'));
  candidates = inv.files.filter((f) => f.externals.includes(marker)).map((f) => f.file);
}

const prior = !argv.includes('--fresh') && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { pool, results: {} };
const results = prior.results ?? {};

const bin = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
let done = 0;
for (const file of candidates) {
  done++;
  if (results[file] !== undefined) continue;
  const started = Date.now();
  const res = spawnSync(process.execPath, [bin, 'run', '--project', 'unit', `--pool=${pool}`, '--max-workers=1', file], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const stdout = res.stdout ?? '';
  // A segfault takes the process down after the summary has already printed, so "did the tests
  // pass" and "did the process survive" are independent and both worth recording.
  const passed = /Test Files\s+\d+ passed/.test(stdout);
  results[file] = {
    status: res.status,
    signal: res.signal ?? null,
    crashed: res.status !== 0 && res.status !== 1,
    testsPassed: passed,
    ms: Date.now() - started,
  };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ pool, marker, results }, null, 2));
  const r = results[file];
  console.log(
    `[${done}/${candidates.length}] ${r.crashed ? 'CRASH' : r.status === 0 ? 'ok   ' : 'fail '} ` +
      `status=${r.status} passed=${r.testsPassed} ${(r.ms / 1000).toFixed(1)}s  ${file}`
  );
}

const crashed = Object.entries(results).filter(([, r]) => r.crashed);
console.log(`\n${crashed.length} of ${Object.keys(results).length} files crash the ${pool} pool`);
for (const [f] of crashed) console.log(`  ${f}`);
console.log(`\nwrote ${path.relative(repoRoot, out)}`);
