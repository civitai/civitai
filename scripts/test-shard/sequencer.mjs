/**
 * Replaces Vitest's count-based `--shard` split with a cost-based one for the unit projects.
 *
 * Applies ONLY when every selected file belongs to a `unit*` project. Any other run — the browser
 * `component`/`geometry` shards, the package suites — gets Vitest's own split, unchanged, because
 * the recorded costs cover the unit suite and nothing else.
 *
 * Fail-open by construction: a missing or unreadable cost table leaves every file "unknown", and
 * unknown files are dealt round-robin (see assign.mjs). The split is then by count, as before, and
 * still a partition: no file is dropped and none runs twice.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BaseSequencer } from 'vitest/node';

import { assignShards } from './assign.mjs';

export const TIMINGS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'unit-timings.json'
);

/** Root-relative, forward-slashed: the form `scripts/test-perf/reporter.mjs` records. */
export const relKey = (root, moduleId) => path.relative(root, moduleId).split(path.sep).join('/');

export function loadTimings(file = TIMINGS_PATH) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const files = data?.files;
    if (!files || typeof files !== 'object') throw new Error('no `files` object');
    return new Map(Object.entries(files));
  } catch (err) {
    // stderr: a caller's `--reporter=json` without an outputFile writes its JSON to stdout.
    console.error(
      `[test-shard] no usable cost table at ${file} (${err?.message ?? err}); ` +
        'splitting the unit suite round-robin by file instead.'
    );
    return new Map();
  }
}

export const isUnitRun = (files) =>
  files.length > 0 && files.every((spec) => spec.project.name.startsWith('unit'));

export default class TimingShardSequencer extends BaseSequencer {
  async shard(files) {
    if (!isUnitRun(files)) return super.shard(files);

    const { root, shard } = this.ctx.config;
    const { index, count } = shard;
    const timings = loadTimings();
    // Project in the key so the same path in two projects can never collide; the cost table is
    // keyed by path alone, which is all the reporter records.
    const keys = files.map((spec) => `${spec.project.name}\0${relKey(root, spec.moduleId)}`);
    const costOf = (key) => {
      const ms = timings.get(key.slice(key.indexOf('\0') + 1));
      return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
    };
    const assigned = assignShards(keys, costOf, count);

    const mine = [];
    let known = 0;
    let estMs = 0;
    files.forEach((spec, i) => {
      if (assigned[i] !== index - 1) return;
      mine.push(spec);
      const cost = costOf(keys[i]);
      if (cost !== undefined) {
        known += 1;
        estMs += cost;
      }
    });
    console.error(
      `[test-shard] shard ${index}/${count}: ${mine.length} of ${files.length} files ` +
        `(${known} with a recorded cost, ${mine.length - known} round-robin), ` +
        `recorded cost ${(estMs / 1000).toFixed(0)} worker-s`
    );
    return mine;
  }
}
