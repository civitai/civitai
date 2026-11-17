import { describe, expect, it } from 'vitest';

import { decide, decideJob, suitesToSkip } from '../ci/lint-dispatch-passed.mjs';

// scripts/ci/lint-dispatch-passed.mjs decides which suites a full-ci Lint dispatch skips because
// the pull_request Lint run on the same commit already passed them. A wrong `skip` hides a red
// suite behind a skipped check, so every case that is not an existing success must come out
// `run` (or `wait`, while the PR job is still going).

type J = { name?: string; status?: string; conclusion?: string | null };

const done = (name: string, conclusion: string): J => ({ name, status: 'completed', conclusion });
const going = (name: string, status = 'in_progress'): J => ({ name, status, conclusion: null });

const TT = 'Typecheck test files (ratchet)';
const PKG = 'Package unit tests';
const COMPONENT = [
  'Component + geometry tests (1/3)',
  'Component + geometry tests (2/3)',
  'Component + geometry tests (3/3)',
  'Component + geometry tests',
];

describe('decideJob', () => {
  it.each([
    ['one success', [done(TT, 'success')], 'skip'],
    ['a failure', [done(TT, 'failure')], 'run'],
    ['a timeout', [done(TT, 'timed_out')], 'run'],
    ['still running', [going(TT)], 'wait'],
    ['still queued', [going(TT, 'queued')], 'wait'],
    ['cancelled only', [done(TT, 'cancelled')], 'run'],
    ['skipped only (a draft run)', [done(TT, 'skipped')], 'run'],
    // A cancelled draft run, then the ready run on the same commit.
    ['cancelled, then a success', [done(TT, 'cancelled'), done(TT, 'success')], 'skip'],
    // Two runs on one commit that disagree: do not pick the green one.
    ['a success and a failure', [done(TT, 'success'), done(TT, 'failure')], 'run'],
    // A success exists, but another run's job is unfinished and may still fail.
    ['a success and one still running', [done(TT, 'success'), going(TT)], 'wait'],
    ['a failure and one still running', [done(TT, 'failure'), going(TT)], 'run'],
  ] as const)('%s -> %s', (_label, jobs, want) => {
    expect(decideJob([...jobs], false)).toBe(want);
  });

  it('waits while a run that is still going does not list the job, else runs', () => {
    expect(decideJob([], true)).toBe('wait');
    expect(decideJob([], false)).toBe('run');
    // Another run's success is not enough while one run has yet to list the job.
    expect(decideJob([done(TT, 'success')], true)).toBe('wait');
  });
});

describe('decide', () => {
  const allGreen = [TT, PKG, ...COMPONENT].map((n) => done(n, 'success'));
  const finished = (jobs: J[]) => ({ status: 'completed', jobs });

  it('skips every suite the PR run passed', () => {
    expect(decide([finished(allGreen)])).toEqual({
      typecheck_tests: 'skip',
      packages: 'skip',
      component: 'skip',
    });
  });

  it('runs the component suite when one shard failed, and skips the rest', () => {
    const jobs = allGreen.map((j) =>
      j.name === 'Component + geometry tests (2/3)' ? done(j.name, 'failure') : j
    );
    expect(decide([finished(jobs)])).toEqual({
      typecheck_tests: 'skip',
      packages: 'skip',
      component: 'run',
    });
  });

  it('waits for the ledger after the shards passed', () => {
    const jobs = [
      ...allGreen.filter((j) => j.name !== 'Component + geometry tests'),
      going('Component + geometry tests', 'queued'),
    ];
    expect(decide([{ status: 'in_progress', jobs }]).component).toBe('wait');
  });

  // A draft PR run: the matrix job is skipped under its unexpanded name, so no shard is listed.
  it('runs everything after a draft PR run that ran ESLint only', () => {
    const jobs = [
      done('ESLint + Prettier (changed files)', 'success'),
      done(TT, 'skipped'),
      done(PKG, 'skipped'),
      done('Component + geometry tests (${{ matrix.shard }}/3)', 'skipped'),
      done('Component + geometry tests', 'skipped'),
    ];
    expect(decide([finished(jobs)])).toEqual({
      typecheck_tests: 'run',
      packages: 'run',
      component: 'run',
    });
  });

  // A draft run, then a ready_for_review run on the same commit whose shards are still going: the
  // ledger is not listed in the ready run yet, and the draft run's skipped ledger is no reason to
  // give up on it.
  it('waits for a running run that does not list the ledger yet, despite a skipped one elsewhere', () => {
    const draft = finished([
      done(TT, 'skipped'),
      done(PKG, 'skipped'),
      done('Component + geometry tests (${{ matrix.shard }}/3)', 'skipped'),
      done('Component + geometry tests', 'skipped'),
    ]);
    const ready = {
      status: 'in_progress',
      jobs: [
        done(TT, 'success'),
        done(PKG, 'success'),
        ...COMPONENT.slice(0, 3).map((n) => going(n)),
      ],
    };
    expect(decide([draft, ready])).toEqual({
      typecheck_tests: 'skip',
      packages: 'skip',
      component: 'wait',
    });
  });

  it('runs everything when there is no PR run', () => {
    expect(decide([])).toEqual({ typecheck_tests: 'run', packages: 'run', component: 'run' });
  });

  it('does not count a job with a similar name', () => {
    const jobs = [
      done('Package unit tests (extra)', 'success'),
      done('Typecheck test files', 'success'),
      done('Typecheck (main pushes / fork PRs / non-main base)', 'success'),
    ];
    expect(decide([finished(jobs)])).toMatchObject({ typecheck_tests: 'run', packages: 'run' });
  });
});

