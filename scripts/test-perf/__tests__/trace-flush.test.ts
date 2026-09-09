import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  clearStaleSnapshots,
  DEFAULT_TRACE_INTERVAL_MS,
  MAX_TRACE_INTERVAL_MS,
  MIN_TRACE_INTERVAL_MS,
  resolveIntervalMs,
  resolveTraceDir,
  SNAPSHOT_FILE_RE,
} from '../trace-snapshot-name';

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
// The package's own JS entry, not node_modules/.bin/vitest: that shim is an extensionless shell
// script on Windows, which spawnSync cannot execute — the child produces no output at all, so
// every assertion here fails as an empty stdout rather than as anything about the tracer.
const VITEST_CLI = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
const TRACE_CONFIG = 'scripts/test-perf/trace-config.mts';
const FIXTURES = [
  'scripts/test-perf/__tests__/trace-smoke-fixture.test.ts',
  'scripts/test-perf/__tests__/trace-smoke-fixture-b.test.ts',
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
    process.execPath,
    [VITEST_CLI, 'run', '--project', project, '--config', TRACE_CONFIG, ...extraArgs, ...files],
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
  const files = existsSync(traceDir)
    ? readdirSync(traceDir).filter((f) => SNAPSHOT_FILE_RE.test(f))
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
  it('writes a snapshot for a traced run that ends normally', () => {
    expect(existsSync(VITEST_CLI)).toBe(true);
    const traceDir = freshTraceDir();

    // The clear must remove this tool's snapshots and NOTHING else: TESTPERF_TRACE_DIR is
    // caller-supplied and the README promises other JSON there is safe. `.json.bak` is the case a
    // partly-widened predicate lets through — dropping the `$` anchor still matches it, and an
    // editor backup next to a caller's data is a real file to destroy.
    // ⚠️ On its own this pair only says "these were not deleted", which is also true when the clear
    // never runs at all; it is test 2 that proves the clear runs. Read the two together.
    const foreign = [join(traceDir, 'important-notes.json'), join(traceDir, '1234-abcd.json.bak')];
    for (const f of foreign) writeFileSync(f, '{"keep":true}');

    const run = runTraced({ traceDir, extraArgs: ['--max-workers=1'] });
    // Positive control on the child first, so a failure below is attributable: a run that collected
    // nothing would leave an empty trace directory for reasons unrelated to the flush.
    expect(run.stdout + run.stderr).toContain('1 passed');
    expect(run.status).toBe(0);
    for (const f of foreign) expect(existsSync(f)).toBe(true);

    const { files, merged } = mergeSnapshots(traceDir);
    expect(files.length).toBeGreaterThan(0);

    // Not just "a file exists": the snapshot has to name the module the fixture imported, with a
    // real execution count. An empty `{}` would satisfy a file-exists check.
    expect(Object.keys(merged)).toContain(FIXTURE_MODULE);
    expect(merged[FIXTURE_MODULE]?.loads ?? 0).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('does not accumulate a previous run into the next one', () => {
    // trace-report.mjs SUMS every snapshot in the directory, and snapshots outlive the run that
    // wrote them, so without the clear in trace-config.mts a second traced run silently reports
    // roughly doubled loads/selfMs/totalMs — a wrong number rather than a missing one, which is
    // the harder kind to notice. Both runs go to the SAME directory on purpose.
    const traceDir = freshTraceDir();

    runTraced({ traceDir, extraArgs: ['--max-workers=1'] });
    const first = mergeSnapshots(traceDir).merged[FIXTURE_MODULE]?.loads ?? 0;
    expect(first).toBeGreaterThan(0);

    runTraced({ traceDir, extraArgs: ['--max-workers=1'] });
    const after = mergeSnapshots(traceDir);
    const second = after.merged[FIXTURE_MODULE]?.loads ?? 0;

    // Both halves: one snapshot on disk (the previous run's was cleared) AND an unchanged count.
    // The count alone is also satisfied by a merge helper that overwrites instead of summing.
    expect(after.files.length).toBe(1);
    expect(second).toBe(first);
  }, 240_000);

  it("keeps every file's snapshot on a thread pool, where they all share one pid", () => {
    // `forks` gives one process per file, so a bare `<pid>.json` is accidentally unique there and
    // this hazard is invisible. On `threads` every worker lives in ONE process — measured: under
    // a bare pid, N files collapse to ONE snapshot, i.e. every earlier file's counters lost to a
    // last-wins overwrite with valid JSON and no error. Two files is enough to see it and the
    // worker count does not matter, because the tracer re-initialises per FILE rather than per
    // worker (measured identical at --max-workers=1, 2 and 3, so this cannot flake on a
    // low-core runner). vitest.config.mts:152-162 explicitly invites `--pool=threads`.
    const traceDir = freshTraceDir();

    const run = runTraced({
      traceDir,
      files: FIXTURES,
      extraArgs: ['--pool=threads', '--max-workers=2'],
    });
    expect(run.stdout + run.stderr).toContain('2 passed');
    expect(run.status).toBe(0);

    // Assert the DATA survived rather than the filename shape: each fixture file is itself a
    // first-party module the tracer brackets, so every one of them must appear in the merged
    // result. An overwrite leaves only the last file's.
    const { files, merged } = mergeSnapshots(traceDir);
    for (const f of FIXTURES) expect(Object.keys(merged)).toContain(f);

    // This is the only place two snapshots coexist, so it is the only place summing and
    // overwriting differ: every file re-executes the shared setup closure, so a module common to
    // both must merge to the SUM of its two counts. Without this, a merge helper that overwrites
    // passes everything and quietly disarms the accumulation test above.
    const perFile = files.map(
      (f) =>
        JSON.parse(readFileSync(join(traceDir, f), 'utf8')) as Record<string, { loads: number }>
    );
    expect(perFile).toHaveLength(2);
    const shared = Object.keys(perFile[0]).filter((k) => k in perFile[1]);
    expect(shared.length).toBeGreaterThan(0);
    expect(merged[shared[0]].loads).toBe(perFile[0][shared[0]].loads + perFile[1][shared[0]].loads);
  }, 240_000);

  it('does not define a project named "unit"', () => {
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
  }, 180_000);

  // The interval backstop exists so a long run still leaves a snapshot; every out-of-range value
  // makes it a ~1ms synchronous write loop instead. Pinned directly rather than through a child
  // run. 🔴 BOTH bounds matter and the upper one is the trap: setInterval stores its delay in a
  // 32-bit signed int, so a "make it huge so it never fires" value is clamped to 1ms — measured,
  // 1e10 fired 281 times in 300ms. An earlier version of this table asserted `1e10 -> 1e10` as
  // correct and enshrined exactly that.
  it.each([
    // 🔴 The first two rows are LITERAL on purpose. Every other row derives its expectation from
    // the constant it is testing, which means the table cannot see a wrong CONSTANT — measured:
    // `DEFAULT -> 1` and `MAX -> 2**31` both survived a fully green suite, and both are the 1ms
    // flush loop this function exists to prevent. That is round 4's defect one notch out,
    // introduced by round 4's own fix.
    ['abc', 15000],
    ['2147483648', 15000],
    ['abc', DEFAULT_TRACE_INTERVAL_MS],
    ['', DEFAULT_TRACE_INTERVAL_MS],
    [undefined, DEFAULT_TRACE_INTERVAL_MS],
    ['-5', DEFAULT_TRACE_INTERVAL_MS],
    ['0', DEFAULT_TRACE_INTERVAL_MS],
    ['0.5', DEFAULT_TRACE_INTERVAL_MS],
    ['1', DEFAULT_TRACE_INTERVAL_MS],
    ['15s', DEFAULT_TRACE_INTERVAL_MS],
    [String(MIN_TRACE_INTERVAL_MS - 1), DEFAULT_TRACE_INTERVAL_MS],
    [String(MIN_TRACE_INTERVAL_MS), MIN_TRACE_INTERVAL_MS],
    ['3600000', 3600000],
    [String(MAX_TRACE_INTERVAL_MS), MAX_TRACE_INTERVAL_MS],
    [String(MAX_TRACE_INTERVAL_MS + 1), DEFAULT_TRACE_INTERVAL_MS],
    ['1e10', DEFAULT_TRACE_INTERVAL_MS],
    ['Infinity', DEFAULT_TRACE_INTERVAL_MS],
  ])('resolveIntervalMs(%o) -> %o', (raw, expected) => {
    expect(resolveIntervalMs(raw as string | undefined)).toBe(expected);
  });

  // `??` keeps an exported-but-empty string, and `mkdirSync('')` throws — which means no snapshot
  // is ever written and the report says "run a traced suite first". That is the dead-instrument
  // failure this whole change exists to remove, reachable by `export TESTPERF_TRACE_DIR=`.
  it.each([
    ['', '/fallback'],
    ['   ', '/fallback'],
    [undefined, '/fallback'],
    ['/tmp/somewhere', '/tmp/somewhere'],
  ])('resolveTraceDir(%o) -> %o', (raw, expected) => {
    expect(resolveTraceDir(raw as string | undefined, '/fallback')).toBe(expected);
  });

  it('clears every stale snapshot even when one entry cannot be removed', () => {
    // The per-entry catch is the difference between 0 and 5 survivors, and whatever survives is
    // summed into the next run's numbers. A catch around the whole loop passes every other test in
    // this file, so this is the only thing standing between that regression and green.
    const dir = freshTraceDir();
    for (const n of ['1111-aaaa.json', '2222-bbbb.json', '3333-cccc.json']) {
      writeFileSync(join(dir, n), '{}');
    }
    // A DIRECTORY matching the pattern: rmSync without `recursive` throws EISDIR on it, and it is
    // created BEFORE the others alphabetically so a loop-level catch abandons the rest.
    mkdirSync(join(dir, '0000-dddd.json'));
    writeFileSync(join(dir, 'keep-me.json'), '{}');

    const warned: string[] = [];
    clearStaleSnapshots(dir, (what) => warned.push(what));

    const left = readdirSync(dir).sort();
    expect(left).toEqual(['0000-dddd.json', 'keep-me.json']);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('0000-dddd.json');
  });

  it('reports nothing rather than NaN when a foreign json sits in the trace dir', () => {
    // The tracer deliberately leaves foreign files alone, so the reader meets them. Summing one in
    // makes every total NaN — a report that looks like a measurement. Measured before the fix:
    // `20 distinct modules | NaN executions | NaNs self time`.
    const dir = freshTraceDir();
    // TWO snapshots naming the SAME module: with one, summing and overwriting are
    // indistinguishable, and the shipped reader's `+=` survived every mutant because the only
    // test that ran it had a single-file fixture. The test's own mergeSnapshots is a mirror —
    // guarding the mirror is not guarding the tool.
    writeFileSync(
      join(dir, '4242-eeee.json'),
      JSON.stringify({ 'a/b.ts': { loads: 2, selfMs: 1000, totalMs: 3000 } })
    );
    writeFileSync(
      join(dir, '4243-ffff.json'),
      JSON.stringify({ 'a/b.ts': { loads: 3, selfMs: 2000, totalMs: 4000 } })
    );
    writeFileSync(join(dir, 'important-notes.json'), JSON.stringify({ keep: true }));

    const report = spawnSync(
      process.execPath,
      [resolve(repoRoot, 'scripts/test-perf/trace-report.mjs')],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...childEnv, TESTPERF_TRACE_DIR: dir },
      }
    );

    expect(report.status).toBe(0);
    expect(report.stdout).not.toContain('NaN');
    expect(report.stdout).toContain('2 snapshots');
    // The sums the tool itself computed: loads 2+3, selfMs 1000+2000. An overwriting merge reports
    // 3 and 2000ms.
    expect(report.stdout).toContain('5 executions');
    expect(report.stdout).toContain('3000ms');
  });

  it('falls back to the default trace dir when TESTPERF_TRACE_DIR is exported empty', () => {
    // The .mjs reader cannot import the shared TS resolver, so it carries its own copy of the rule
    // — the exact drift the shared module exists to stop, in the one place the module cannot
    // reach. Under `??` semantics the empty string survives and the tool announces `no  — run a
    // traced suite first`, naming no path at all: the dead-instrument failure this PR removes.
    const report = spawnSync(
      process.execPath,
      [resolve(repoRoot, 'scripts/test-perf/trace-report.mjs')],
      { cwd: repoRoot, encoding: 'utf8', env: { ...childEnv, TESTPERF_TRACE_DIR: '' } }
    );

    expect([0, 2]).toContain(report.status);
    expect(report.stdout + report.stderr).not.toMatch(/no\s+—/);
  });
});
