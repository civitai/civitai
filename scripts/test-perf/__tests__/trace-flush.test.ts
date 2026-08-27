import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Regression tests for the module tracer (scripts/test-perf/trace-setup.ts + trace-config.mts).
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
 * So the assertions have to be end-to-end: spawn a REAL traced run and require snapshots on disk.
 * Asserting that `trace-setup.ts` contains the string "afterAll" would pass just as happily with
 * the hook registered somewhere it never fires.
 *
 * Each case gets its own TESTPERF_TRACE_DIR so it cannot clobber a trace a developer is reading,
 * and every child runs with the interval backstop pushed out of reach so `afterAll` is the only
 * path that can produce a snapshot — otherwise a slow child satisfies these tests through the timer.
 */

const repoRoot = resolve(__dirname, '../../..');
const VITEST_BIN = resolve(repoRoot, 'node_modules/.bin/vitest');
const TRACE_CONFIG = 'scripts/test-perf/trace-config.mts';
const FIXTURES = [
  'scripts/test-perf/__tests__/trace-smoke-fixture.test.ts',
  'scripts/test-perf/__tests__/trace-smoke-fixture-b.test.ts',
  'scripts/test-perf/__tests__/trace-smoke-fixture-c.test.ts',
];
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

function runTraced({
  traceDir,
  files = [FIXTURES[0]],
  project = 'unit-trace',
  extraArgs = [] as string[],
}: {
  traceDir: string;
  files?: string[];
  project?: string;
  extraArgs?: string[];
}) {
  return spawnSync(
    VITEST_BIN,
    ['run', '--project', project, '--config', TRACE_CONFIG, ...extraArgs, ...files],
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
}

/** Merges by SUMMING, exactly as trace-report.mjs does — a test that combines snapshots
 *  differently from the tool under test can agree with a report that is wrong. */
function mergeSnapshots(traceDir: string) {
  // Tolerate a missing directory rather than letting readdirSync throw: "no snapshot" is the
  // failure these tests exist to report, and it should read as an assertion, not as an ENOENT
  // stack trace from the test's own plumbing.
  const files = existsSync(traceDir) ? readdirSync(traceDir).filter((f) => f.endsWith('.json')) : [];
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

      const run = runTraced({ traceDir, extraArgs: ['--max-workers=1'] });
      // Positive control on the child: a run that collected nothing would leave an empty trace
      // directory for a reason that has nothing to do with the flush.
      expect(run.stdout + run.stderr).toContain('1 passed');
      expect(run.status).toBe(0);

      const { files, merged } = mergeSnapshots(traceDir);
      expect(files.length).toBeGreaterThan(0);

      // Not just "a file exists": the snapshot has to name the module the fixture imported, with a
      // real execution count. An empty `{}` would satisfy a file-exists check.
      expect(Object.keys(merged)).toContain(FIXTURE_MODULE);
      expect(merged[FIXTURE_MODULE]?.loads ?? 0).toBeGreaterThanOrEqual(1);
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

      runTraced({ traceDir, extraArgs: ['--max-workers=1'] });
      const first = mergeSnapshots(traceDir).merged[FIXTURE_MODULE]?.loads ?? 0;
      expect(first).toBeGreaterThan(0);

      runTraced({ traceDir, extraArgs: ['--max-workers=1'] });
      const second = mergeSnapshots(traceDir).merged[FIXTURE_MODULE]?.loads ?? 0;

      expect(second).toBe(first);
    },
    240_000
  );

  it(
    'keeps every worker on a thread pool, where they all share one pid',
    () => {
      // `forks` gives one process per file, so a bare `<pid>.json` is accidentally unique there and
      // this hazard is invisible. On `threads` every worker lives in ONE process — measured: 3
      // files produce 3 snapshots under the per-worker id and exactly 1 under a bare pid, i.e. two
      // workers' counters silently lost with valid JSON and no error. vitest.config.mts:152-162
      // explicitly invites `--pool=threads` experiments, so this is a configuration people reach.
      const traceDir = freshTraceDir();

      const run = runTraced({
        traceDir,
        files: FIXTURES,
        extraArgs: ['--pool=threads', '--max-workers=3'],
      });
      expect(run.stdout + run.stderr).toContain('3 passed');
      expect(run.status).toBe(0);

      // Assert the DATA survived rather than the filename shape: each fixture file is itself a
      // first-party module the tracer brackets, so all three must appear in the merged result. An
      // overwrite leaves only the last worker's.
      const { merged } = mergeSnapshots(traceDir);
      for (const f of FIXTURES) expect(Object.keys(merged)).toContain(f);
    },
    240_000
  );

  it(
    'does not define a project named "unit"',
    () => {
      // Closes the hole the delta re-audit found: every assertion above names `unit-trace`, so
      // renaming the project back to `unit` in BOTH trace-config.mts and this file would pass green
      // while fully restoring the cache collision that took 16 of 53 files red. This one fails in
      // that world, because the filter would then match.
      const run = runTraced({
        traceDir: freshTraceDir(),
        project: 'unit',
        extraArgs: ['--max-workers=1'],
      });

      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toContain('No projects matched');
    },
    180_000
  );
});
