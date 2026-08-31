import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conflictingOutputFile,
  exitCodeForSignal,
  isNarrowed,
  main,
} from '../test-component-run.mjs';

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

/**
 * 🔴 EVERY CASE PASSES `--repo-root`, AND IT MUST.
 *
 * The gate also compares the report's file list against every `*.browser.test.tsx` on disk.
 * Left pointing at the real repo, that check grades a two-file FIXTURE against 201 real files
 * and every case below fails for a reason none of them is about. Pointing it at a directory
 * with no `src/` makes the walk return "unavailable", which the gate skips — and prints, so a
 * reader can see which checks a given run actually applied. The on-disk ledger has its own
 * fixture tree and its own cases further down.
 */
function runGate(reportPath: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, reportPath, '--repo-root', dir, ...args], {
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * Same, but pointed at a caller-supplied tree so the on-disk ledger is armed.
 *
 * 🔴 `--repo-root` goes FIRST here on purpose. Picking the report as "the first non-flag
 * argument" read the DIRECTORY as the report path whenever the flag preceded it — measured:
 * "EISDIR: illegal operation on a directory" plus the whole abort diagnosis. Every earlier
 * case passed it last, which is precisely why nothing caught it.
 */
function runGateAt(reportPath: string, root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo-root', root, reportPath, ...args], {
    encoding: 'utf8',
  });
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

