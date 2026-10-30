/**
 * Records every native addon (.node) the unit suite loads, and which test file loaded it.
 *
 * `sharp` was found by suspicion; this finds the rest without needing one. It hooks
 * `process.dlopen`, which every native binding goes through however it is required — so it
 * cannot be dodged by a template-literal `require`, a lazy `await import()`, or a dependency
 * nobody thought to check.
 *
 * 🔴 A load is a CANDIDATE, not a crasher. Importing sharp is harmless; only executing a libvips
 * op arms the teardown segfault. So the output of this is the list worth testing one file at a
 * time under a thread pool, not a list of things that are broken.
 *
 * Added as an extra setupFile by scripts/test-perf/native-addon-probe-config.mts.
 */
import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { expect } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const out = path.join(repoRoot, '.test-perf/native-addons.jsonl');
mkdirSync(path.dirname(out), { recursive: true });

const original = process.dlopen.bind(process);
process.dlopen = function (module: unknown, filename: string, ...rest: unknown[]) {
  let testPath = '<outside-test>';
  try {
    testPath = expect.getState().testPath ?? '<no-test-path>';
  } catch {
    /* loaded outside a test context — still worth recording */
  }
  appendFileSync(out, JSON.stringify({ testPath, addon: filename }) + '\n');
  return (original as (...args: unknown[]) => unknown)(module, filename, ...rest);
} as typeof process.dlopen;
