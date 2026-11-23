import { describe, expect, it } from 'vitest';

import {
  BATCH_WORKFLOWS,
  SUITES,
  decideRun,
  pickBase,
  postedVerdict,
  rerunArgs,
  stepInput,
  suiteOf,
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

// The component and app suites are verified by the same code, through a suite descriptor. The
// unit suite's strings above are the ones it has always posted; these pin that the others get
// their own context and wording, and that nothing defaults a component or app verdict to `unit`.
describe('the batched suites other than unit', () => {
  it('each posts its own commit status context, under its own verify job', () => {
    expect(
      Object.fromEntries(
        Object.entries(SUITES).map(([k, s]) => [k, [s.context, s.verifyJob, s.workflow]])
      )
    ).toEqual({
      unit: ['Unit tests (main batch)', 'Unit verified (main batch)', 'lint.yml'],
      component: ['Component tests (main batch)', 'Component verified (main batch)', 'lint.yml'],
      apps: ['App tests (main batch)', 'App tests verified (main batch)', 'apps.yml'],
    });
  });

  it('word their statuses by suite', () => {
    expect(
      statusTarget({ unitResult: 'success', head: HEAD, suite: SUITES.component })?.description
    ).toBe('Component suite passed at this commit.');
    expect(
      statusTarget({ unitResult: 'cancelled', head: HEAD, suite: SUITES.apps })?.description
    ).toBe('App suite did not finish (cancelled); the next batch run re-verifies.');
    expect(
      statusTarget({ unitResult: 'failure', head: HEAD, failed: [], suite: SUITES.apps })
        ?.description
    ).toBe('An app shard failed with no failing test file (setup or timeout). See the run.');
  });

  // The HEAD status of a bisected red keeps the prefix the CI-watch reader parses, for every suite.
  it('a bisected component red names the first bad commit on HEAD the same way', () => {
    expect(
      statusTargets({
        unitResult: 'failure',
        head: HEAD,
        failed: ['src/x.browser.test.tsx'],
        firstBad: BAD,
        suite: SUITES.component,
      })[1]
    ).toEqual({
      sha: HEAD,
      state: 'failure',
      description: 'Failing since first bad commit cccccccccc: src/x.browser.test.tsx',
    });
  });

  it('re-runs the failed files under the suite projects', () => {
    expect(rerunArgs(['src/a.test.ts'])).toEqual([
      'exec',
      'vitest',
      'run',
      '--project',
      'unit*',
      '--passWithNoTests',
      'src/a.test.ts',
    ]);
    expect(rerunArgs(['src/b.browser.test.tsx'], SUITES.component)).toEqual([
      'exec',
      'vitest',
      'run',
      '--project',
      'component',
      '--project',
      'geometry',
      '--passWithNoTests',
      'src/b.browser.test.tsx',
    ]);
    expect(rerunArgs(['apps/auth/src/c.test.ts'], SUITES.apps).slice(3, 5)).toEqual([
      '--project',
      'app:*',
    ]);
  });

  // The bisect step reads failed.json from a COPY of this file, so the format is a contract:
  // a bare array is the unit suite (what bisect has always written for it).
  it('the bisect step reads its suite from failed.json', () => {
    expect(stepInput(['src/a.test.ts'])).toEqual({ suite: SUITES.unit, files: ['src/a.test.ts'] });
    expect(stepInput({ suite: 'apps', files: ['apps/x.test.ts'] })).toEqual({
      suite: SUITES.apps,
      files: ['apps/x.test.ts'],
    });
    expect(() => stepInput({ suite: 'nope', files: [] })).toThrow(/unknown suite: nope/);
    expect(() => suiteOf('Unit')).toThrow(/unknown suite/);
  });

  // apps.yml is a main batch suite with its own verdict: lint.yml's `batch-suites` dispatches it
  // and waits for (and re-posts) that status rather than folding it into `Batch suites`.
  it('apps.yml is in BATCH_WORKFLOWS with the app suite context as its own', () => {
    expect(BATCH_WORKFLOWS.filter((b) => b.workflow === 'apps.yml')).toEqual([
      { workflow: 'apps.yml', ownContext: SUITES.apps.context },
    ]);
  });
});

// The bisect base is per suite, from the verdict that suite POSTED, never from the run's
// conclusion: the unit and component suites share one lint.yml run, so one of them red makes the
// run `failure` while the other is green. Fixture runs are pairwise distinct, newest first.
describe('pickBase: the last green verified run, per suite', () => {
  const url = (id: number) => `https://github.com/o/r/actions/runs/${id}`;
  const st = (context: string, state: string, id: number) => ({
    context,
    state,
    target_url: url(id),
  });
  const jobsOf = (...names: string[]) => names.map((name) => ({ name, conclusion: 'success' }));
  const BOTH = jobsOf('Unit verified (main batch)', 'Component verified (main batch)');
  // r3 (newest): unit green, component RED. r2: unit RED, component green. r1: both green.
  const cands = () => [
    {
      run: { id: 3, status: 'completed', conclusion: 'failure', head_sha: 'c3' },
      jobs: BOTH,
      statuses: [
        st('Unit tests (main batch)', 'success', 3),
        st('Component tests (main batch)', 'failure', 3),
      ],
    },
    {
      run: { id: 2, status: 'completed', conclusion: 'failure', head_sha: 'c2' },
      jobs: BOTH,
      statuses: [
        st('Unit tests (main batch)', 'failure', 2),
        st('Component tests (main batch)', 'success', 2),
      ],
    },
    {
      run: { id: 1, status: 'completed', conclusion: 'success', head_sha: 'c1' },
      jobs: BOTH,
      statuses: [
        st('Unit tests (main batch)', 'success', 1),
        st('Component tests (main batch)', 'success', 1),
      ],
    },
  ];

  // Mutation: read run.conclusion instead of the posted verdict, and unit lands on r1 (killed).
  it('a red component does not move the unit base', () => {
    expect(pickBase(cands(), SUITES.unit)?.id).toBe(3);
  });

  // Mutation: use the unit context for every suite, and component lands on r3 (killed).
  it('a red unit does not move the component base', () => {
    expect(pickBase(cands(), SUITES.component)?.id).toBe(2);
  });

  it('a run whose verify job did not run is never a base, whatever it posted', () => {
    const c = cands();
    c[0].jobs = [{ name: 'Unit verified (main batch)', conclusion: 'skipped' }, BOTH[1]];
    expect(pickBase(c, SUITES.unit)?.id).toBe(1);
  });

  it('a status naming another run does not count for this one', () => {
    const c = cands();
    c[0].statuses = [st('Unit tests (main batch)', 'success', 99)];
    expect(pickBase(c, SUITES.unit)?.id).toBe(1);
    expect(postedVerdict({ id: 3 }, c[0].statuses, SUITES.unit)).toBeNull();
  });

  it('a run still in progress is skipped; nothing green is null', () => {
    const c = cands();
    c[0].run.status = 'in_progress';
    expect(pickBase(c, SUITES.unit)?.id).toBe(1);
    expect(pickBase([c[1]], SUITES.unit)).toBeNull();
  });

  // Reads lazily: once a base is found, older runs' jobs and statuses are not fetched.
  it('reads jobs and statuses lazily, newest first', () => {
    let older = 0;
    const c = cands().map((x, i) =>
      i === 0 ? x : { ...x, jobs: () => (older++, x.jobs), statuses: () => (older++, x.statuses) }
    );
    expect(pickBase(c, SUITES.unit)?.id).toBe(3);
    expect(older).toBe(0);
  });
});
