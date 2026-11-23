import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  SUITES_CONTEXT,
  decideBase,
  findRun,
  repostStatuses,
  runState,
  selectSuites,
  suiteDispatchArgs,
  verdict,
  waitDone,
} from '../ci/batch-suites.mjs';
import { filterOf } from '../ci/full-ci-paths.mjs';
import { BATCH_WORKFLOWS } from '../ci/unit-batched.mjs';

// scripts/ci/batch-suites.mjs is the only verdict the main batch's other suites get: they left
// pull requests and pushes, so a wrong answer here is a red suite nobody hears about (a green on
// a run that never happened), or a suite that silently stops running (a path filter that skips
// it on a change it reads). Each guard below is written so the mutant named in its comment
// fails it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(HERE, '../../.github/workflows');

type Job = { if?: string; name?: string; permissions?: Record<string, string>; steps?: Step[] };
type Step = { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  on?: Record<string, any>;
  concurrency?: { group?: string };
  jobs?: Record<string, Job>;
};
const load = (file: string) =>
  parse(readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')) as Workflow;

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

// The batch's path filter IS scripts/ci/full-ci-paths.mjs's `decide` (the label's dispatcher
// uses the same module): these cases go through selectSuites, so a batch that grew a matcher of
// its own and disagreed with it would fail here. Fixture patterns are the real workflows'.
describe('the paths filter, through selectSuites', () => {
  const pick = (on: unknown, files: string[]) =>
    selectSuites({ entries: [{ workflow: 'w.yml', on }], base: BASE, baseReason: 'x', files })[0];
  const pr = (paths: string[]) => ({ pull_request: { paths } });

  it('`**` crosses directories, `*` does not', () => {
    expect(pick(pr(['apps/**']), ['apps/feed-go/internal/x.go']).run).toBe(true);
    expect(pick(pr(['packages/*/package.json']), ['packages/a/package.json']).run).toBe(true);
    // Mutant: `*` compiled as `.*` would match this.
    expect(pick(pr(['packages/*/package.json']), ['packages/a/b/package.json']).run).toBe(false);
  });

  // GitHub's (and full-ci-paths.mjs's) `**/` also matches NO directory. A matcher that compiles
  // `**/` to `.*/` misses the root file and skips a suite whose input changed.
  it('`**/` matches zero directories as well as many', () => {
    expect(pick(pr(['**/package.json']), ['package.json']).run).toBe(true);
    expect(pick(pr(['**/package.json']), ['apps/a/package.json']).run).toBe(true);
    expect(pick(pr(['**/package.json']), ['apps/a/package.jsonx']).run).toBe(false);
  });

  it('dots are literal and a pattern is anchored at both ends', () => {
    expect(pick(pr(['tsconfig.json']), ['tsconfigXjson']).run).toBe(false);
    expect(pick(pr(['package.json']), ['apps/x/package.json']).run).toBe(false);
    expect(pick(pr(['apps/x']), ['apps/x/y']).run).toBe(false);
  });

  it('the last matching pattern decides, `!` negates', () => {
    expect(pick(pr(['**', '!docs/**']), ['docs/a.md']).run).toBe(false);
    expect(pick(pr(['**', '!docs/**']), ['docs/a.md', 'src/a.ts']).run).toBe(true);
    expect(pick(pr(['!docs/**', 'docs/keep.md']), ['docs/keep.md']).run).toBe(true);
  });

  it('pull_request first, then push, and no filter or an unreadable on: runs', () => {
    const both = { pull_request: { paths: ['a/**'] }, push: { paths: ['b/**'] } };
    expect(pick(both, ['b/x']).run).toBe(false);
    expect(pick({ push: { paths: ['b/**'] } }, ['b/x']).run).toBe(true);
    expect(pick({ workflow_dispatch: null }, ['z']).run).toBe(true);
    expect(pick(undefined, ['z']).run).toBe(true);
  });

  // Against the real lists: a change a suite reads runs it, one it does not read skips it.
  it.each([
    ['feed-go.yml', 'apps/feed-go/internal/feed/parse.go', true],
    ['feed-go.yml', 'packages/civitai-flipt/parity/go/x_test.go', true],
    ['feed-go.yml', 'src/pages/index.tsx', false],
    ['windows-dev-env.yml', 'pnpm-lock.yaml', true],
    ['windows-dev-env.yml', 'packages/civitai-db-schema/prisma/schema.full.prisma', true],
    ['windows-dev-env.yml', 'src/pages/index.tsx', false],
    ['moderator-boot.yml', 'apps/moderator/src/app.ts', true],
    ['moderator-boot.yml', 'src/pages/index.tsx', false],
    ['registry-adapter-image.yml', 'src/server/registry-adapter/catalog.ts', true],
    ['storage-hook-runner-image.yml', 'apps/registry-adapter/Dockerfile', false],
  ])('%s with %s changed: %s', (file, changed, want) => {
    expect(pick(load(file).on, [changed]).run).toBe(want);
  });
});

describe('decideBase: the commit the path filter compares against', () => {
  it('the newest POSTED verdict decides; an undecided run is passed over', () => {
    expect(
      decideBase([
        { sha: OTHER, state: 'error' },
        { sha: BASE, state: 'success' },
        { sha: HEAD, state: 'failure' },
      ])
    ).toEqual({ base: BASE, green: BASE, reason: 'last green batch bbbbbbbbbb' });
  });

  // Mutant: skipping a red verdict to an older green would let a red suite whose paths did not
  // change since that green stop running, and the batch would then post success over the red.
  it('a red newest verdict means no base: every suite runs', () => {
    expect(
      decideBase([
        { sha: OTHER, state: 'failure' },
        { sha: BASE, state: 'success' },
      ])
    ).toEqual({
      base: null,
      green: BASE,
      reason: 'the last batch verdict (cccccccccc) was red',
    });
  });

  // The benchmarks' base. Mutant: deriving it from `base` (null after a red) makes the allocs/op
  // gate compare HEAD^1..HEAD only, so a regression merged before the red batch is never flagged.
  it('after a red batch the benchmarks still compare against the older GREEN commit', () => {
    const got = decideBase([
      { sha: HEAD, state: 'failure' },
      { sha: OTHER, state: null },
      { sha: BASE, state: 'success' },
    ]);
    expect(got.base).toBeNull();
    expect(got.green).toBe(BASE);
  });

  it('no verdict at all means no base', () => {
    expect(decideBase([{ sha: BASE, state: null }])).toEqual({
      base: null,
      green: null,
      reason: 'no earlier batch verdict',
    });
    expect(decideBase([])).toEqual({ base: null, green: null, reason: 'no earlier batch verdict' });
    // red with no green anywhere: no benchmark base either (bench falls back and says so)
    expect(decideBase([{ sha: HEAD, state: 'failure' }]).green).toBeNull();
  });
});

describe('selectSuites', () => {
  const on = (paths: string[] | null) => (paths ? { pull_request: { paths } } : {});
  const entries = [
    { workflow: 'go.yml', on: on(['apps/go/**']) },
    { workflow: 'img.yml', on: on(['apps/img/**']) },
    { workflow: 'all.yml', on: on(null) },
  ];

  it('runs only the suites whose paths changed, and a suite with no filter always', () => {
    const got = selectSuites({ entries, base: BASE, baseReason: 'x', files: ['apps/go/main.go'] });
    expect(got.map((s) => [s.workflow, s.run])).toEqual([
      ['go.yml', true],
      ['img.yml', false],
      ['all.yml', true],
    ]);
    expect(got[1].reason).toBe('no changed file matches on.pull_request.paths (since bbbbbbbbbb)');
  });

  // Mutant: treating "no base" or "files unknown" as "nothing changed" skips every suite.
  it('no base, or files that could not all be listed: every suite runs', () => {
    for (const args of [
      { base: null, baseReason: 'no earlier batch verdict', files: ['apps/go/main.go'] },
      { base: BASE, baseReason: 'x', files: null },
    ])
      expect(selectSuites({ entries, ...args }).every((s) => s.run)).toBe(true);
    expect(selectSuites({ entries, base: null, baseReason: 'why', files: [] })[0].reason).toBe(
      'no base: why'
    );
  });

  it('carries ownContext through', () => {
    const got = selectSuites({
      entries: [{ workflow: 'apps.yml', on: on(null), ownContext: 'App tests (main batch)' }],
      base: null,
      baseReason: 'x',
      files: null,
    });
    expect(got[0].ownContext).toBe('App tests (main batch)');
  });
});

describe('suiteDispatchArgs', () => {
  it('passes batch=true and, where declared, the base', () => {
    expect(suiteDispatchArgs('feed-go.yml', load('feed-go.yml').on, 'o/r', BASE)).toEqual([
      'workflow',
      'run',
      'feed-go.yml',
      '--repo',
      'o/r',
      '--ref',
      'main',
      '-f',
      'batch=true',
      '-f',
      `base=${BASE}`,
    ]);
    // beacon-go declares no `base` input: a dispatch with one would be rejected (HTTP 422).
    expect(suiteDispatchArgs('beacon-go.yml', load('beacon-go.yml').on, 'o/r', BASE)).toEqual([
      'workflow',
      'run',
      'beacon-go.yml',
      '--repo',
      'o/r',
      '--ref',
      'main',
      '-f',
      'batch=true',
    ]);
    expect(suiteDispatchArgs('x.yml', { workflow_dispatch: null }, 'o/r', BASE)).toEqual([
      'workflow',
      'run',
      'x.yml',
      '--repo',
      'o/r',
      '--ref',
      'main',
    ]);
  });
});

describe('findRun: the batch run of a suite at this commit', () => {
  const t0 = Date.parse('2026-11-23T10:00:00Z');
  const r = (over: Record<string, unknown>) => ({
    id: 1,
    path: '.github/workflows/feed-go.yml',
    head_sha: HEAD,
    event: 'workflow_dispatch',
    actor: { login: 'github-actions[bot]' },
    created_at: '2026-11-23T10:00:10Z',
    status: 'completed',
    conclusion: 'success',
    ...over,
  });

  it('takes the newest matching run created after the dispatch', () => {
    const runs = [r({ id: 1 }), r({ id: 2, created_at: '2026-11-23T10:00:30Z' })];
    expect(findRun(runs, 'feed-go.yml', HEAD, t0)?.id).toBe(2);
  });

  // Each mutant drops one filter; the run it would then pick is the wrong one.
  it.each([
    ['another workflow', { path: '.github/workflows/beacon-go.yml' }],
    ['another commit', { head_sha: OTHER }],
    ['a push run', { event: 'push' }],
    ["a person's dispatch", { actor: { login: 'someone' } }],
    ['a dispatch from before this batch', { created_at: '2026-11-23T09:59:00Z' }],
  ])('ignores %s', (_label, over) => {
    expect(findRun([r(over)], 'feed-go.yml', HEAD, t0)).toBeNull();
  });
});

describe('runState', () => {
  it.each([
    [null, 'missing'],
    [{ status: 'in_progress', conclusion: null }, 'running'],
    [{ status: 'queued', conclusion: null }, 'running'],
    [{ status: 'completed', conclusion: 'success' }, 'green'],
    [{ status: 'completed', conclusion: 'failure' }, 'red'],
    [{ status: 'completed', conclusion: 'timed_out' }, 'red'],
    [{ status: 'completed', conclusion: 'startup_failure' }, 'red'],
    // A cancelled or skipped run is no verdict, never green.
    [{ status: 'completed', conclusion: 'cancelled' }, 'undecided'],
    [{ status: 'completed', conclusion: 'skipped' }, 'undecided'],
  ])('%j -> %s', (run, want) => {
    expect(runState(run)).toBe(want);
  });
});

describe('verdict: the Batch suites (main batch) status', () => {
  const s = (workflow: string, state: string, run = true, ownContext: string | null = null) => ({
    workflow,
    state,
    run,
    ownContext,
  });

  it('green: every dispatched suite green', () => {
    expect(
      verdict({ suites: [s('feed-go.yml', 'green'), s('ports.yml', 'skipped', false)], base: BASE })
    ).toEqual({
      state: 'success',
      description: '1 suite(s) passed at this commit; 1 unchanged since bbbbbbbbbb.',
    });
  });

  it('nothing to run since a green base is green, and says so', () => {
    expect(verdict({ suites: [s('ports.yml', 'skipped', false)], base: BASE })).toEqual({
      state: 'success',
      description: "No batch suite's paths changed since bbbbbbbbbb; all were green there.",
    });
  });

  // Mutant: letting a missing run decide first would hide the red behind an `error`.
  it('red decides over a missing verdict, and names the range start', () => {
    expect(
      verdict({
        suites: [
          s('ports.yml', 'missing'),
          s('feed-go.yml', 'red'),
          s('windows-dev-env.yml', 'red'),
        ],
        base: BASE,
      })
    ).toEqual({
      state: 'failure',
      description: 'Red, range bbbbbbbbbb..here: feed-go, windows-dev-env',
    });
    expect(verdict({ suites: [s('feed-go.yml', 'red')], base: null })).toEqual({
      state: 'failure',
      description: 'Red: feed-go',
    });
  });

  // Mutant: counting only `red` as not-green would post success over these.
  it.each(['missing', 'running', 'undecided', 'not-dispatched'])(
    'a dispatched suite left %s is no verdict (error), never green',
    (state) => {
      expect(
        verdict({ suites: [s('feed-go.yml', 'green'), s('ports.yml', state)], base: BASE })
      ).toEqual({
        state: 'error',
        description: `No verdict: ports ${state}`,
      });
    }
  );

  // A suite that posts its own status must not raise a second item for the same red.
  it('leaves a suite with its own context out', () => {
    expect(
      verdict({
        suites: [s('feed-go.yml', 'green'), s('apps.yml', 'red', true, 'App tests (main batch)')],
        base: null,
      })
    ).toEqual({ state: 'success', description: '1 suite(s) passed at this commit.' });
  });

  it('keeps the description within the 140 characters GitHub accepts', () => {
    const many = Array.from({ length: 20 }, (_, i) => s(`suite-number-${i}.yml`, 'red'));
    expect(verdict({ suites: many, base: BASE }).description.length).toBeLessThanOrEqual(140);
  });
});

describe('waitDone', () => {
  const s = (state: string, run = true, ownContext: string | null = null) => ({
    state,
    run,
    ownContext,
  });
  it('waits for every dispatched run to finish', () => {
    expect(waitDone({ suites: [s('green'), s('running')], postedContexts: new Set() })).toBe(false);
    expect(waitDone({ suites: [s('green'), s('missing')], postedContexts: new Set() })).toBe(false);
    expect(
      waitDone({
        suites: [s('green'), s('skipped', false), s('not-dispatched')],
        postedContexts: new Set(),
      })
    ).toBe(true);
  });
  // Mutant: not waiting for an own context lets the lint run complete before that status lands,
  // and the status is then never read with this batch run.
  it('waits for an own context to be posted after its run finished', () => {
    const own = [s('red', true, 'App tests (main batch)')];
    expect(waitDone({ suites: own, postedContexts: new Set() })).toBe(false);
    expect(waitDone({ suites: own, postedContexts: new Set(['App tests (main batch)']) })).toBe(
      true
    );
  });
});

// An own-context verdict (apps.yml's `App tests (main batch)`) is posted from its own run; the
// batch re-posts it with the lint batch run as its target_url, so a reader that lists lint batch
// runs and keeps statuses naming THAT run finds it (lint.yml's header, the status contract).
describe('repostStatuses', () => {
  const RUN = 'https://github.com/o/r/actions/runs/500';
  const APPS = 'https://github.com/o/r/actions/runs/777';
  const CTX = 'App tests (main batch)';
  const suite = (over: Record<string, unknown> = {}) => ({
    workflow: 'apps.yml',
    ownContext: CTX,
    run: true,
    state: 'green',
    ...over,
  });
  const st = (state: string, target_url: string, description = `d-${state}`) => ({
    context: CTX,
    state,
    target_url,
    description,
  });

  // Mutant: re-post the OLDEST status (or drop the state) and the bisected red's HEAD line is lost.
  it('re-posts the newest own-context verdict, state and description unchanged', () => {
    expect(
      repostStatuses({
        suites: [suite()],
        statuses: [
          st('failure', APPS, 'Failing since first bad commit cccccccccc: apps/a.test.ts'),
          st('error', APPS),
        ],
        runUrl: RUN,
      })
    ).toEqual([
      {
        context: CTX,
        state: 'failure',
        description: 'Failing since first bad commit cccccccccc: apps/a.test.ts',
      },
    ]);
  });

  it('does not re-post one that already names this run, nor a pending one, nor none', () => {
    expect(
      repostStatuses({ suites: [suite()], statuses: [st('success', `${RUN}/`)], runUrl: RUN })
    ).toEqual([]);
    expect(
      repostStatuses({ suites: [suite()], statuses: [st('pending', APPS)], runUrl: RUN })
    ).toEqual([]);
    expect(repostStatuses({ suites: [suite()], statuses: [], runUrl: RUN })).toEqual([]);
  });

  // A suite not dispatched at this commit (paths unchanged) gets nothing re-posted: an older
  // status in that context on this commit, if any, is not this batch's.
  it('only for dispatched suites that have an own context', () => {
    const statuses = [st('success', APPS)];
    expect(repostStatuses({ suites: [suite({ run: false })], statuses, runUrl: RUN })).toEqual([]);
    expect(
      repostStatuses({ suites: [suite({ state: 'not-dispatched' })], statuses, runUrl: RUN })
    ).toEqual([]);
    expect(
      repostStatuses({ suites: [suite({ ownContext: null })], statuses, runUrl: RUN })
    ).toEqual([]);
  });
});

// ── THE SEAM: the list, the workflows it dispatches, and the lint.yml job that runs it ────────
describe('the batch workflows and lint.yml', () => {
  // Ledger: every workflow the batch dispatches, and every job in it with its exact `if`. A job
  // added to one of them, or a gate changed, fails here so its author decides where it runs.
  const PR_GATE =
    "(github.event_name != 'pull_request' || !github.event.pull_request.draft || contains(github.event.pull_request.labels.*.name, 'full-ci')) && !inputs.batch";
  const DISPATCH = "github.event_name == 'workflow_dispatch'";
  const NOT_PR = "github.event_name != 'pull_request'";
  const go = (extra: Record<string, string> = {}) => ({
    test: PR_GATE,
    lint: PR_GATE,
    vuln: DISPATCH,
    mod: DISPATCH,
    fuzz: DISPATCH,
    ...extra,
  });
  const LEDGER: Record<string, Record<string, string>> = {
    'moderator-boot.yml': { boot: NOT_PR },
    'ports.yml': { manifest: DISPATCH, touched: "github.event_name == 'pull_request'" },
    'registry-adapter-image.yml': { image: NOT_PR },
    'storage-hook-runner-image.yml': { image: NOT_PR },
    'windows-dev-env.yml': { smoke: DISPATCH },
    'feed-go.yml': go({ 'flipt-parity': PR_GATE, bench: DISPATCH }),
    'beacon-go.yml': go(),
    'app-index-go.yml': go(),
    'app-data-go.yml': go(),
    'content-policy-go.yml': go(),
  };

  it('dispatches exactly the ledger workflows', () => {
    expect(
      BATCH_WORKFLOWS.filter((b) => !b.ownContext)
        .map((b) => b.workflow)
        .sort()
    ).toEqual(Object.keys(LEDGER).sort());
  });

  it.each(Object.entries(LEDGER))('%s: every job and its gate', (file, jobs) => {
    const doc = load(file);
    const got = Object.fromEntries(
      Object.entries(doc.jobs ?? {}).map(([id, j]) => [
        id,
        (j.if ?? '').replace(/\s+/g, ' ').trim(),
      ])
    );
    expect(got).toEqual(jobs);
  });

  it.each(BATCH_WORKFLOWS.map((b) => b.workflow))(
    '%s takes a boolean `batch` input, and keys a batch run its own concurrency group',
    (file) => {
      const doc = load(file);
      expect(doc.on?.workflow_dispatch?.inputs?.batch?.type).toBe('boolean');
      // A hand dispatch on main shares `dispatch-<ref>` and cancels in progress: a batch run in
      // that group would be cancelled with no verdict.
      expect(doc.concurrency?.group).toContain(
        "github.event_name == 'workflow_dispatch' && inputs.batch && format('batch-{0}', github.run_id)"
      );
    }
  );

  // A workflow with no paths filter would run on EVERY batch; each one here has one on purpose.
  it.each(BATCH_WORKFLOWS.map((b) => b.workflow))(
    '%s has a paths filter the batch reads',
    (file) => {
      const { filter } = filterOf(load(file).on);
      expect(filter?.paths?.length ?? 0).toBeGreaterThan(0);
    }
  );

  // The batch covers main, so a push run would build the same commits twice. Windows keeps a
  // push trigger whose job skips on it, only to hold its paths list (pinned by the ledger above).
  it('no batch-only workflow has a push trigger, except Windows for its paths list', () => {
    for (const f of [
      'moderator-boot.yml',
      'ports.yml',
      'registry-adapter-image.yml',
      'storage-hook-runner-image.yml',
    ])
      expect('push' in (load(f).on ?? {}), f).toBe(false);
    expect(load('windows-dev-env.yml').jobs?.smoke?.if).toBe(
      "github.event_name == 'workflow_dispatch'"
    );
  });

  describe('lint.yml `batch-suites`', () => {
    const lint = load('lint.yml');
    const job = lint.jobs?.['batch-suites'];

    it('runs only on the bot batch dispatch on main, beside `unit`', () => {
      expect((job?.if ?? '').replace(/\s+/g, ' ')).toBe(
        "${{ github.event_name == 'workflow_dispatch' && github.actor == 'github-actions[bot]' && inputs.only == 'unit' && github.ref == 'refs/heads/main' }}"
      );
      expect((job as Record<string, unknown>)?.needs).toBeUndefined();
    });

    it('may dispatch and post statuses, nothing else', () => {
      expect(job?.permissions).toEqual({ actions: 'write', contents: 'read', statuses: 'write' });
    });

    // A module the script imports but the sparse checkout leaves out fails the job at load time.
    it('checks out the script and every module it imports', () => {
      const co = (job?.steps ?? []).find((st) =>
        String((st as Record<string, unknown>).uses ?? '').startsWith('actions/checkout@')
      ) as Record<string, any> | undefined;
      const listed = String(co?.with?.['sparse-checkout'] ?? '');
      const src = readFileSync(path.resolve(HERE, '../ci/batch-suites.mjs'), 'utf8');
      const imports = [...src.matchAll(/from '\.\/([\w.-]+\.mjs)'/g)].map(
        (x) => `scripts/ci/${x[1]}`
      );
      expect(imports.sort()).toEqual([
        'scripts/ci/full-ci-paths.mjs',
        'scripts/ci/unit-batched.mjs',
      ]);
      for (const f of ['scripts/ci/batch-suites.mjs', ...imports, '.github/workflows/'])
        expect(listed, f).toContain(f);
    });

    it('runs the script, and posts error under the same context when it crashes', () => {
      const runs = (job?.steps ?? []).map((s) => s.run ?? '').join('\n');
      expect(runs).toContain('node scripts/ci/batch-suites.mjs run');
      const crash = (job?.steps ?? []).find(
        (s) => (s.if ?? '').includes('failure()') && (s.if ?? '').includes('cancelled()')
      );
      expect(crash?.run).toContain('state=error');
      expect(crash?.run).toContain(`context=${SUITES_CONTEXT}`);
    });

    // The bisect's base and the unit gate read the lint batch runs' job list by name.
    it('is not named like a unit job', () => {
      expect(job?.name).toBe('Batch suites verified (main batch)');
    });
  });
});
