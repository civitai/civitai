import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { dispatchArgs } from '../ci/unit-batched.mjs';

// Guards that a COMMIT ON `main` gets a CI verdict.
//
// THE REGRESSION THIS EXISTS FOR, stated so it is not re-derived from scratch.
// Between 2026-06-14 and 2026-08-21 nothing produced a verdict for a commit on
// `main`. The cause was not a decision: `.github/workflows/pr-check.yml` carried
// the only live push-to-`main` trigger, and when #2547 deleted it ("runs in
// Tekton, removes GH Actions pr-check") that trigger went with it. Only one
// other workflow in the repo's history ever fired on a branch push to `main`,
// `docker-deploy.yml`, removed in 2023-11. Every workflow written afterwards is
// `pull_request`-only,
// so nothing rebuilt it and nothing said it was gone. A commit pushed straight to
// `main` broke the unit suite and sat undetected for ~7 hours.
//
// The old runs kept reading `success`, because those June runs really did
// succeed. "Is main green?" answered yes for two months. That is why this is a
// test and not a convention: the failure mode is a stale TRUE, which no amount of
// looking at the checks list surfaces.
//
// WHAT IS ASSERTED IS THE OUTCOME, NOT THE SPELLING. None of these name
// `lint.yml`, and none of them care which job runs what — they ask whether a
// push to `main` reaches a typecheck and the unit suite at all. Moving those
// tiers into a different workflow, renaming the jobs, or splitting the file
// keeps this green; losing main coverage does not, however it is lost.
//
// The unit suite is verified in batches, not per push (lint.yml header). The guard below asserts
// that path (a schedule within MAX_BATCH_HOURS, a dispatch that runs the suite, a job that posts
// commit statuses) instead of a push-reachable job.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(HERE, '../../.github/workflows');

type Job = {
  if?: string;
  'continue-on-error'?: boolean | string;
  steps?: Array<Record<string, unknown>>;
  [k: string]: unknown;
};
type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string };
  jobs?: Record<string, Job>;
};

function loadWorkflows(): Array<{ file: string; doc: Workflow }> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((file) => ({
      file,
      doc: parse(readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')) as Workflow,
    }));
}

/**
 * Does this workflow fire on a push to `main`?
 *
 * `on:` has three legal shapes (string, array, map) and the branch filter is
 * optional — `push:` with no `branches` fires on every branch, `main` included.
 * Getting that wrong in the permissive direction is how a guard reports covered
 * over nothing, so absence of a filter counts as covering `main` only because it
 * genuinely does.
 */
function triggersOnPushToMain(doc: Workflow): boolean {
  const on = doc.on as unknown;
  if (typeof on === 'string') return on === 'push';
  if (Array.isArray(on)) return on.includes('push');
  if (!on || typeof on !== 'object') return false;
  if (!('push' in on)) return false;
  const push = (on as Record<string, unknown>).push as { branches?: string[] } | null;
  if (push === null || push === undefined) return true;
  if (!push.branches) return true;
  return push.branches.includes('main');
}

/**
 * Is this job reachable on a push event?
 *
 * Conservative in the direction that matters: an `if` this does not understand
 * counts as reachable, so an unrecognised gate makes the coverage assertions
 * STRICTER (the job's steps get scanned for PR-only inputs), never weaker.
 */
function reachableOnPush(job: Job): boolean {
  const cond = (job.if ?? '').replace(/\s+/g, ' ');
  return !(
    cond.includes("github.event_name == 'pull_request'") ||
    cond.includes("github.event_name != 'push'")
  );
}

/**
 * Is a `continue-on-error` value one that cannot differ between a PR and a push?
 * A string that is not an expression is YAML-truthy in spirit and opaque in
 * fact — treat it as unconditional rather than guess.
 */
function unconditionallyTrue(coe: unknown): boolean {
  if (coe === undefined || coe === false) return false;
  if (coe === true) return true;
  return !(typeof coe === 'string' && coe.includes('${{'));
}

/** An `actions/cache` restore or save step. */
function isCacheStep(step: Record<string, unknown>): boolean {
  return typeof step.uses === 'string' && /^actions\/cache(\/(save|restore))?@/.test(step.uses);
}

/** Every `run:` script in a job, concatenated. */
function runScripts(job: Job): string {
  return (job.steps ?? []).map((s) => (typeof s.run === 'string' ? s.run : '')).join('\n');
}

