import { describe, expect, it } from 'vitest';

import {
  decideRun,
  headVerdict,
  classifyRed,
  isFlaky,
  statusTargets,
  failedFiles,
  parseFirstBad,
  reportsComplete,
  statusLine,
  statusTarget,
} from '../ci/unit-batched.mjs';

// scripts/ci/unit-batched.mjs carries the unit suite's verdict for `main` now that a push does
// not run it: the batch gate decides whether `main` moved, and the verify step decides which
// commit the verdict lands on. A wrong answer in either is a commit on `main` with no unit red.

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const BAD = 'c'.repeat(40);

// HEAD counts as verified only when a batch run actually POSTED its verdict there: the newest
// `Unit tests (main batch)` status on HEAD is success or failure. A run that crashed before
// posting leaves none (or `error`), and the next batch run re-verifies.
describe('headVerdict: was a verdict actually posted on HEAD?', () => {
  const st = (context: string, state: string) => ({ context, state });

  it('reads the NEWEST status in our context (the API lists newest first)', () => {
    expect(
      headVerdict([
        st('Unit tests (main batch)', 'error'),
        st('Unit tests (main batch)', 'success'),
      ])
    ).toBe('error');
    expect(
      headVerdict([
        st('Unit tests (main batch)', 'failure'),
        st('Unit tests (main batch)', 'error'),
      ])
    ).toBe('failure');
  });

  it('ignores every other context', () => {
    expect(headVerdict([st('tekton / typecheck', 'success')])).toBeNull();
  });

  it('is null with no statuses at all', () => {
    expect(headVerdict([])).toBeNull();
  });
});

describe('decideRun: does HEAD need a batch run?', () => {
  it.each(['success', 'failure'])(
    'skips when HEAD already carries a posted %s verdict',
    (state) => {
      expect(decideRun({ head: HEAD, headState: state })).toEqual({
        run: false,
        reason: `HEAD aaaaaaaaaa already has a posted verdict (${state})`,
      });
    }
  );

  // The gap this closes: a verify job that crashed before posting must not count as verified.
  it('runs when HEAD has only an error status (a crashed verification)', () => {
    expect(decideRun({ head: HEAD, headState: 'error' })).toEqual({
      run: true,
      reason: 'HEAD aaaaaaaaaa has no posted verdict (error)',
    });
  });

  it('runs when HEAD has no verdict at all', () => {
    expect(decideRun({ head: HEAD, headState: null })).toEqual({
      run: true,
      reason: 'HEAD aaaaaaaaaa has no posted verdict (none)',
    });
  });

  // A new dispatch would cancel the running one in its concurrency group.
  it('skips while a verification run is still queued or running', () => {
    expect(decideRun({ head: HEAD, headState: null, inProgress: true })).toEqual({
      run: false,
      reason: 'a batch verification run is still queued or running',
    });
  });

  // Fail open: a gate that cannot read its record must not leave main unverified.
  it('runs when the record could not be read, even if it would have matched', () => {
    expect(decideRun({ head: HEAD, headState: 'success', error: 'HTTP 502' })).toEqual({
      run: true,
      reason: 'could not read the verdict on HEAD (HTTP 502)',
    });
  });
});

