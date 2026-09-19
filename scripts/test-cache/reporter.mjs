/**
 * Records, AFTER a run, which test files passed and what they depended on — and checks the cache's
 * own work. Pairs with scripts/test-cache/sequencer.mjs, which read these records before the run.
 *
 * Dependencies come from vite's server-side ssr module graph, not `diagnostic().importDurations`:
 * measured on a fixture, importDurations recorded a static import and MISSED an `await import()`
 * made inside a test body, while the ssr graph caught both, cold and warm. File reads come from
 * scripts/test-cache/fs-tracker.mjs via the file task's meta.
 *
 * The check: every file the sequencer found unchanged but ran anyway — all of them in `shadow`
 * mode, the random sample in `on` — was predicted to pass. One that fails is a FALSE SKIP: the key
 * missed a dependency, and in `on` mode that file would have been reported green without running.
 * The reporter then trips the cache so every later run executes in full until a human looks.
 *
 * 🔴 This file must never change a run's outcome. Everything is caught and logged. It imports node
 * builtins only.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as core from './core.mjs';

/** Every case ran and passed. A skipped case means part of the file never ran. */
export function fullyPassed(testModule) {
  if (testModule.state() !== 'passed') return false;
  for (const test of testModule.children.allTests()) {
    if (test.result().state !== 'passed') return false;
  }
  return true;
}

export default class TestCacheReporter {
  onInit(vitest) {
    this.vitest = vitest;
    this.startedAt = Date.now();
  }

  onTestRunEnd(testModules) {
    try {
      this.record(testModules);
    } catch (err) {
      console.error(`[test-cache] recorder failed, run unaffected: ${err?.stack ?? err}`);
    }
  }

  record(testModules) {
    const mode = core.mode();
    if (mode === 'off') return;
    const state = globalThis.__civitaiTestCache ?? { hits: new Set(), sampled: new Set(), skipped: [], total: testModules.length };
    const root = this.vitest.config.root;
    const filtered = Boolean(this.vitest.config.testNamePattern);
    const dir = core.cacheDir(root);
    mkdirSync(dir, { recursive: true });
    const fingerprint = core.makeFingerprinter(root);
    const salt = core.globalSalt(root, this.vitest.version, fingerprint);

    const rows = [];
    for (const m of testModules) {
      const project = m.project.name;
      const testRel = core.toRel(m.moduleId, root);
      const d = m.diagnostic();
      const row = {
        file: testRel,
        project,
        ms: (d.prepareDuration ?? 0) + (d.setupDuration ?? 0) + (d.collectDuration ?? 0) + (d.duration ?? 0),
        passed: fullyPassed(m),
        wasHit: state.hits.has(`${project}\0${m.moduleId}`),
        why: null,
      };
      rows.push(row);
      if (row.wasHit && !row.passed) row.falseSkip = true;

      const reads = m.meta()?.testCacheReads;
      // Whichever environment transformed the file. A `// @vitest-environment happy-dom` test goes
      // through the web transform, so its modules are in `client`, not `ssr` — measured: such a
      // file was absent from the ssr graph and fell out of the cache entirely.
      const graph = Object.values(m.project.vite?.environments ?? {})
        .map((env) => env.moduleGraph)
        .find((g) => g?.getModuleById(m.moduleId));
      let source = null;
      try {
        source = readFileSync(join(root, testRel), 'utf8');
      } catch {
        /* handled below */
      }

      if (!project.startsWith('unit')) row.why = 'not a unit project';
      else if (!row.passed) row.why = 'did not fully pass';
      else if (filtered) row.why = 'name-filtered run';
      else if (source === null) row.why = 'test file unreadable';
      else if (core.alwaysRuns(source)) row.why = 'spawns / computed import / glob';
      // No tracker, no record: without it, a read made by a helper module is invisible.
      else if (!Array.isArray(reads)) row.why = 'file reads not tracked';
      else if (!graph) row.why = 'no ssr module graph';
      if (row.why) continue;

      const entries = new Set();
      const own = core.closureOf(graph, m.moduleId);
      if (own === null) {
        row.why = 'test file not in module graph';
        continue;
      }
      for (const id of own) entries.add(core.toRel(id, root));
      let setupMissing = false;
      for (const setup of m.project.config.setupFiles ?? []) {
        const s = core.closureOf(graph, setup);
        if (s === null) {
          setupMissing = true;
          break;
        }
        entries.add(core.toRel(setup, root));
        for (const id of s) entries.add(core.toRel(id, root));
      }
      if (setupMissing) {
        row.why = 'setup file not in module graph';
        continue;
      }
      for (const p of reads) entries.add(core.toRel(p, root));

      const kept = [...entries].filter((rel) => !core.isCoveredElsewhere(rel));
      const key = core.keyFor({ salt, project, testRel, entries: kept, fingerprint });
      core.writeRecord(dir, project, testRel, { key, entries: kept, at: new Date().toISOString(), ms: row.ms });
      row.recorded = true;
    }

    const falseSkips = rows.filter((r) => r.falseSkip).map((r) => r.file);
    if (falseSkips.length) {
      writeFileSync(
        core.trippedPath(dir),
        JSON.stringify({ at: new Date().toISOString(), root, mode, falseSkips }, null, 2)
      );
    }

    const skipped = state.skipped?.length ?? 0;
    const summary = {
      at: new Date().toISOString(),
      mode,
      root,
      filtered,
      total: rows.length + skipped,
      ran: rows.length,
      skipped,
      hitsRan: rows.filter((r) => r.wasHit).length,
      recorded: rows.filter((r) => r.recorded).length,
      ranMs: Math.round(rows.reduce((n, r) => n + r.ms, 0)),
      hitMs: Math.round(rows.filter((r) => r.wasHit).reduce((n, r) => n + r.ms, 0)),
      falseSkips,
      notRecorded: tally(rows.filter((r) => r.why).map((r) => r.why)),
      wallMs: Date.now() - this.startedAt,
    };
    appendFileSync(join(dir, 'ledger.jsonl'), JSON.stringify(summary) + '\n');

    const verify =
      mode === 'shadow'
        ? `${summary.hitsRan} unchanged file(s) ran (shadow mode skips nothing)`
        : `${summary.hitsRan} unchanged file(s) re-run to verify`;
    console.log(
      `[test-cache] ${summary.total} test files: ${summary.ran} ran, ${skipped} skipped as unchanged ` +
        `since they last passed. ${verify}; false skips: ${falseSkips.length}.`
    );
    if (falseSkips.length) {
      console.error(
        `[test-cache] 🔴 FALSE SKIP — the cache predicted these would pass and they did not:\n` +
          falseSkips.map((f) => `    ${f}`).join('\n') +
          `\n  The cache is now TRIPPED: every run executes in full until ${core.trippedPath(dir)} is removed.`
      );
    }
  }
}

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