/** A job's steps, serialised — everything EXCEPT the job-level `if`. See the seam test. */
function stepsBlob(job: Job): string {
  const { if: _ignored, ...rest } = job;
  return JSON.stringify(rest);
}

const workflows = loadWorkflows();

/** Every job reachable on a push to main, with its workflow and its `run:` scripts. */
function pushReachable() {
  return workflows
    .filter((w) => triggersOnPushToMain(w.doc))
    .flatMap((w) =>
      Object.entries(w.doc.jobs ?? {})
        .filter(([, job]) => reachableOnPush(job))
        .map(([id, job]) => ({ where: `${w.file}:${id}`, doc: w.doc, script: runScripts(job) }))
    );
}

describe('CI coverage for commits on main', () => {
  it('has at least one workflow that fires on a push to main', () => {
    const covering = workflows.filter((w) => triggersOnPushToMain(w.doc)).map((w) => w.file);
    // Named in the failure so the message is actionable rather than a bare false.
    expect(
      covering,
      `No workflow in .github/workflows fires on a push to main. Scanned: ${workflows
        .map((w) => w.file)
        .join(', ')}. This is the exact state the repo sat in from 2026-06-14 to 2026-08-21.`
    ).not.toHaveLength(0);
  });

  // The two tiers a main-only break has actually landed in. `pnpm run typecheck`
  // rather than a bare "typecheck" on purpose: `typecheck-apps.mjs` is a
  // different, narrower thing and would satisfy a looser match while the
  // whole-repo typecheck was gone.
  //
  // The app suites and the app typecheck are here because pull requests reach them through a
  // `paths:` filter (apps.yml): a PR that touches nothing they read never runs them, so the push
  // runs are the backstop for a filter entry that is missing (see the next test).
  it.each([
    ['the whole-repo typecheck', 'pnpm run typecheck'],
    // apps.yml runs vitest itself with the `Scope app suites` step's selection, which is
    // always `app:*` on a push (scripts/ci/app-suite-scope.mjs).
    ['the app suites', 'vitest run $VITEST_PROJECT_ARGS'],
    ['the app typecheck', 'scripts/ci/typecheck-apps.mjs'],
  ])('runs %s on a push to main', (_label, needle) => {
    const hit = pushReachable()
      .filter((j) => j.script.includes(needle))
      .map((j) => j.where);
    expect(
      hit,
      `Nothing reachable on a push to main runs \`${needle}\`. Push-reachable jobs: ${
        pushReachable()
          .map((j) => j.where)
          .join(', ') || '(none)'
      }`
    ).not.toHaveLength(0);
  });

  // The unit suite's verdict for `main`, batched (see the header). Each link of the chain is
  // asserted, because each one failing alone leaves `main` with no unit verdict and no red.
  describe('the unit suite, verified in batches on main', () => {
    // The contract: a commit on `main` gets a unit verdict within this many hours plus a run.
    // A tighter cron passes; a wider one is a contract change and must change this number.
    const MAX_BATCH_HOURS = 2;
    // Hours between firings of a cron that fires at a fixed minute every N hours, else null.
    const everyHours = (cron: string): number | null => {
      const m = /^\d{1,2} (\*|\*\/(\d{1,2})) \* \* \*$/.exec(cron.trim());
      if (!m) return null;
      return m[1] === '*' ? 1 : Number(m[2]);
    };
    const withinContract = (cron: string) => {
      const n = everyHours(cron);
      return n !== null && n <= MAX_BATCH_HOURS;
    };

    it.each([
      ['41 * * * *', 1],
      ['41 */2 * * *', 2],
      ['41 */3 * * *', 3],
      ['41 3 * * *', null],
      ['*/5 * * * *', null],
    ])('reads the interval of %s as %s hours', (cron, want) => {
      expect(everyHours(cron)).toBe(want);
    });
    const schedules = (doc: Workflow) =>
      (
        ((doc.on as Record<string, unknown> | undefined)?.schedule as Array<{ cron: string }>) ?? []
      ).map((s) => s.cron);

    it('a workflow fires at least every MAX_BATCH_HOURS and runs the gate that dispatches the suite', () => {
      const hit = workflows
        .filter((w) => schedules(w.doc).some(withinContract))
        .filter((w) =>
          Object.values(w.doc.jobs ?? {}).some((j) =>
            runScripts(j).includes('unit-batched.mjs gate')
          )
        )
        .map((w) => w.file);
      expect(
        hit,
        `no workflow scheduled at least every ${MAX_BATCH_HOURS} h runs \`scripts/ci/unit-batched.mjs gate\``
      ).not.toHaveLength(0);
      // The gate dispatches lint.yml with `only: unit`, the dispatch the next test checks runs it.
      expect(dispatchArgs('main', 'owner/repo')).toEqual([
        'workflow',
        'run',
        'lint.yml',
        '--repo',
        'owner/repo',
        '--ref',
        'main',
        '-f',
        'only=unit',
      ]);
    });

    it('lint.yml runs test:unit:run on a dispatch with only: unit', () => {
      const lint = workflows.find((w) => w.file === 'lint.yml')?.doc;
      expect((lint?.on as Record<string, unknown>)?.workflow_dispatch).toBeDefined();
      const runners = Object.values(lint?.jobs ?? {}).filter(
        (j) =>
          runScripts(j).includes('test:unit:run') &&
          !(j.if ?? '').includes("github.event_name == 'pull_request'") &&
          (j.if ?? '').includes("inputs.only == 'unit'")
      );
      expect(runners).not.toHaveLength(0);
    });

    it('a job after that dispatch posts the verdict as a commit status', () => {
      const lint = workflows.find((w) => w.file === 'lint.yml')?.doc;
      const posters = Object.values(lint?.jobs ?? {}).filter(
        (j) =>
          runScripts(j).includes('unit-batched.mjs verify') &&
          (j.permissions as Record<string, string> | undefined)?.statuses === 'write' &&
          !unconditionallyTrue(j['continue-on-error'])
      );
      expect(posters).not.toHaveLength(0);
      // And when that job crashes or is cancelled, it still leaves an `error` status on HEAD.
      const crashSteps = posters.flatMap((j) =>
        (j.steps ?? []).filter(
          (s) =>
            String(s.if ?? '').includes('failure()') &&
            String(s.if ?? '').includes('cancelled()') &&
            String(s.run ?? '').includes('state=error')
        )
      );
      expect(crashSteps).not.toHaveLength(0);
    });
  });

  // A push to main may skip these only where a pull request skips them too: `push:` carries no
  // filter, or exactly the PR trigger's `paths:` list (apps.yml shares it through a YAML anchor).
  // A push run is never scoped, so the next push the list matches runs every app suite and goes
  // red on a break a missing entry let through; the red lands on that later commit. A push
  // filter NARROWER than the PR's, or one on a workflow whose PRs are unfiltered, would leave a
  // change no run ever reaches, so either fails here.
  it.each([
    // apps.yml runs vitest itself with the `Scope app suites` step's selection, which is
    // always `app:*` on a push (scripts/ci/app-suite-scope.mjs).
    ['the app suites', 'vitest run $VITEST_PROJECT_ARGS'],
    ['the app typecheck', 'scripts/ci/typecheck-apps.mjs'],
  ])('runs %s on a push to main behind no filter but the PR one', (_label, needle) => {
    const hit = pushReachable()
      .filter((j) => j.script.includes(needle))
      .filter((j) => {
        const on = j.doc.on as Record<string, unknown> | undefined;
        const push = on?.push as Record<string, unknown> | null | undefined;
        const pr = on?.pull_request as Record<string, unknown> | null | undefined;
        if (!push || 'paths-ignore' in push) return !push;
        if (!('paths' in push)) return true;
        return (
          Array.isArray(push.paths) &&
          !!pr &&
          !('paths-ignore' in pr) &&
          JSON.stringify(push.paths) === JSON.stringify(pr.paths)
        );
      })
      .map((j) => j.where);
    expect(
      hit,
      `\`${needle}\` runs on a push to main only behind a filter the pull_request trigger does not share. Give push: the PR's exact paths list, or none.`
    ).not.toHaveLength(0);
  });

  // A green that has to be disbelieved is worse than no run. `continue-on-error`
  // makes the RUN report `success` while the step underneath is `failure`, which
  // is the same stale-TRUE shape as the outage this file guards — so on the push
  // path no job may be unconditionally report-only.
  //
  // A conditional value is allowed (lint.yml's geometry steps use one to stay
  // report-only on PRs and render a real verdict on push) but it must be an
  // expression, i.e. it must be able to differ between a PR and a push. Literal
  // `true` cannot.
  //
  // STEPS TOO, not just jobs. A suite folded into a shared job carries its
  // report-only flag on the step, and a step-level `continue-on-error: true` is
  // the same stale TRUE one level down: the step's own conclusion reads
  // `success` and the job stays green. Checking jobs alone would wave it through.
  // The one exemption is structural, not a name list: an `actions/cache` save is
  // best-effort infrastructure, not a verdict about the code.
  it('has no unconditionally report-only job on the push path', () => {
    const offenders = workflows
      .filter((w) => triggersOnPushToMain(w.doc))
      .flatMap((w) =>
        Object.entries(w.doc.jobs ?? {})
          .filter(([, job]) => reachableOnPush(job))
          .flatMap(([id, job]) => [
            ...(unconditionallyTrue(job['continue-on-error']) ? [`${w.file}:${id}`] : []),
            ...(job.steps ?? [])
              .filter((step) => reachableOnPush(step as Job))
              .filter((step) => !isCacheStep(step))
              .filter((step) => unconditionallyTrue(step['continue-on-error']))
              .map((step, i) => `${w.file}:${id} step "${String(step.name ?? step.uses ?? i)}"`),
          ])
      );
    expect(
      offenders,
      `These run on a push to main with \`continue-on-error: true\`, so the run reports success while the step underneath fails: ${offenders.join(
        ', '
      )}`
    ).toEqual([]);
  });

  // THE SEAM GUARD, and the one most likely to earn its keep. `github.base_ref`
  // is the EMPTY STRING on a push event and `github.event.pull_request` is null.
  // A job that consumes either as step input is a PR-shaped job; leave it
  // reachable on a push and it fails on every commit to `main` for a reason
  // unrelated to the code — which is how a permanently-red gate gets switched
  // off, taking the real coverage with it.
  //
  // The job-level `if` is deliberately exempt: a null-safe comparison there is
  // how a job decides not to run, which is the correct use. This scans the
  // steps.
  it('runs no job on the push path whose STEPS consume PR-only context', () => {
    const offenders = workflows
      .filter((w) => triggersOnPushToMain(w.doc))
      .flatMap((w) =>
        Object.entries(w.doc.jobs ?? {})
          .filter(([, job]) => reachableOnPush(job))
          .flatMap(([id, job]) => {
            const blob = stepsBlob(job);
            return ['github.base_ref', 'github.event.pull_request']
              .filter((ctx) => blob.includes(ctx))
              .map((ctx) => `${w.file}:${id} uses ${ctx}`);
          })
      );
    expect(
      offenders,
      `Gate these jobs to \`if: github.event_name == 'pull_request'\`, or give the step a push-valid base. ${offenders.join(
        '; '
      )}`
    ).toEqual([]);
  });

  // A push to main must never share a concurrency group with a PR run. A group
  // that does not vary by ref (e.g. a bare `lint`) is one group for every PR AND
  // for main, so with cancel-in-progress a PR push would cancel main's run and
  // main would sit with no verdict, the failure this file exists for.
  //
  // Keying on `github.ref` IS allowed, and is what lint.yml, apps.yml,
  // moderator-boot.yml and windows-dev-env use: one group for `main`, so per-commit
  // main runs do not pile up behind PRs under a concurrent-job limit. windows-dev-env
  // cancels the older main run; the other three queue on push (next test).
  // `github.sha` (one group per commit, nothing cancels) also passes.
  it('never lets a PR run cancel the run for a commit on main', () => {
    for (const { file, doc } of workflows) {
      if (!triggersOnPushToMain(doc)) continue;
      const group = doc.concurrency?.group;
      const cancels = doc.concurrency?.['cancel-in-progress'];
      if (group === undefined) continue; // no grouping at all: nothing cancels anything
      if (cancels === false || cancels === undefined) continue; // grouped but never cancels
      expect(
        /github\.(ref|sha)\b/.test(group),
        `${file} cancels in-progress runs and its concurrency group (${group}) varies by neither github.ref nor github.sha, so a PR run and a run for a commit on main share a group and can cancel each other.`
      ).toBe(true);
    }
  });

  // On `main` these QUEUE instead of cancelling. `main` takes pushes faster than these runs take,
  // so cancel-in-progress left most push runs `cancelled` with no verdict. PR runs still cancel
  // their PR's stale run. A literal `true` here brings the no-verdict bursts back.
  it.each(['lint.yml', 'apps.yml', 'moderator-boot.yml'])(
    '%s queues push runs on main and cancels only non-push runs',
    (file) => {
      const doc = workflows.find((w) => w.file === file)?.doc;
      expect(doc, `${file} not found`).toBeDefined();
      expect(String(doc?.concurrency?.['cancel-in-progress'] ?? '').replace(/\s+/g, ' ')).toBe(
        "${{ github.event_name != 'push' }}"
      );
    }
  );
});