describe('statusTarget: where the verdict is posted', () => {
  const failed = ['src/a.test.ts', 'src/b.test.ts'];

  it('green: success on HEAD', () => {
    expect(statusTarget({ unitResult: 'success', head: HEAD })).toEqual({
      sha: HEAD,
      state: 'success',
      description: 'Unit suite passed at this commit.',
    });
  });

  // The property this design must keep: the red lands on the commit that caused it.
  it('red, bisected: failure on the FIRST BAD commit, not on HEAD, naming the files', () => {
    expect(statusTarget({ unitResult: 'failure', head: HEAD, failed, firstBad: BAD })).toEqual({
      sha: BAD,
      state: 'failure',
      description: 'First bad commit. 2 failing file(s): src/a.test.ts, src/b.test.ts',
    });
  });

  it('red, not isolated: failure on HEAD, saying so', () => {
    expect(statusTarget({ unitResult: 'failure', head: HEAD, failed, firstBad: null })).toEqual({
      sha: HEAD,
      state: 'failure',
      description:
        'Bisect could not isolate the commit; failing here: src/a.test.ts, src/b.test.ts',
    });
  });

  it('red with no failing file (setup or timeout): failure on HEAD', () => {
    expect(statusTarget({ unitResult: 'failure', head: HEAD, failed: [] })).toEqual({
      sha: HEAD,
      state: 'failure',
      description: 'A unit shard failed with no failing test file (setup or timeout). See the run.',
    });
  });

  // A flake is not the commit's fault, so it is a success, but never a bare one: the note
  // naming the flaky files is part of the description.
  it('flaky (passes on a re-run at HEAD): success on HEAD, naming the flaky files', () => {
    expect(
      statusTarget({ unitResult: 'failure', head: HEAD, failed, flaky: true, firstBad: BAD })
    ).toEqual({
      sha: HEAD,
      state: 'success',
      description: 'Passed on re-run; flaky: src/a.test.ts, src/b.test.ts',
    });
  });

  it('flaky with many files: the note survives truncation to 140 characters', () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `src/server/services/__tests__/file-${i}.test.ts`
    );
    const d = statusTarget({
      unitResult: 'failure',
      head: HEAD,
      failed: many,
      flaky: true,
    })!.description;
    expect(d).toHaveLength(140);
    expect(
      d.startsWith('Passed on re-run; flaky: src/server/services/__tests__/file-0.test.ts')
    ).toBe(true);
  });

  // A shard that never reported, next to a flaky file, must not read as a pass.
  // Infrastructure, not a suite verdict: `error`, which the gate does not count as verified.
  it('incomplete reports: error on HEAD even when the failed files were flaky', () => {
    expect(
      statusTarget({ unitResult: 'failure', head: HEAD, failed, flaky: true, incomplete: true })
    ).toEqual({
      sha: HEAD,
      state: 'error',
      description:
        'Not every unit shard reported, or a shard failed outside its test files. Re-verified next batch.',
    });
  });

  it.each(['cancelled', 'skipped'])('%s: error on HEAD, so it is re-verified', (unitResult) => {
    expect(statusTarget({ unitResult, head: HEAD, failed })).toEqual({
      sha: HEAD,
      state: 'error',
      description: `Unit suite did not finish (${unitResult}); the next batch run re-verifies.`,
    });
  });

  it('keeps a long description within the 140 characters GitHub accepts', () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `src/server/services/__tests__/file-${i}.test.ts`
    );
    const d = statusTarget({
      unitResult: 'failure',
      head: HEAD,
      failed: many,
      firstBad: BAD,
    })!.description;
    expect(d).toHaveLength(140);
    expect(d.endsWith('...')).toBe(true);
    expect(statusLine('x: ', ['a'])).toBe('x: a');
  });
});

// A bisected red lands on the first bad commit AND on HEAD: HEAD is still failing, and the HEAD
// status is what tells the gate this HEAD was verified.
describe('statusTargets: every status a verdict posts', () => {
  it('bisected red: the first bad commit, then HEAD pointing at it', () => {
    expect(
      statusTargets({ unitResult: 'failure', head: HEAD, failed: ['src/a.test.ts'], firstBad: BAD })
    ).toEqual([
      {
        sha: BAD,
        state: 'failure',
        description: 'First bad commit. 1 failing file(s): src/a.test.ts',
      },
      {
        sha: HEAD,
        state: 'failure',
        description: 'Failing since first bad commit cccccccccc: src/a.test.ts',
      },
    ]);
  });

  it('any other verdict is the single status on HEAD', () => {
    expect(statusTargets({ unitResult: 'success', head: HEAD })).toEqual([
      { sha: HEAD, state: 'success', description: 'Unit suite passed at this commit.' },
    ]);
    expect(statusTargets({ unitResult: 'cancelled', head: HEAD })[0].state).toBe('error');
  });
});

