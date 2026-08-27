import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Regression tests for the module tracer's flush path (scripts/test-perf/trace-setup.ts).
 *
 * 🔴 What broke, and why a cheaper test would not have caught it: the tracer flushed ONLY from
 * `process.on('exit')` and a 15s interval. Vitest's `forks` pool kills its workers rather than
 * letting them exit, so the exit handler never ran, and the README's own workflow — "trace one file
 * at a time", a 5–10s run — never reached the interval either. The result was not a wrong number:
 * `.test-perf/trace/` was never created at all, and `trace-report.mjs` answered
 * "no … — run a traced suite first", which reads as operator error. The static import graph in
 * `graph.mjs` is validated against this tracer, so a silently dead tracer makes that validation
 * unreproducible.
 *
 * So the assertions have to be end-to-end: spawn a REAL traced run and require a snapshot on disk.
 * Asserting that `trace-setup.ts` contains the string "afterAll" would pass just as happily with
 * the hook registered somewhere it never fires.
 *
 * Each case gets its own TESTPERF_TRACE_DIR so it cannot clobber a trace a developer is reading,
 * and the child's interval backstop is pushed out of reach so `afterAll` is the only path that can
 * produce a snapshot — otherwise a slow child satisfies these tests through the timer.
 */

const repoRoot = resolve(__dirname, '../../..');
const VITEST_BIN = resolve(repoRoot, 'node_modules/.bin/vitest');
const FIXTURE = 'scripts/test-perf/__tests__/trace-smoke-fixture.test.ts';
const FIXTURE_MODULE = 'scripts/test-perf/trace-smoke-fixture-module.ts';

const tmpDirs: string[] = [];
const freshTraceDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'trace-flush-'));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// A nested vitest run inherits VITEST_* from this one and misreads them as its own pool wiring.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST_'))
) as NodeJS.ProcessEnv;

function traceOnce(traceDir: string) {
  const run = spawnSync(
    VITEST_BIN,
    [
      'run',
      // 'unit-trace', not 'unit': the traced project is deliberately named apart so it gets its own
      // dep-optimizer cache. Sharing the name made this very spawn delete the cache the surrounding
      // suite was importing from — 16 of 53 files red with `Cannot find module '…/deps_ssr/…'`.
      '--project',
      'unit-trace',
      '--config',
      'scripts/test-perf/trace-config.mts',
      '--max-workers=1',
      FIXTURE,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...childEnv,
        TESTPERF_TRACE_DIR: traceDir,
        TESTPERF_TRACE_INTERVAL_MS: String(60 * 60 * 1000),
      },
    }
  );

  // Positive control on the child itself: a run that collected nothing would leave an empty trace
  // directory for a reason that has nothing to do with the flush.
  expect(run.stdout + run.stderr).toContain('1 passed');
  expect(run.status).toBe(0);
  return run;
}

/** Merges by SUMMING, exactly as trace-report.mjs does — a test that combines snapshots
 *  differently from the tool under test can agree with a report that is wrong. */
function mergeSnapshots(traceDir: string) {
  // Tolerate a missing directory rather than letting readdirSync throw: "no snapshot" is the
  // failure these tests exist to report, and it should read as an assertion, not as an ENOENT
  // stack trace from the test's own plumbing.
  const files = existsSync(traceDir)
    ? readdirSync(traceDir).filter((f) => f.endsWith('.json'))
    : [];
  const merged: Record<string, { loads: number }> = {};
  for (const f of files) {
    const snapshot = JSON.parse(readFileSync(join(traceDir, f), 'utf8')) as Record<
      string,
      { loads: number }
    >;
    for (const [id, entry] of Object.entries(snapshot))
      merged[id] = { loads: (merged[id]?.loads ?? 0) + entry.loads };
  }
  return { files, merged };
}

describe('module tracer flush', () => {
  it(
    'writes a per-worker snapshot for a traced run that ends normally',
    () => {
      expect(existsSync(VITEST_BIN)).toBe(true);
      const traceDir = freshTraceDir();

      traceOnce(traceDir);

      const { files, merged } = mergeSnapshots(traceDir);
      expect(files.length).toBeGreaterThan(0);

      // ⚠️ PROXY, and a weak one — read the limitation before trusting it. The property that
      // matters is that two workers never flush to the SAME path, which only bites on a thread
      // pool (`forks` gives one process per file, so a bare pid is already unique there). Testing
      // it properly needs a `--pool=threads` child with several files and several workers; this
      // only pins the FILENAME SHAPE, so it catches a revert to a bare `<pid>.json` and would not
      // catch a suffix that is constant rather than per-worker.
      expect(files[0]).toMatch(/^\d+-[a-z0-9]+\.json$/);

      // Not just "a file exists": the snapshot has to name the module the fixture imported, with a
      // real execution count. An empty `{}` would satisfy a file-exists check.
      expect(Object.keys(merged)).toContain(FIXTURE_MODULE);
      expect(merged[FIXTURE_MODULE].loads).toBeGreaterThanOrEqual(1);
    },
    180_000
  );

  it(
    'does not accumulate a previous run into the next one',
    () => {
      // trace-report.mjs SUMS every snapshot in the directory, and snapshots outlive the run that
      // wrote them, so without the clear in trace-config.mts a second traced run silently reports
      // roughly doubled loads/selfMs/totalMs — a wrong number rather than a missing one, which is
      // the harder kind to notice. Both runs go to the SAME directory on purpose.
      const traceDir = freshTraceDir();

      traceOnce(traceDir);
      const first = mergeSnapshots(traceDir).merged[FIXTURE_MODULE].loads;

      traceOnce(traceDir);
      const second = mergeSnapshots(traceDir).merged[FIXTURE_MODULE].loads;

      expect(second).toBe(first);
    },
    240_000
  );
});
