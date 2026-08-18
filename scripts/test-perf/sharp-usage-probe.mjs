/**
 * Stands in for `sharp` so a run can record which TEST FILES actually execute a libvips
 * operation, as opposed to merely pulling sharp into their import graph. Only the former
 * segfaults a thread-based vitest pool, and the difference is 100 candidate files against
 * however many really use it.
 *
 * A crash-scan cannot answer this: the teardown segfault is a race, so a file that executes
 * sharp can still exit 0 and would be scored as clean.
 *
 * Aliased in by scripts/test-perf/sharp-probe-config.mts. Re-exports the real module, so the
 * run under it is a genuine run.
 */
import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { expect } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
// Resolved by path, not by specifier: the specifier is what we are standing in for.
const real = require(path.join(repoRoot, 'node_modules/sharp/lib/index.js'));

const out = path.join(repoRoot, '.test-perf/sharp-usage.jsonl');
mkdirSync(path.dirname(out), { recursive: true });

const record = (op) => {
  let testPath = '<unknown>';
  try {
    testPath = expect.getState().testPath ?? '<no-test-path>';
  } catch {
    testPath = '<outside-test>';
  }
  appendFileSync(out, JSON.stringify({ testPath, op }) + '\n');
};

const sharp = new Proxy(real, {
  apply(target, thisArg, args) {
    record('call');
    return Reflect.apply(target, thisArg, args);
  },
  get(target, prop, receiver) {
    // Static helpers (cache/concurrency/simd/format/versions) — reading them is harmless, but
    // calling cache()/concurrency() still touches libvips, so count the call not the read.
    const value = Reflect.get(target, prop, receiver);
    if (typeof value === 'function' && prop !== 'constructor') {
      return (...args) => {
        record(String(prop));
        return value.apply(target, args);
      };
    }
    return value;
  },
});

export default sharp;
export const { cache, concurrency, simd, format, versions, queue, counters, block, unblock } = real;
