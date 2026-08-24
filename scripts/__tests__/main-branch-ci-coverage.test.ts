import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

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
  it.each([
    ['the whole-repo typecheck', 'pnpm run typecheck'],
    ['the unit suite', 'test:unit:run'],
  ])('runs %s on a push to main', (_label, needle) => {
    const reached = workflows
      .filter((w) => triggersOnPushToMain(w.doc))
      .flatMap((w) =>
        Object.entries(w.doc.jobs ?? {})
          .filter(([, job]) => reachableOnPush(job))
          .map(([id, job]) => ({ where: `${w.file}:${id}`, script: runScripts(job) }))
      );
    const hit = reached.filter((j) => j.script.includes(needle)).map((j) => j.where);
    expect(
      hit,
      `Nothing reachable on a push to main runs \`${needle}\`. Push-reachable jobs: ${
        reached.map((j) => j.where).join(', ') || '(none)'
      }`
    ).not.toHaveLength(0);
  });

  // A green that has to be disbelieved is worse than no run. `continue-on-error`
  // makes the RUN report `success` while the step underneath is `failure`, which
  // is the same stale-TRUE shape as the outage this file guards — so on the push
  // path no job may be unconditionally report-only.
  //
  // A conditional value is allowed (that is how the unit tier stays report-only
  // on PRs, a separate and deliberately-unmade decision) but it must be an
  // expression, i.e. it must be able to differ between a PR and a push. Literal
  // `true` cannot.
  it('has no unconditionally report-only job on the push path', () => {
    const offenders = workflows
      .filter((w) => triggersOnPushToMain(w.doc))
      .flatMap((w) =>
        Object.entries(w.doc.jobs ?? {})
          .filter(([, job]) => reachableOnPush(job))
          .filter(([, job]) => {
            const coe = job['continue-on-error'];
            if (coe === undefined || coe === false) return false;
            if (coe === true) return true;
            // A string that is not an expression is YAML-truthy in spirit and
            // opaque in fact — treat it as an offender rather than guess.
            return !(typeof coe === 'string' && coe.includes('${{'));
          })
          .map(([id]) => `${w.file}:${id}`)
      );
    expect(
      offenders,
      `These jobs run on a push to main with \`continue-on-error: true\`, so the run reports success while the step underneath fails: ${offenders.join(
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

  // Every commit on main must get its OWN verdict. A concurrency group keyed on
  // `github.ref` is one group for the whole branch, so a busy main cancels its
  // own runs and only the last commit is ever checked — and the losers render as
  // `cancelled`, which this repo already cannot distinguish from a real failure.
  //
  // This asserts the group VARIES per commit, the only property that matters;
  // `github.sha` is the way to say that in a GitHub expression.
  it('gives each commit on main its own concurrency group', () => {
    for (const { file, doc } of workflows) {
      if (!triggersOnPushToMain(doc)) continue;
      const group = doc.concurrency?.group;
      const cancels = doc.concurrency?.['cancel-in-progress'];
      if (group === undefined) continue; // no grouping at all: nothing cancels anything
      if (cancels === false || cancels === undefined) continue; // grouped but never cancels
      expect(
        group,
        `${file} cancels in-progress runs and its concurrency group does not vary per commit, so commits on main would cancel each other and only the last would be checked.`
      ).toContain('github.sha');
    }
  });
});
