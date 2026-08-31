import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isNarrowed } from '../test-component-run.mjs';

/**
 * Tests for the `preview / component-tests` positive control
 * (scripts/ci/assert-component-suite-ran.mjs) and the one branch of its caller that can be
 * wrong invisibly (`isNarrowed`).
 *
 * 🔴 WHAT THIS GUARD IS FOR, restated because it decides every case below: the browser
 * suite can abort having executed ZERO tests, and the CI tier reads only the exit code, so
 * an abort and a genuine list of red assertions render identically. The guard's whole job
 * is to make "collected nothing" say so. A test suite for it therefore has to pin the
 * ZERO case and the boundary, not just the happy path.
 *
 * The cases below are chosen so each kills a specific mutation of the guard:
 *
 *   - dropping 'failed' from the EXECUTED set   -> 'a run that is entirely RED still counts'
 *   - `executed === 0` -> `executed < 0`        -> 'zero executed fails'
 *   - floor `<` -> `<=`                         -> 'exactly at the floor passes'
 *   - floor `<` -> `>`                          -> 'one below the floor fails'
 *   - skipping the narrowed check               -> 'a narrowed run skips the floor'
 *   - narrowed short-circuiting the zero check  -> 'a narrowed run still fails on zero'
 *   - treating a missing report as nothing-to-do-> 'a missing report is a failure'
 *
 * 🔴 The fixture numbers are deliberately NOT round multiples of the floor and NOT equal to
 * any constant the guard names, except where a case is specifically pinning that boundary.
 */

const SCRIPT = resolve(__dirname, '../ci/assert-component-suite-ran.mjs');

/** Kept in step with MIN_TESTS in the script under test. */
const MIN_TESTS = 1240;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'assert-component-suite-ran-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type FileSpec = { name: string; passed?: number; failed?: number; skipped?: number };

/** Build a vitest-shaped JSON report. `files` with no assertions model an import failure. */
function writeReport(name: string, files: FileSpec[]): string {
  const testResults = files.map((f) => {
    const assertionResults = [
      ...Array.from({ length: f.passed ?? 0 }, () => ({ status: 'passed' })),
      ...Array.from({ length: f.failed ?? 0 }, () => ({ status: 'failed' })),
      ...Array.from({ length: f.skipped ?? 0 }, () => ({ status: 'skipped' })),
    ];
    return {
      name: f.name,
      status: (f.failed ?? 0) > 0 || assertionResults.length === 0 ? 'failed' : 'passed',
      assertionResults,
    };
  });
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      numFailedTestSuites: testResults.filter((r) => r.status === 'failed').length,
      numFailedTests: files.reduce((n, f) => n + (f.failed ?? 0), 0),
      numTotalTests: testResults.reduce((n, r) => n + r.assertionResults.length, 0),
      testResults,
    })
  );
  return path;
}

/** One big healthy file is enough — the guard counts assertions, not files. */
const healthy = (n: number, extra: FileSpec[] = []): FileSpec[] => [
  { name: 'src/components/X.browser.test.tsx', passed: n },
  ...extra,
];

