/**
 * Records, AFTER a run, which test files passed and what they depended on — and checks the cache's
 * own work. Pairs with scripts/test-cache/sequencer.mjs, which reads these records before the run.
 *
 * Dependencies come from vite's module graph, not `diagnostic().importDurations`: measured on a
 * fixture, importDurations recorded a static import and MISSED an `await import()` made inside a
 * test body, while the graph caught both, cold and warm. File reads come from
 * scripts/test-cache/fs-tracker.mjs via the file task's meta.
 *
 * The check: every file the sequencer found unchanged but ran anyway — all of them in `shadow`
 * mode, the random sample in `on` — was predicted to pass. One that fails is a FALSE SKIP: the key
 * missed a dependency. The reporter trips the cache, so every later run executes in full until a
 * human looks, and deletes that file's records, so clearing the trip cannot revive the same skip.
 *
 * 🔴 This file must never change a run's outcome. Everything is caught and logged, to stderr.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
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

const log = (msg) => console.error(msg);

export default class TestCacheReporter {
  onInit(vitest) {
    this.vitest = vitest;
    this.startedAt = Date.now();
  }

  onTestRunEnd(testModules, unhandledErrors = [], reason) {
    try {
      this.record(testModules, unhandledErrors, reason);
    } catch (err) {
      log(`[test-cache] recorder failed, run unaffected: ${err?.stack ?? err}`);
    }
  }

  record(testModules, unhandledErrors, reason) {
    const mode = core.mode();
    if (mode === 'off') return;
    const state = globalThis.__civitaiTestCache ?? {
      hits: new Set(),
      sampled: new Set(),
      skipped: [],
      startedAt: this.startedAt,
    };
    const root = this.vitest.config.root;
    const dir = core.cacheDir(root);
    mkdirSync(dir, { recursive: true });

    const rows = testModules.map((m) => {
      const d = m.diagnostic();
      const passed = fullyPassed(m);
      const wasHit = state.hits.has(`${m.project.name}\0${m.moduleId}`);
      return {
        m,
        file: core.toRel(m.moduleId, root),
        project: m.project.name,
        ms: (d.prepareDuration ?? 0) + (d.setupDuration ?? 0) + (d.collectDuration ?? 0) + (d.duration ?? 0),
        passed,
        wasHit,
        falseSkip: wasHit && !passed,
        why: null,
      };
    });

    // The tripwire FIRST, before anything that can throw: a failure while recording must not be
    // what stops a false skip from being reported.
    const falseSkips = rows.filter((r) => r.falseSkip);
    if (falseSkips.length) {
      core.writeTripped(dir, {
        at: new Date().toISOString(),
        root,
        mode,
        falseSkips: falseSkips.map((r) => r.file),
      });
      for (const r of falseSkips) {
        try {
          core.forget(dir, r.project, r.file);
        } catch (err) {
          log(`[test-cache] could not delete records for ${r.file}: ${err?.message ?? err}`);
        }
      }
      log(
        `[test-cache] 🔴 FALSE SKIP — the cache predicted these would pass and they did not:\n` +
          falseSkips.map((r) => `    ${r.file}`).join('\n') +
          `\n  Their records are deleted and the cache is TRIPPED: every run executes in full until ` +
          `${core.trippedPath(dir)} is removed.`
      );
    }

    // An unhandled error fails the run without failing any module, so no module's "passed" can be
    // trusted — measured by review: a leaked rejection left its file `passed`, got recorded, and the
    // next run skipped it green. Same for an interrupted run.
    // Narrowed to the files vitest attributes the errors to (VITEST_TEST_PATH, verified present on
    // a leaked rejection), so one flaky leak does not stop the whole suite recording. An error with
    // no attribution still blocks everything.
    const errorFiles = new Set();
    let unattributed = false;
    for (const e of unhandledErrors ?? []) {
      if (e?.VITEST_TEST_PATH) errorFiles.add(core.toRel(e.VITEST_TEST_PATH, root));
      else unattributed = true;
    }
    const runBlock = unattributed
      ? 'unattributed unhandled error in the run'
      : reason === 'interrupted'
        ? 'run interrupted'
        : this.vitest.config.testNamePattern
          ? 'name-filtered run'
          : null;

    const fingerprint = core.makeFingerprinter(root);
    const salt = core.globalSalt(root, this.vitest.version, fingerprint);
    const opaqueMemo = new Map();
    const opaqueSource = (rel) => {
      if (!opaqueMemo.has(rel)) {
        let bad = false;
        try {
          bad = core.alwaysRuns(readFileSync(join(root, rel), 'utf8'));
        } catch {
          /* unreadable: its fingerprint records that */
        }
        opaqueMemo.set(rel, bad);
      }
      return opaqueMemo.get(rel);
    };

    for (const row of rows) {
      try {
        const block =
          runBlock ?? (errorFiles.has(row.file) ? 'unhandled error attributed to this file' : null);
        this.recordOne(row, { root, dir, fingerprint, salt, runBlock: block, since: state.startedAt, opaqueSource });
      } catch (err) {
        row.why = `record failed: ${err?.code ?? err?.message ?? err}`;
      }
    }

    const skipped = state.skipped?.length ?? 0;
    const summary = {
      at: new Date().toISOString(),
      mode,
      root,
      bailed: state.bailed ?? null,
      runBlock,
      total: rows.length + skipped,
      ran: rows.length,
      skipped,
      hitsRan: rows.filter((r) => r.wasHit).length,
      recorded: rows.filter((r) => r.recorded).length,
      ranMs: Math.round(rows.reduce((n, r) => n + r.ms, 0)),
      hitMs: Math.round(rows.filter((r) => r.wasHit).reduce((n, r) => n + r.ms, 0)),
      falseSkips: falseSkips.map((r) => r.file),
      notRecorded: tally(rows.filter((r) => r.why).map((r) => r.why.replace(/:.*$/, ''))),
      wallMs: Date.now() - (state.startedAt ?? this.startedAt),
    };
    appendFileSync(join(dir, 'ledger.jsonl'), JSON.stringify(summary) + '\n');

    const verify =
      mode === 'shadow'
        ? `${summary.hitsRan} unchanged file(s) ran (shadow mode skips nothing)`
        : `${summary.hitsRan} unchanged file(s) re-run to verify`;
    log(
      `[test-cache] ${summary.total} test files: ${summary.ran} ran, ${skipped} skipped as unchanged ` +
        `since they last passed. ${verify}; false skips: ${falseSkips.length}.`
    );
  }

  recordOne(row, { root, dir, fingerprint, salt, runBlock, since, opaqueSource }) {
    const { m, project, file: testRel } = row;
    if (!project.startsWith('unit')) return void (row.why = 'not a unit project');
    if (!row.passed) return void (row.why = 'did not fully pass');
    if (runBlock) return void (row.why = runBlock);
    if (testRel === null) return void (row.why = 'test file outside the repo');
    const reads = m.meta()?.testCacheReads;
    // No tracker, no record: without it, a read made by a helper module is invisible.
    if (!Array.isArray(reads)) return void (row.why = 'file reads not tracked');

    // Whichever environment transformed the file. A `// @vitest-environment happy-dom` test goes
    // through the web transform, so its modules are in `client`, not `ssr` — measured: such a file
    // was absent from the ssr graph and fell out of the cache entirely.
    const graph = Object.values(m.project.vite?.environments ?? {})
      .map((env) => env.moduleGraph)
      .find((g) => g?.getModuleById(m.moduleId));
    if (!graph) return void (row.why = 'test file not in module graph');

    const ids = new Set(core.closureOf(graph, m.moduleId));
    for (const setup of m.project.config.setupFiles ?? []) {
      // The fs tracker is instrumentation, not an input: its closure (this cache's own code, which
      // imports child_process) is covered by the salt. Walking it marked EVERY test as reaching a
      // child process and recorded nothing at all — measured, which made every control vacuous.
      if (core.toRel(setup, root)?.startsWith('scripts/test-cache/')) continue;
      const s = core.closureOf(graph, setup);
      if (s === null) return void (row.why = 'setup file not in module graph');
      ids.add(setup);
      for (const id of s) ids.add(id);
    }
    const entries = new Set([testRel]);
    for (const id of ids) entries.add(core.toRel(id, root));
    for (const p of reads) entries.add(core.toRel(p, root));
    const kept = [...entries].filter((rel) => !core.isCoveredElsewhere(rel));

    // A module in the graph that is gone now was deleted during the run: the test ran WITH it.
    const graphRels = new Set([...ids].map((id) => core.toRel(id, root)));
    const vanished = kept.find((rel) => graphRels.has(rel) && fingerprint(rel) === 'missing');
    if (vanished) return void (row.why = `imported module gone: ${vanished}`);

    // A spawned process or worker reads what it likes, and a computed import is invisible to the
    // graph — anywhere in the closure, not only in the test file. Measured by review: a helper's
    // `import(/* @vite-ignore */ file)` loaded a module the key never saw.
    for (const rel of kept) {
      if (/\.[cm]?[jt]sx?$/.test(rel) && opaqueSource(rel)) {
        return void (row.why = `spawns / computed import / glob in ${rel}`);
      }
    }
    // Key FIRST, then the change check, so an edit landing between the two is caught by the check
    // instead of being fingerprinted after a check that already passed.
    const key = core.keyFor({ salt, project, testRel, entries: kept, fingerprint });
    // The key is computed from disk at the END of the run. An input modified after the run
    // started is not what ran — recording it would certify the edited version as passing.
    const moved = kept.find((rel) => core.changedSince(root, rel, since - 2000));
    if (moved) return void (row.why = `changed during the run: ${moved}`);

    core.writeRecord(dir, project, testRel, { key, entries: kept, at: new Date().toISOString(), ms: row.ms });
    row.recorded = true;
  }
}

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
