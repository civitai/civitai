import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Regression test for the module tracer's flush path (scripts/test-perf/trace-setup.ts).
 *
 * 🔴 What broke, and why a cheaper test would not have caught it: the tracer flushed ONLY from
 * `process.on('exit')` and a 15s interval. Vitest's `forks` pool kills its workers rather than
 * letting them exit, so under Vitest 4.1.11 the exit handler never ran, and the README's own
 * workflow — "trace one file at a time", a 5–10s run — never reached the interval either. The
 * result was not a wrong number: `.test-perf/trace/` was never created at all, and
 * `trace-report.mjs` answered "no .test-perf/trace — run a traced suite first", which reads as
 * operator error. The static import graph in `graph.mjs` is validated against this tracer, so a
 * silently dead tracer makes that validation unreproducible.
 *
 * So the assertion has to be end-to-end: spawn a REAL traced run and require a snapshot on disk.
 * Asserting that `trace-setup.ts` contains the string "afterAll" would pass just as happily with
 * the hook registered somewhere it never fires.
 *
 * The run is pointed at a scratch TESTPERF_TRACE_DIR so it cannot clobber a trace a developer is
 * in the middle of reading, and at a fixture file with no app graph so it stays cheap.
 */

const repoRoot = resolve(__dirname, '../../..');
const VITEST_BIN = resolve(repoRoot, 'node_modules/.bin/vitest');
const FIXTURE = 'scripts/test-perf/__tests__/trace-smoke-fixture.test.ts';
const FIXTURE_MODULE = 'scripts/test-perf/trace-smoke-fixture-module.ts';

const traceDir = mkdtempSync(join(tmpdir(), 'trace-flush-'));
afterAll(() => rmSync(traceDir, { recursive: true, force: true }));

// A nested vitest run inherits VITEST_* from this one and misreads them as its own pool wiring.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST_'))
) as NodeJS.ProcessEnv;

describe('module tracer flush', () => {
  it(
    'writes a per-worker snapshot for a traced run that ends normally',
    () => {
      expect(existsSync(VITEST_BIN)).toBe(true);

      const run = spawnSync(
        VITEST_BIN,
        [
          'run',
          '--project',
          'unit',
          '--config',
          'scripts/test-perf/trace-config.mts',
          '--max-workers=1',
          FIXTURE,
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...childEnv, TESTPERF_TRACE_DIR: traceDir },
        }
      );

      // Positive control on the child itself: a run that collected nothing would leave an empty
      // trace dir for a reason that has nothing to do with the flush.
      expect(run.stdout + run.stderr).toContain('1 passed');
      expect(run.status).toBe(0);

      const snapshots = readdirSync(traceDir).filter((f) => f.endsWith('.json'));
      expect(snapshots.length).toBeGreaterThan(0);

      const merged: Record<string, { loads: number }> = {};
      for (const f of snapshots) Object.assign(merged, JSON.parse(readFileSync(join(traceDir, f), 'utf8')));

      // Not just "a file exists": the snapshot has to name the module the fixture imported, with
      // a real execution count. An empty `{}` would satisfy a file-exists check.
      expect(Object.keys(merged)).toContain(FIXTURE_MODULE);
      expect(merged[FIXTURE_MODULE].loads).toBeGreaterThanOrEqual(1);
    },
    180_000
  );
});