// The rule by which a red becomes a success. Its inputs are pinned here; verify() acts on
// classifyRed below, which calls it.
describe('isFlaky: did every failed file pass on the re-run at HEAD?', () => {
  const all = () => true;
  const pass = () => 0;
  const fail = () => 1;

  it('a passing re-run with every file present is flaky', () => {
    expect(isFlaky(['src/a.test.ts', 'src/b.test.ts'], { exists: all, runner: pass })).toBe(true);
  });

  it('a failing re-run is not flaky', () => {
    expect(isFlaky(['src/a.test.ts'], { exists: all, runner: fail })).toBe(false);
  });

  // A re-run of fewer files than failed is not a pass of the ones left out.
  it('a failed file that no longer exists is not flaky, even if the re-run passes', () => {
    expect(
      isFlaky(['src/a.test.ts', 'src/gone.test.ts'], {
        exists: (f) => f !== 'src/gone.test.ts',
        runner: pass,
      })
    ).toBe(false);
  });

  // Nothing re-run is no evidence of a pass (verify never reached the re-run with no files).
  it('an empty failed list is not flaky', () => {
    expect(isFlaky([], { exists: all, runner: pass })).toBe(false);
  });
});

// What verify() does with a red: it branches on exactly this value.
describe('classifyRed: what verify does with a batch red', () => {
  const yes = () => true;
  const no = () => false;
  const f = ['src/a.test.ts'];

  it('a green or unfinished unit result is none, whatever else is true', () => {
    for (const unitResult of ['success', 'cancelled', 'skipped'])
      expect(classifyRed({ unitResult, failed: f, incomplete: false, flaky: yes })).toBe('none');
  });

  it('incomplete wins over a flaky re-run, and never re-runs', () => {
    let called = false;
    const spy = () => ((called = true), true);
    expect(classifyRed({ unitResult: 'failure', failed: f, incomplete: true, flaky: spy })).toBe(
      'incomplete'
    );
    expect(called).toBe(false);
  });

  it('flaky only when the flake rule says so; otherwise bisect', () => {
    expect(classifyRed({ unitResult: 'failure', failed: f, incomplete: false, flaky: yes })).toBe(
      'flaky'
    );
    expect(classifyRed({ unitResult: 'failure', failed: f, incomplete: false, flaky: no })).toBe(
      'bisect'
    );
  });

  it('a complete red with no failed file is none (failure on HEAD via statusTarget)', () => {
    expect(classifyRed({ unitResult: 'failure', failed: [], incomplete: false, flaky: yes })).toBe(
      'none'
    );
  });

  it('defaults to the real flake rule', () => {
    // A file that does not exist can never be flaky under isFlaky, so no re-run is attempted.
    expect(
      classifyRed({
        unitResult: 'failure',
        failed: ['src/no-such-file.test.ts'],
        incomplete: false,
      })
    ).toBe('bisect');
  });
});

describe('report and bisect parsing', () => {
  const red = (name: string) => ({ success: false, testResults: [{ name, status: 'failed' }] });
  const green = { success: true, testResults: [{ name: '/r/src/c.test.ts', status: 'passed' }] };
  it('reports are complete when every shard reported and each red names a failed file', () => {
    expect(reportsComplete([red('/r/src/a.test.ts'), green, green, green], 4)).toBe(true);
  });
  it('reports are incomplete when a shard sent none (timeout or setup)', () => {
    expect(reportsComplete([red('/r/src/a.test.ts'), green, green], 4)).toBe(false);
  });
  it('reports are incomplete when a red report has no failed file (an error outside a file)', () => {
    expect(
      reportsComplete(
        [red('/r/src/a.test.ts'), { success: false, testResults: [] }, green, green],
        4
      )
    ).toBe(false);
  });

  it('lists failed files repo-relative, deduplicated across shards', () => {
    expect(
      failedFiles(
        [
          {
            testResults: [
              { name: '/r/src/a.test.ts', status: 'failed' },
              { name: '/r/src/c.test.ts', status: 'passed' },
            ],
          },
          { testResults: [{ name: '/r/src/a.test.ts', status: 'failed' }] },
        ],
        '/r'
      )
    ).toEqual(['src/a.test.ts']);
  });

  it('reads the first bad commit from git bisect output', () => {
    expect(parseFirstBad(`running node step\n${BAD} is the first bad commit\ncommit ${BAD}`)).toBe(
      BAD
    );
    // The quoted form newer git prints, copied from a live CI run; older git does not quote.
    expect(parseFirstBad(`${BAD} is the first 'bad' commit\ncommit ${BAD}`)).toBe(BAD);
    expect(parseFirstBad('There are only skipped commits left to test.')).toBeNull();
  });
});
