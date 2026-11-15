import { describe, expect, it } from 'vitest';

import {
  decideRun,
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

describe('decideRun: did main move since the last batch verification?', () => {
  it('skips when HEAD is the commit the last batch run verified', () => {
    expect(decideRun({ head: HEAD, lastVerified: HEAD })).toEqual({
      run: false,
      reason: 'HEAD aaaaaaaaaa is the commit the last batch run verified',
    });
  });

  it('runs when HEAD moved', () => {
    expect(decideRun({ head: HEAD, lastVerified: OLD })).toEqual({
      run: true,
      reason: 'HEAD moved: bbbbbbbbbb -> aaaaaaaaaa',
    });
  });

  it('runs when nothing has been verified yet', () => {
    expect(decideRun({ head: HEAD, lastVerified: null })).toEqual({
      run: true,
      reason: 'no batch run has verified a commit yet',
    });
  });

  // A new dispatch would cancel the running one in its concurrency group.
  it('skips while a verification run is still queued or running, even when HEAD moved', () => {
    expect(decideRun({ head: HEAD, lastVerified: OLD, inProgress: true })).toEqual({
      run: false,
      reason: 'a batch verification run is still queued or running',
    });
  });

  // Fail open: a gate that cannot read its record must not leave main unverified.
  it('runs when the record could not be read, even if it would have matched', () => {
    expect(decideRun({ head: HEAD, lastVerified: HEAD, error: 'HTTP 502' })).toEqual({
      run: true,
      reason: 'could not read the last verified commit (HTTP 502)',
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
  it('incomplete reports: failure on HEAD even when the failed files were flaky', () => {
    expect(
      statusTarget({ unitResult: 'failure', head: HEAD, failed, flaky: true, incomplete: true })
    ).toEqual({
      sha: HEAD,
      state: 'failure',
      description:
        'Not every unit shard reported, or a shard failed outside its test files (timeout or setup). See the run.',
    });
  });

  it.each(['cancelled', 'skipped'])('%s: nothing is posted', (unitResult) => {
    expect(statusTarget({ unitResult, head: HEAD, failed })).toBeNull();
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
    // The form git 2.56 (the CI runner's) prints, read from a live run.
    expect(parseFirstBad(`${BAD} is the first 'bad' commit\ncommit ${BAD}`)).toBe(BAD);
    expect(parseFirstBad('There are only skipped commits left to test.')).toBeNull();
  });
});