function runGate(reportPath: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, reportPath, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('assert-component-suite-ran', () => {
  it('a healthy full run passes and prints the ledger', () => {
    const report = writeReport('healthy.json', healthy(2254));
    const { code, out } = runGate(report);
    expect(out).toContain('2254 executed');
    expect(code).toBe(0);
  });

  it('zero executed FAILS, and says the run verified nothing', () => {
    // The whole point: exit code 0 or 1 from the runner is irrelevant, the guard decides on
    // what was collected. Two files present, neither contributing an assertion — exactly the
    // shape a collection-time abort leaves behind.
    const report = writeReport('zero.json', [
      { name: 'src/a.browser.test.tsx' },
      { name: 'src/b.browser.test.tsx' },
    ]);
    const { code, out } = runGate(report);
    expect(out).toContain('NO ACCOUNTABLE RESULT');
    expect(code).toBe(1);
  });

  it('a run that is entirely RED still counts as having run', () => {
    // 🔴 Kills the mutant that drops 'failed' from EXECUTED. A guard that treated red as
    // "did not run" would fire on every genuine failure — the tier would then be red for
    // two different reasons at once and nobody could tell them apart, which is the exact
    // confusion this whole change exists to remove.
    const report = writeReport('allred.json', [{ name: 'src/a.browser.test.tsx', failed: 1873 }]);
    const { code, out } = runGate(report);
    expect(out).toContain('1873 executed');
    expect(out).not.toContain('NO ACCOUNTABLE RESULT');
    expect(code).toBe(0);
  });

  it('SKIPPED tests do not count towards the floor', () => {
    // 🔴 Kills a `numTotalTests`-based floor. 1901 total, of which only 61 executed: a
    // total-based check waves this through, and a suite that self-skips wholesale is
    // exactly as unverified as one that aborted.
    const report = writeReport('skipped.json', [
      { name: 'src/a.browser.test.tsx', passed: 61, skipped: 1840 },
    ]);
    const { code, out } = runGate(report);
    expect(out).toContain('61 executed, 1840 skipped');
    expect(code).toBe(1);
  });

  it('exactly at the floor passes', () => {
    const report = writeReport('atfloor.json', healthy(MIN_TESTS));
    expect(runGate(report).code).toBe(0);
  });

  it('one below the floor fails, and names the floor', () => {
    const report = writeReport('belowfloor.json', healthy(MIN_TESTS - 1));
    const { code, out } = runGate(report);
    expect(out).toContain(`EXECUTED ONLY ${MIN_TESTS - 1} TESTS`);
    expect(out).toContain('Do NOT lower the floor');
    expect(code).toBe(1);
  });

  it('a narrowed run skips the floor', () => {
    // The fast iteration loop runs one file. 7 is far below the floor and must pass here.
    const report = writeReport('narrow.json', healthy(7));
    const { code, out } = runGate(report, '--narrowed');
    expect(out).toContain('floor SKIPPED');
    expect(code).toBe(0);
  });

  it('a narrowed run STILL fails on zero collected', () => {
    // 🔴 Kills the mutant where `--narrowed` short-circuits the whole gate. A single-file
    // run that collects nothing is the cheapest reproduction of the abort, and is precisely
    // when someone is debugging it — the guard must not go quiet there.
    const report = writeReport('narrowzero.json', [{ name: 'src/a.browser.test.tsx' }]);
    const { code, out } = runGate(report, '--narrowed');
    expect(out).toContain('NO ACCOUNTABLE RESULT');
    expect(code).toBe(1);
  });

  it('names the files that failed WITHOUT running an assertion', () => {
    // The per-file version of the abort: the file failed to IMPORT, so its tests did not
    // run at all, and both the failure count and the per-test list read as clean.
    const report = writeReport('importfail.json', [
      { name: 'src/components/Good.browser.test.tsx', passed: 1300 },
      { name: 'src/components/Broken.browser.test.tsx' },
    ]);
    const { code, out } = runGate(report);
    expect(out).toContain('FAILED WITHOUT RUNNING A SINGLE ASSERTION');
    expect(out).toContain('src/components/Broken.browser.test.tsx');
    // Still a pass overall — the runner's own exit code owns that verdict, this is a NAME
    // for the shape, not a second gate.
    expect(code).toBe(0);
  });

  it('a MISSING report is a failure, not a no-op', () => {
    // 🔴 The case the guard was written for: a run that dies early enough writes no report.
    // Treating that as "nothing to check" would make the guard silent exactly when it is
    // needed.
    const { code, out } = runGate(join(dir, 'does-not-exist.json'));
    expect(out).toContain('does not exist');
    expect(out).toContain('NO ACCOUNTABLE RESULT');
    expect(code).toBe(1);
  });

  it('an UNPARSEABLE report is a failure', () => {
    const path = join(dir, 'garbage.json');
    writeFileSync(path, '{ this is not json');
    const { code, out } = runGate(path);
    expect(out).toContain('not valid JSON');
    expect(code).toBe(1);
  });

  it('the harness itself can produce a red verdict — negative control', () => {
    // Without this, every green above is equally consistent with a gate wired to nothing.
    // `runGate` has produced a 1 in the cases above; this pins that the SAME invocation
    // shape returns 0 and 1 for two inputs that differ only in what was collected.
    const green = writeReport('control-green.json', healthy(1500));
    const red = writeReport('control-red.json', healthy(0));
    expect([runGate(green).code, runGate(red).code]).toEqual([0, 1]);
  });
});

describe('isNarrowed', () => {
  it('no args is a full run', () => {
    expect(isNarrowed([])).toBe(false);
  });

  it('flags alone are not a filter', () => {
    // The CI invocation, and the shape someone uses to size a run on a shared box.
    expect(isNarrowed(['--max-workers=8'])).toBe(false);
    expect(isNarrowed(['--reporter=verbose', '--bail=1'])).toBe(false);
  });

  it('a positional path is a filter', () => {
    expect(isNarrowed(['src/components/X.browser.test.tsx'])).toBe(true);
    expect(isNarrowed(['--max-workers=8', 'src/components/X.browser.test.tsx'])).toBe(true);
  });

  it('a test-name pattern is a filter in both spellings', () => {
    // 🔴 `-t foo` puts the pattern in the NEXT argv slot, where it does not start with `-`
    // and would be caught by the positional rule anyway. `-t=foo` and `--testNamePattern=foo`
    // would NOT be — they start with `-`. Both spellings are pinned so the `=` forms cannot
    // be dropped from the check without a test going red.
    expect(isNarrowed(['-t', 'renders'])).toBe(true);
    expect(isNarrowed(['-t=renders'])).toBe(true);
    expect(isNarrowed(['--testNamePattern', 'renders'])).toBe(true);
    expect(isNarrowed(['--testNamePattern=renders'])).toBe(true);
  });
});
