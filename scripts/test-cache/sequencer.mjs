/**
 * Decides, BEFORE a run starts, which test files the cache lets it skip. Vitest runs exactly the
 * list `sort()` returns — measured: a sequencer that dropped a deliberately failing file left the
 * run green with that file never executed.
 *
 * A file is skippable when one of its recorded passes still matches: the record lists every path
 * the file depended on last time it passed, and re-fingerprinting those paths now reproduces the
 * recorded key. Reusing the OLD list is sound for static imports and tracked file reads, because
 * gaining one means editing a file already in the list. It is NOT sound for a computed dynamic
 * import or a spawned process; the reporter refuses to record any file whose graph can reach one.
 *
 * In `on` mode a random sample of the hits runs anyway. If a sampled hit then fails, the key missed
 * something; the reporter trips the cache off and says so. The sample is the standing check that
 * the cache is still telling the truth — without it a false skip is a green run nobody can see.
 */

import { BaseSequencer } from 'vitest/node';

import * as core from './core.mjs';

const parsedRate = Number(process.env.CIVITAI_TEST_CACHE_SAMPLE);
// A malformed rate must not become NaN: `Math.random() < NaN` is never true, which would switch the
// sampling — the tripwire's only input in `on` mode — silently off.
const SAMPLE_RATE =
  process.env.CIVITAI_TEST_CACHE_SAMPLE !== undefined && Number.isFinite(parsedRate) ? parsedRate : 0.05;

export const runKey = (spec) => `${spec.project.name}\0${spec.moduleId}`;

export default class TestCacheSequencer extends BaseSequencer {
  async sort(files) {
    const state = {
      mode: core.mode(),
      // Recorded inputs modified after this instant were not what ran; the reporter refuses them.
      startedAt: Date.now(),
      total: files.length,
      skipped: [],
      hits: new Set(),
      sampled: new Set(),
      tripped: null,
      bailed: null,
    };
    globalThis.__civitaiTestCache = state;

    if (state.mode === 'off') return super.sort(files);
    // A name filter runs part of each file, so a partial run must not be traded for a skip.
    if (this.ctx.config.testNamePattern) state.bailed = 'name filter';
    // A run that names files asked for those files. Only a whole-suite run is the cache's to trim.
    else if (this.ctx.filenamePattern?.length && !process.env.CIVITAI_TEST_CACHE_ALLOW_FILTERS)
      state.bailed = 'file filter';
    // Without the reporter nothing records and nothing checks the sample, so skipping would be
    // unobserved. It is loaded by the queue on the command line; a hand-exported env var is not.
    else if (!(this.ctx.reporters ?? []).some((r) => r?.constructor?.name === 'TestCacheReporter'))
      state.bailed = 'cache reporter not loaded';
    if (state.bailed) {
      console.error(`[test-cache] not skipping anything: ${state.bailed}.`);
      return super.sort(files);
    }

    try {
      const root = this.ctx.config.root;
      const dir = core.cacheDir(root);
      state.tripped = core.tripped(dir);
      const fingerprint = core.makeFingerprinter(root);
      const salt = core.globalSalt(root, this.ctx.version, fingerprint);

      const keep = [];
      for (const spec of files) {
        const project = spec.project.name;
        const testRel = core.toRel(spec.moduleId, root);
        const hit =
          project.startsWith('unit') &&
          testRel !== null &&
          core
            .recordsFor(dir, project, testRel)
            .some((rec) => core.keyFor({ salt, project, testRel, entries: rec.entries, fingerprint }) === rec.key);

        if (!hit) {
          keep.push(spec);
          continue;
        }
        state.hits.add(runKey(spec));
        if (state.mode === 'shadow' || state.tripped || Math.random() < SAMPLE_RATE) {
          if (state.mode === 'on' && !state.tripped) state.sampled.add(runKey(spec));
          keep.push(spec);
          continue;
        }
        state.skipped.push(testRel);
      }

      // stderr, not stdout: a caller's own `--reporter=json` with no outputFile writes its JSON to
      // stdout, and a line from here would corrupt it.
      if (state.mode === 'on') {
        console.error(
          state.tripped
            ? `[test-cache] TRIPPED since ${state.tripped.at} — running everything. ` +
                `Delete ${core.trippedPath(dir)} once the cause is understood.`
            : `[test-cache] running ${keep.length} of ${files.length} test files: ` +
                `${state.skipped.length} skipped as unchanged since they last passed, ` +
                `${state.sampled.size} unchanged ones re-run to verify the cache.`
        );
      }
      // A run the cache skipped ENTIRELY must still pass. Vitest otherwise reports "No test files
      // found" and exits 1 — measured on the fixture: a fully cached run exited 1 with nothing
      // failing. Set only here, so a run that genuinely matched no files still fails as before.
      if (keep.length === 0 && state.skipped.length > 0) this.ctx.config.passWithNoTests = true;
      return super.sort(keep);
    } catch (err) {
      console.error(`[test-cache] could not read the cache, running everything: ${err?.stack ?? err}`);
      state.skipped = [];
      state.sampled = new Set();
      return super.sort(files);
    }
  }
}