describe('the on-disk ledger — a file that stops being COLLECTED', () => {
  /**
   * 🔴 THE STRONGER OF THE TWO CHECKS, and the reason it exists: the test floor sits at ~55%,
   * so ~45% of the suite can stop being collected while the gate stays green. The incident
   * this whole guard descends from is exactly that shape — six files contributing 0 of 438
   * with nothing red. This catches ONE file going missing.
   */
  let tree: string;
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), 'component-ondisk-'));
    mkdirSync(join(tree, 'src/components/Deep'), { recursive: true });
    mkdirSync(join(tree, 'src/node_modules/pkg'), { recursive: true });
    for (const p of [
      'src/components/A.browser.test.tsx',
      'src/components/Deep/B.browser.test.tsx',
      'src/components/Deep/C.browser.test.tsx',
    ]) {
      writeFileSync(join(tree, p), '// fixture\n');
    }
    // Neither of these may be counted: the walk must skip `node_modules`, and a `.test.tsx`
    // that is not a `.browser.test.tsx` belongs to the node project, not this one. If either
    // leaked in, the ledger would demand a file the component run can never collect.
    writeFileSync(join(tree, 'src/node_modules/pkg/D.browser.test.tsx'), '// fixture\n');
    writeFileSync(join(tree, 'src/components/E.test.tsx'), '// fixture\n');
  });
  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  const all = [
    'src/components/A.browser.test.tsx',
    'src/components/Deep/B.browser.test.tsx',
    'src/components/Deep/C.browser.test.tsx',
  ];

  it('passes when every file on disk appears in the report', () => {
    const report = writeReport(
      'ondisk-all.json',
      all.map((name, i) => ({ name: join(tree, name), passed: 500 + i }))
    );
    const { code, out } = runGateAt(report, tree);
    expect(out).toContain('3 on disk');
    expect(code).toBe(0);
  });

  it('FAILS when one file is missing, and NAMES it', () => {
    // 1502 executed is comfortably above the floor, so the floor cannot be what fails this —
    // if the on-disk check were deleted this case would go green.
    const report = writeReport(
      'ondisk-missing.json',
      all.slice(0, 2).map((name) => ({ name: join(tree, name), passed: 751 }))
    );
    const { code, out } = runGateAt(report, tree);
    expect(out).toContain('ABSENT FROM THE RUN');
    expect(out).toContain('Deep/C.browser.test.tsx');
    expect(out).not.toContain('EXECUTED ONLY');
    expect(code).toBe(1);
  });

  it('a NARROWED run does not trip it', () => {
    const report = writeReport('ondisk-narrow.json', [{ name: join(tree, all[0]), passed: 4 }]);
    expect(runGateAt(report, tree, '--narrowed').code).toBe(0);
  });

  it('says so, and skips, when there is no tree at all', () => {
    // A ZERO from a walk that found nothing is indistinguishable from a suite with no files,
    // so the gate must not build a ledger on it — but it must SAY it did not, or a reader
    // cannot tell which checks this run applied.
    const report = writeReport('ondisk-unavailable.json', healthy(1500));
    const { code, out } = runGateAt(report, join(dir, 'no-such-tree'));
    expect(out).toContain('on-disk count UNAVAILABLE');
    expect(code).toBe(0);
  });

  it('says so, and skips, when `src/` EXISTS but holds no browser tests', () => {
    // 🔴 THIS CASE EXISTS BECAUSE THE OTHER ONE CANNOT REACH THE CODE IT LOOKS LIKE IT
    // COVERS. With no `src/` at all the walk returns early, so the "an empty result is not a
    // measurement" line below it never executes — a mutation sweep proved it: turning
    // `out.length > 0 ? out : null` into a bare `out` SURVIVED a green suite. An empty array
    // is TRUTHY, so that mutant would arm a ledger over zero expected files, which passes
    // everything while reading as a check that ran.
    const emptyTree = mkdtempSync(join(tmpdir(), 'component-ondisk-empty-'));
    mkdirSync(join(emptyTree, 'src/components'), { recursive: true });
    writeFileSync(join(emptyTree, 'src/components/NotATest.tsx'), '// fixture\n');
    try {
      const report = writeReport('ondisk-empty-src.json', healthy(1500));
      const { code, out } = runGateAt(report, emptyTree);
      expect(out).toContain('on-disk count UNAVAILABLE');
      expect(out).not.toContain('0 on disk');
      expect(code).toBe(0);
    } finally {
      rmSync(emptyTree, { recursive: true, force: true });
    }
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

  it('a test-name pattern is a filter in every spelling', () => {
    // 🔴 `-t` is now in BOTH sets, and the NARROWING one has to win. It is also a value flag,
    // so if the narrowing branch were removed the pattern would be CONSUMED as `-t`'s value
    // rather than seen as a positional — i.e. the old comment here, which said the positional
    // rule would catch `-t foo` anyway, stopped being true the moment `-t` was listed as
    // value-taking. These four are the only thing holding it.
    expect(isNarrowed(['-t', 'renders'])).toBe(true);
    expect(isNarrowed(['-t=renders'])).toBe(true);
    expect(isNarrowed(['--testNamePattern', 'renders'])).toBe(true);
    expect(isNarrowed(['--testNamePattern=renders'])).toBe(true);
  });

  it("a value-taking flag's SPACE form does not disable the checks", () => {
    // 🔴 The silent one, and it was live: `--max-workers 1` put `1` in a positional slot, so
    // the run scored "narrowed" and BOTH checks were turned off with only a one-line note.
    // This is the shape CONTRIBUTING steers people towards for sizing a run on a shared box.
    expect(isNarrowed(['--max-workers', '1'])).toBe(false);
    expect(isNarrowed(['--maxWorkers', '3'])).toBe(false);
    expect(isNarrowed(['--reporter', 'verbose'])).toBe(false);
    expect(isNarrowed(['--retry', '2'])).toBe(false);
    expect(isNarrowed(['--bail', '1'])).toBe(false);
    expect(isNarrowed(['--project', 'component'])).toBe(false);
    expect(isNarrowed(['--pool', 'threads'])).toBe(false);
    // …and a filter AFTER one is still seen.
    expect(isNarrowed(['--max-workers', '1', 'src/components/X.browser.test.tsx'])).toBe(true);
  });

  it('KEBAB and CAMEL spellings of the same flag behave identically', () => {
    // 🔴 vitest treats them as one flag (cac camelCases every option key before matching), so a
    // hand-enumerated list has a hole wherever it carries one spelling and not the other — and
    // it did: `--max-workers`/`--maxWorkers` were both listed, `--test-timeout`/`--testTimeout`
    // were not, so the kebab form silently disabled both checks. Asserted in PAIRS, because a
    // list that regains one spelling and not the other still passes a single-spelling check.
    for (const [kebab, camel] of [
      ['--test-timeout', '--testTimeout'],
      ['--hook-timeout', '--hookTimeout'],
      ['--teardown-timeout', '--teardownTimeout'],
      ['--max-concurrency', '--maxConcurrency'],
      ['--min-workers', '--minWorkers'],
    ]) {
      expect(isNarrowed([kebab, '2']), kebab).toBe(false);
      expect(isNarrowed([camel, '2']), camel).toBe(false);
    }
  });

  it('flags that SHRINK the file set narrow, or the on-disk ledger false-fails', () => {
    // 🔴 THE REGRESSION THE FILE LEDGER INTRODUCED. `--exclude`, `--dir` and `--root` take a
    // value AND genuinely remove files from the run. Scored as full runs, the ledger fails and
    // names up to 200 files, asserting the include broke or the run died and telling the reader
    // not to touch the walk — for `pnpm test:component --exclude 'src/tests/**'`, which is a
    // legitimate invocation. `--config` can replace the project's `include` outright, which is
    // the assumption the walk is built on.
    for (const a of [
      ['--exclude', 'src/tests/**'],
      ['--exclude=src/tests/**'],
      ['--dir', 'src/components'],
      ['--root', '.'],
      ['-r', '.'],
      ['--config', 'other.config.mts'],
      ['-c', 'other.config.mts'],
    ]) {
      expect(isNarrowed(a), a.join(' ')).toBe(true);
    }
  });

  it('--shard and --changed narrow WITHOUT a positional', () => {
    // 🔴 The loud one: `--shard=1/4` executes about a quarter of 2254, i.e. below the floor,
    // so without this the gate fails a healthy sharded run while telling the reader "Do NOT
    // lower the floor to make this green" — misdirection, not just a false red.
    //
    // `--related` is deliberately NOT here: it is a vitest SUBCOMMAND (`cli.command("related
    // [...filters]")`), and this wrapper always spawns `vitest run …`, so it cannot arrive.
    // An assertion for it pinned behaviour on an input the runner cannot receive.
    expect(isNarrowed(['--shard=1/4'])).toBe(true);
    expect(isNarrowed(['--shard', '1/4'])).toBe(true);
    expect(isNarrowed(['--changed'])).toBe(true);
  });
});