describe('suitesToSkip', () => {
  const SHA = 'a'.repeat(40);
  const REPO = 'o/r';

  /** A fake API whose run and jobs change with each poll. */
  function api(polls: Array<{ status: string; jobs: J[] }>) {
    let i = 0;
    const calls: string[] = [];
    let clock = 0;
    return {
      calls,
      opts: {
        repo: REPO,
        sha: SHA,
        maxWaitMs: 90_000,
        pollMs: 30_000,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
          i = Math.min(i + 1, polls.length - 1);
        },
        fetchJson: async (path: string): Promise<unknown> => {
          calls.push(path);
          if (path.includes('/runs?'))
            return { workflow_runs: [{ id: 7, head_sha: SHA, status: polls[i].status }] };
          return { jobs: polls[i].jobs };
        },
      },
    };
  }

  it('waits for PR jobs still running, then skips the ones that passed', async () => {
    const a = api([
      { status: 'in_progress', jobs: [going(TT), going(PKG)] },
      { status: 'in_progress', jobs: [done(TT, 'success'), going(PKG)] },
      { status: 'completed', jobs: [done(TT, 'success'), done(PKG, 'failure')] },
    ]);
    const r = await suitesToSkip(a.opts);
    expect(r.skip).toEqual(['typecheck_tests']);
    expect(r.decisions).toEqual({ typecheck_tests: 'skip', packages: 'run', component: 'run' });
    // Three polls, each one runs list plus one jobs list: it stopped as soon as nothing waited.
    expect(a.calls).toHaveLength(6);
  });

  it('runs what is still unfinished at the deadline', async () => {
    const a = api([{ status: 'in_progress', jobs: [done(TT, 'success'), going(PKG)] }]);
    const r = await suitesToSkip(a.opts);
    expect(r.skip).toEqual(['typecheck_tests']);
    expect(r.decisions?.packages).toBe('run');
    // 90 s at 30 s a poll: the first read plus three more, then it gives up.
    expect(a.calls.filter((c) => c.includes('/runs?'))).toHaveLength(4);
  });

  it('asks for the runs on the dispatch commit and the latest attempt of each', async () => {
    const a = api([{ status: 'completed', jobs: [] }]);
    await suitesToSkip(a.opts);
    expect(a.calls[0]).toBe(
      `repos/${REPO}/actions/workflows/lint.yml/runs?event=pull_request&head_sha=${SHA}&per_page=20`
    );
    expect(a.calls[1]).toBe(`repos/${REPO}/actions/runs/7/jobs?filter=latest&per_page=100`);
  });

  it('ignores a listed run whose head is another commit', async () => {
    const a = api([{ status: 'completed', jobs: [done(TT, 'success')] }]);
    a.opts.fetchJson = async (path: string): Promise<unknown> =>
      path.includes('/runs?')
        ? { workflow_runs: [{ id: 7, head_sha: 'b'.repeat(40), status: 'completed' }] }
        : { jobs: [done(TT, 'success')] };
    expect((await suitesToSkip(a.opts)).skip).toEqual([]);
  });

  it.each([
    [
      'the API errors',
      async () => {
        throw new Error('HTTP 502');
      },
    ],
    [
      'a jobs response has no jobs array',
      async (p: string) =>
        p.includes('/runs?')
          ? { workflow_runs: [{ id: 1, head_sha: 'a'.repeat(40), status: 'completed' }] }
          : {},
    ],
  ])('skips nothing when %s', async (_label, fetchJson) => {
    const a = api([{ status: 'completed', jobs: [] }]);
    const r = await suitesToSkip({ ...a.opts, fetchJson });
    expect(r.skip).toEqual([]);
    expect(r.error).toBeTruthy();
  });

  it('skips nothing for a malformed SHA, without calling the API', async () => {
    const a = api([{ status: 'completed', jobs: [done(TT, 'success')] }]);
    const r = await suitesToSkip({ ...a.opts, sha: 'main' });
    expect(r.skip).toEqual([]);
    expect(a.calls).toEqual([]);
  });
});
