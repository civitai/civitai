/**
 * Decides, BEFORE a run starts, which test files the cache lets it skip. Vitest runs exactly the
 * list `sort()` returns — measured: a sequencer that dropped a deliberately failing file left the
 * run green with that file never executed.
 *
 * A file is skippable when one of its recorded passes still matches: the record lists every path
 * the file depended on last time it passed, and re-fingerprinting those paths now reproduces the
 * recorded key. Reusing the OLD dependency list is sound, because the only way to gain a dependency
 * is to edit a file already in the list — and that edit changes the key.
 *
 * In `on` mode a random sample of the hits runs anyway. If a sampled hit then fails, the key missed
 * something; the reporter trips the cache off and says so. The sample is the standing check that
 * the cache is still telling the truth — without it a false skip is a green run nobody can see.
 */

import { BaseSequencer } from 'vitest/node';

import * as core from './core.mjs';

const SAMPLE_RATE = Number(process.env.CIVITAI_TEST_CACHE_SAMPLE ?? 0.05);

export const runKey = (spec) => `${spec.project.name}\0${spec.moduleId}`;

export default class TestCacheSequencer extends BaseSequencer {
  async sort(files) {
    const state = {
      mode: core.mode(),
      total: files.length,
      skipped: [],
      hits: new Set(),
      sampled: new Set(),
      tripped: null,
    };
    globalThis.__civitaiTestCache = state;

    // A name filter runs part of each file, so a partial run must not be traded for a skip either.
    if (state.mode === 'off' || this.ctx.config.testNamePattern) return super.sort(files);

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

      if (state.mode === 'on') {
        console.log(
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