describe('conflictingOutputFile', () => {
  it('catches every spelling that would redirect the report', () => {
    // 🔴 Measured before this existed: an 18/18 GREEN single-file run reported an abort that
    // "verified NOTHING" and exited 1, because `--outputFile=<p>` clobbered the
    // `--outputFile.json=` form the wrapper appends. `.github/workflows/lint.yml` runs the
    // SIBLING unit tier with exactly that flag, so this is a copy-paste away.
    //
    // 🔴 The KEBAB form is here because vitest accepts it and the first version of this guard
    // did not catch it — so the test whose name claimed "every spelling" covered four of five.
    expect(conflictingOutputFile(['--outputFile=/tmp/x.json'])).toBe('--outputFile=/tmp/x.json');
    expect(conflictingOutputFile(['--outputFile.json=/tmp/x.json'])).toBe(
      '--outputFile.json=/tmp/x.json'
    );
    expect(conflictingOutputFile(['--outputFile', '/tmp/x.json'])).toBe('--outputFile');
    expect(conflictingOutputFile(['--output-file=/tmp/x.json'])).toBe('--output-file=/tmp/x.json');
    expect(conflictingOutputFile(['--output-file', '/tmp/x.json'])).toBe('--output-file');
  });

  it('does not fire on the ordinary flags, or on a NON-json output key', () => {
    expect(conflictingOutputFile([])).toBeNull();
    expect(conflictingOutputFile(['--max-workers=4', '--reporter=verbose'])).toBeNull();
    // Not a prefix match: a different flag that merely starts the same way must pass.
    expect(conflictingOutputFile(['--outputFileSomethingElse=1'])).toBeNull();
    // 🔴 Object-form output paths are PER REPORTER, so a junit or html path does not touch the
    // `.json` key this wrapper writes. Refusing them was over-strict — a legitimate invocation
    // rejected by a guard whose stated reason ("the bare form sets the path for EVERY
    // reporter") is true only of the bare form.
    expect(conflictingOutputFile(['--outputFile.junit=/tmp/j.xml'])).toBeNull();
    expect(conflictingOutputFile(['--outputFile.html=/tmp/h'])).toBeNull();
  });
});

describe('exitCodeForSignal', () => {
  it('maps each signal to the shell 128+N, not a constant', () => {
    // 🔴 This was a hardcoded 143 for EVERY signal, which re-created the exact mislabelling
    // this whole change exists to remove: the CI task branches on 137 to report `oom-killed`
    // ("raise the task's memory limit"), and a constant 143 matches no branch and falls
    // through to `fail` — a memory problem rendered as a test failure, on the same tier, in
    // the same words. The three are asserted separately because a mutant returning any single
    // constant must fail at least two of them.
    expect(exitCodeForSignal('SIGKILL')).toBe(137);
    expect(exitCodeForSignal('SIGTERM')).toBe(143);
    expect(exitCodeForSignal('SIGINT')).toBe(130);
  });

  it('falls back to 143 for a name node does not know', () => {
    expect(exitCodeForSignal('SIGNOTAREALSIGNAL')).toBe(143);
  });
});

describe('main — the ORDER of effects, which no output can show', () => {
  /**
   * 🔴 THESE PIN SEQUENCING, WHICH IS WHY THEY EXIST AT ALL. The two `clearReport()` calls are
   * byte-identical statements; only their POSITION carries the meaning, so a refactor that
   * moves the first below the run reopens "a stale report satisfies the next run's ledger" —
   * the gate silently inert in exactly its own use case — with every other test still green.
   * Both this and the spawn-failure short-circuit shipped with no coverage.
   */
  const ok = { rc: 0, signal: null, spawnFailed: false };

  function harness(vitestResult: Record<string, unknown>, gateResult = ok) {
    const order: string[] = [];
    return {
      order,
      opts: {
        argv: [],
        clear: () => order.push('clear'),
        runVitest: async () => {
          order.push('vitest');
          return vitestResult;
        },
        runGate: async () => {
          order.push('gate');
          return gateResult;
        },
        log: () => undefined,
      },
    };
  }

  it('clears the stale report BEFORE starting the runner', async () => {
    const h = harness(ok);
    expect(await main(h.opts)).toBe(0);
    expect(h.order).toEqual(['clear', 'vitest', 'gate', 'clear']);
    expect(h.order.indexOf('clear')).toBeLessThan(h.order.indexOf('vitest'));
  });

  it('a SIGNAL death returns the runner status and never consults the gate', async () => {
    // Consulting the gate here would read a report that a killed run never wrote and call it
    // "collected nothing" — relabelling a truncation as an abort, which is a wrong answer
    // rather than a missing one, and would break the CI task's timeout/oom branches.
    const h = harness({ rc: 137, signal: 'SIGKILL', spawnFailed: false });
    expect(await main(h.opts)).toBe(137);
    expect(h.order).toEqual(['clear', 'vitest']);
  });

  it('a failed SPAWN returns without consulting the gate', async () => {
    const h = harness({ rc: 127, signal: null, spawnFailed: true });
    expect(await main(h.opts)).toBe(127);
    expect(h.order).toEqual(['clear', 'vitest']);
  });

  it('a runner that legitimately EXITS 127 is still graded', async () => {
    // 🔴 Keyed on the spawn flag, not on the number. 127 is an exit code a runner can produce
    // on its own; treating it as "the binary could not be started" is a second wrong answer,
    // and it skips the gate on a run that did happen.
    const h = harness({ rc: 127, signal: null, spawnFailed: false });
    expect(await main(h.opts)).toBe(127);
    expect(h.order).toEqual(['clear', 'vitest', 'gate', 'clear']);
  });

  it('the gate can only ADD a failure — it never turns red into green', async () => {
    const red = harness({ rc: 1, signal: null, spawnFailed: false }, ok);
    expect(await main(red.opts)).toBe(1);

    const gateRed = harness(ok, { rc: 1, signal: null, spawnFailed: false });
    expect(await main(gateRed.opts)).toBe(1);
  });

  it('a conflicting --outputFile refuses BEFORE anything runs', async () => {
    const order: string[] = [];
    const rc = await main({
      argv: ['--outputFile=/tmp/x.json'],
      clear: () => order.push('clear'),
      runVitest: async () => {
        order.push('vitest');
        return ok;
      },
      runGate: async () => {
        order.push('gate');
        return ok;
      },
      log: () => undefined,
    });
    expect(rc).toBe(2);
    expect(order).toEqual([]);
  });
});
