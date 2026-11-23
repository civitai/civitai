import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

import { classifyUnitJobs } from '../ci/full-ci-unit-shards.mjs';
import { SUITES } from '../ci/lint-dispatch-passed.mjs';
import { dispatchArgs } from '../ci/unit-batched.mjs';

// The `full-ci` PR label: lint.yml, apps.yml and moderator-boot.yml read it on every PR run, and
// full-ci.yml dispatches all three when it is added.
//
// INVARIANT GUARD, not a regression test. It pins the shape of the change that added the label;
// the behaviour behind that shape was proven on a live throwaway PR when it shipped (see the PR
// that added this file): another label started only the dispatcher's one skipped check and no
// Lint or App suites run; `full-ci` dispatched both, with all four unit shards; a later push ran
// the shards in the PR run; removing the label went back to ESLint only on a draft.
//
// The shape matters because the obvious alternative was built first and was wrong: `labeled` in
// lint.yml / apps.yml makes EVERY label start a run whose skipped jobs carry the same names as
// the real ones and overlay their results in `gh pr checks` (full-ci.yml's header has the
// measurement). Nothing turns red when someone re-adds `labeled` there, so this test does.
//
// Clauses are pinned as whole normalised strings, and as top-level AND conjuncts of the job's
// `if`: a clause that sits inside an `||` gates nothing.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(HERE, '../../.github/workflows');

const FULL = "contains(github.event.pull_request.labels.*.name, 'full-ci')";
const DRAFT_GATE = `(github.event_name != 'pull_request' || !github.event.pull_request.draft || ${FULL})`;
const UNIT_PR_GATE = `(github.event_name != 'pull_request' || ${FULL})`;
const DISPATCH_IF =
  "github.event.label.name == 'full-ci' && github.event.pull_request.head.repo.full_name == github.repository";

type Step = {
  name?: string;
  if?: string;
  'continue-on-error'?: boolean | string;
  run?: string;
  uses?: string;
  with?: Record<string, string | boolean>;
  env?: Record<string, string>;
};
type Job = {
  name?: string;
  if?: string;
  'continue-on-error'?: boolean | string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: (Step & { id?: string })[];
};
type Workflow = {
  on?: Record<string, { types?: string[] } | null>;
  jobs?: Record<string, Job>;
};

function load(file: string): Workflow {
  return parse(readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')) as Workflow;
}

/** Strip a `${{ }}` wrapper and collapse whitespace. */
function norm(expr: string): string {
  return expr
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove one pair of parentheses that wraps the WHOLE expression, if there is one. */
function unwrap(expr: string): string {
  if (!expr.startsWith('(') || !expr.endsWith(')')) return expr;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') depth--;
    if (depth === 0 && i < expr.length - 1) return expr; // the first paren closes early
  }
  return expr.slice(1, -1).trim();
}

/** Split on `op` at paren depth 0 (quotes respected). One part when `op` is not top-level. */
function splitTop(expr: string, op: '&&' | '||'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

/**
 * The top-level AND conjuncts of a job's `if`. An `if` with a top-level `||` is one conjunct,
 * wrapped in parentheses, so it can only match a clause that is itself the whole `if`.
 */
function conjuncts(ifExpr: string): string[] {
  const e = unwrap(norm(ifExpr));
  if (splitTop(e, '||').length > 1) return [`(${e})`];
  return splitTop(e, '&&');
}

describe('the full-ci label', () => {
  // The masking hazard: a `labeled` trigger here means every label starts a run of same-named
  // skipped jobs.
  it.each(['lint.yml', 'apps.yml', 'moderator-boot.yml'])(
    '%s does not fire on labeled events',
    (file) => {
      const types = load(file).on?.pull_request?.types;
      expect(types, `${file} must list its pull_request types explicitly`).toBeDefined();
      expect(types).not.toContain('labeled');
    }
  );

  it('lint.yml runs the unit job on a PR only when it has the label', () => {
    expect(conjuncts(load('lint.yml').jobs?.unit?.if ?? '')).toContain(UNIT_PR_GATE);
  });

  // The label lifts the draft gate on every job that has one. `eslint` has none (it runs on
  // drafts already) and `unit` is gated by UNIT_PR_GATE, which implies it.
  it.each([
    ['lint.yml', 'typecheck'],
    ['lint.yml', 'typecheck-tests'],
    ['lint.yml', 'packages'],
    ['lint.yml', 'component'],
    ['lint.yml', 'component-ledger'],
    ['apps.yml', 'apps'],
    ['apps.yml', 'apps-typecheck'],
    ['moderator-boot.yml', 'boot'],
  ])('%s:%s runs on a labeled draft', (file, id) => {
    expect(conjuncts(load(file).jobs?.[id]?.if ?? '')).toContain(DRAFT_GATE);
  });

  // apps-ledger takes no draft gate of its own: it follows the shards, so it can never run over
  // skipped shards (and go red) when their gate changes. Pinned whole, so a copied gate added back
  // fails here.
  it('apps.yml:apps-ledger runs exactly when the shards ran', () => {
    expect(conjuncts(load('apps.yml').jobs?.['apps-ledger']?.if ?? '')).toEqual([
      '!cancelled()',
      "needs.apps.result != 'skipped'",
    ]);
  });

  // Ledger: the job set the assertions above were written against. A new job fails here so its
  // author decides which draft gate it takes.
  it.each([
    [
      'lint.yml',
      [
        'component',
        'component-ledger',
        'eslint',
        'full-ci-done',
        'packages',
        'passed',
        'typecheck',
        'typecheck-tests',
        'unit',
        'unit-verify',
      ],
    ],
    ['apps.yml', ['apps', 'apps-ledger', 'apps-typecheck']],
    ['moderator-boot.yml', ['boot']],
  ])('%s has exactly the jobs this guard was written for', (file, ids) => {
    expect(Object.keys(load(file).jobs ?? {}).sort()).toEqual(ids);
  });

  // typecheck-tests must also run on push to `main`: skipping it lets type errors from draft and
  // red-merged PRs land unmeasured. The whole conjunct set is pinned, so any event-excluding clause
  // added back fails here.
  it('lint.yml runs typecheck-tests on push to main, with only the draft and dispatch gates', () => {
    const doc = load('lint.yml');
    expect((doc.on?.push as { branches?: string[] } | null)?.branches).toContain('main');
    expect(conjuncts(doc.jobs?.['typecheck-tests']?.if ?? '')).toEqual([
      '!cancelled()',
      DRAFT_GATE,
      "(!inputs.only || inputs.only == 'all' || inputs.only == 'typecheck-tests')",
      "needs.passed.outputs.typecheck_tests != 'true'",
    ]);
  });

  // The `passed` job runs only on a full-ci dispatch, so on every PR and push it is SKIPPED, and
  // a job that needs a skipped job is skipped too unless its `if` has a status function. Drop
  // `!cancelled()` from one of these and that suite silently stops running on every PR and on
  // `main`, with nothing red.
  describe('lint.yml, jobs gated on `passed`', () => {
    const jobs = load('lint.yml').jobs ?? {};
    const needsPassed = Object.entries(jobs).filter(([, j]) =>
      ([] as string[]).concat(j.needs ?? []).includes('passed')
    );

    it('`passed` itself runs only on a skip_passed dispatch', () => {
      expect(conjuncts(jobs.passed?.if ?? '')).toEqual([
        "github.event_name == 'workflow_dispatch'",
        'inputs.skip_passed',
      ]);
    });

    it('is exactly the suites the PR run also runs', () => {
      expect(needsPassed.map(([id]) => id).sort()).toEqual([
        'component',
        'component-ledger',
        'packages',
        'typecheck-tests',
      ]);
    });

    it.each(needsPassed.map(([id]) => id))('%s still runs when `passed` is skipped', (id) => {
      expect(conjuncts(jobs[id]?.if ?? '')[0]).toBe('!cancelled()');
    });

    // Each consumer skips on its own output. A clause dropped from one `if` reruns that suite on
    // every full-ci dispatch, with nothing red.
    it.each([
      ['typecheck-tests', "needs.passed.outputs.typecheck_tests != 'true'"],
      ['packages', "needs.passed.outputs.packages != 'true'"],
      ['component-ledger', "needs.passed.outputs.component != 'true'"],
      // The shard job still runs shard 1 for geometry; it skips only when that is all it had.
      ['component', "(inputs.only != 'component' || needs.passed.outputs.component != 'true')"],
    ])('%s skips on its `passed` output', (id, clause) => {
      expect(conjuncts(jobs[id]?.if ?? ''), `${id}: missing conjunct ${clause}`).toContain(clause);
    });

    // A passed component suite collapses the shard matrix to shard 1, which runs geometry alone:
    // the component step is off (SUITE_COMPONENT) and geometry is not (SUITE_GEOMETRY).
    it('component collapses to shard 1, geometry only, when the component suite passed', () => {
      const comp = jobs.component ?? {};
      const expr = norm(String(comp.strategy?.matrix?.shard ?? ''));
      const [collapse, full] = splitTop(expr, '||').length === 2 ? splitTop(expr, '||') : [];
      const [cond, value] = splitTop(collapse ?? '', '&&');
      expect(value, 'the collapsed matrix must be [1]').toBe("fromJSON('[1]')");
      expect(full, 'the full matrix must be [1, 2, 3]').toBe("fromJSON('[1, 2, 3]')");
      expect(
        splitTop(unwrap(cond ?? ''), '||'),
        'the matrix must collapse when the component suite passed'
      ).toContain("needs.passed.outputs.component == 'true'");
      expect(
        conjuncts(comp.env?.SUITE_COMPONENT ?? ''),
        'SUITE_COMPONENT must be off when the component suite passed'
      ).toContain("needs.passed.outputs.component != 'true'");
      expect(comp.env?.SUITE_GEOMETRY ?? '', 'geometry must not depend on `passed`').not.toMatch(
        /needs\.passed/
      );
    });

    // scripts/ci/lint-dispatch-passed.mjs names the PR run's jobs and the outputs; this file is
    // what those names refer to. A renamed job or a drifted output never matches, the suite always
    // runs, and the script's own tests stay green, so the relationship is pinned here.
    it('`passed` outputs exactly the SUITES keys, each from the script step', () => {
      const outputs = jobs.passed?.outputs ?? {};
      expect(Object.keys(outputs).sort(), '`passed` outputs vs SUITES keys').toEqual(
        Object.keys(SUITES).sort()
      );
      for (const k of Object.keys(outputs))
        expect(outputs[k], `output ${k}`).toBe(`\${{ steps.find.outputs.${k} }}`);
      const find = (jobs.passed?.steps ?? []).find((s) => s.id === 'find');
      expect(find?.run).toBe('node scripts/ci/lint-dispatch-passed.mjs');
    });

    /** A job's check names: `${{ matrix.<k> }}` in its name expanded over the FULL matrix. */
    function checkNames(job: Job): string[] {
      const name = job.name ?? '';
      const m = /\$\{\{\s*matrix\.(\w+)\s*\}\}/.exec(name);
      if (!m) return [name];
      const raw = job.strategy?.matrix?.[m[1]];
      let values: unknown[] = [];
      if (Array.isArray(raw)) values = raw;
      else {
        // An expression: its last `||` alternative is the full list.
        const parts = splitTop(norm(String(raw ?? '')), '||');
        const lit = /^fromJSON\('(.*)'\)$/.exec(parts[parts.length - 1] ?? '');
        if (lit) values = JSON.parse(lit[1]) as unknown[];
      }
      return values.map((v) => name.replace(m[0], String(v)));
    }

    it.each(Object.keys(SUITES))(
      'SUITES.%s names exactly the check names of the jobs that skip on it',
      (suite) => {
        const re = new RegExp(`needs\\.passed\\.outputs\\.${suite}\\b`);
        const consumers = needsPassed.filter(([, j]) => re.test(JSON.stringify(j)));
        expect(consumers.length, `no job reads needs.passed.outputs.${suite}`).toBeGreaterThan(0);
        const names = consumers.flatMap(([, j]) => checkNames(j)).sort();
        expect(
          [...SUITES[suite as keyof typeof SUITES]].sort(),
          `SUITES.${suite} vs lint.yml`
        ).toEqual(names);
      }
    );
  });

  // A person removing the label by hand fires `unlabeled` with their own token, which starts
  // runs (the `full-ci-done` job's removal uses GITHUB_TOKEN, whose events start none). A
  // workflow on `unlabeled` would then start a run whose skipped jobs overlay the PR's real
  // checks under the same names, the hazard full-ci.yml's header measured for `labeled`. Every
  // workflow file, not just the ones that read the label.
  it('no workflow fires on unlabeled', () => {
    const listeners = readdirSync(WORKFLOW_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .filter((f) =>
        ['pull_request', 'pull_request_target'].some((ev) =>
          (load(f).on?.[ev]?.types ?? []).includes('unlabeled')
        )
      );
    expect(listeners).toEqual([]);
  });

  // The label stays on until the full unit suite has passed once on the PR. lint.yml's
  // `full-ci-done` removes it after a run whose six shards all passed: a PR run carrying the
  // label from this repo, or a dispatch that names the PR (`pr`, which only full-ci.yml passes).
  describe('lint.yml, `full-ci-done` removes the label after a passing full unit run', () => {
    const doc = load('lint.yml');
    const job = doc.jobs?.['full-ci-done'] ?? {};
    const c = conjuncts(job.if ?? '');
    const SUCCESS = "needs.unit.result == 'success'";
    const FULL_RUN =
      "(github.event_name == 'pull_request' || inputs.only == 'all' || inputs.only == 'unit')";
    const PR_ALT = `(github.event_name == 'pull_request' && ${FULL} && github.event.pull_request.head.repo.full_name == github.repository)`;
    const DISPATCH_ALT = "(github.event_name == 'workflow_dispatch' && inputs.pr != '')";
    const who = splitTop(unwrap(c[2] ?? ''), '||');

    it('needs unit and runs only when it succeeded', () => {
      expect(([] as string[]).concat(job.needs ?? [])).toEqual(['unit']);
      expect(c[0], 'the first conjunct must require a unit success').toBe(SUCCESS);
      expect(norm(job.if ?? ''), 'no status function may widen it past success').not.toMatch(
        /always\(\)|cancelled\(\)|failure\(\)/
      );
    });

    // `needs.unit.result == 'success'` means "the suite passed" only while `unit` is fail-closed:
    // a `continue-on-error` job or test step would read success over a red suite, and a matrix
    // that runs fewer than six shards on a full run would be a partial pass. These pin that.
    it('relies on a fail-closed `unit`: no continue-on-error on the job', () => {
      expect(doc.jobs?.unit?.['continue-on-error']).toBeUndefined();
    });

    // `Upload test timings` is telemetry for an external reader, and `Upload memory samples` a
    // diagnostic artifact: their failure says nothing about the suite, and must not red a passing
    // shard (unit-verify would post a false `failure`).
    it('relies on a fail-closed `unit`: continue-on-error only on the named cache-save and telemetry steps', () => {
      const lenient = (doc.jobs?.unit?.steps ?? [])
        .filter((st) => st['continue-on-error'] !== undefined && st['continue-on-error'] !== false)
        .map((st) => st.name ?? st.uses ?? '(unnamed)');
      expect(lenient).toEqual([
        'Upload memory samples',
        'Upload test timings',
        'Save Vite pre-bundle cache',
      ]);
    });

    // Evaluate the matrix expression for every `only` a full run can have.
    it('relies on a full `unit` matrix: [1, 2, 3, 4, 5, 6] when only is unset, all or unit', () => {
      const expr = norm(String(doc.jobs?.unit?.strategy?.matrix?.shard ?? ''));
      const m =
        /^fromJSON\('(\{.*\})'\)\[inputs\.only \|\| 'all'\] \|\| fromJSON\('(\[.*\])'\)$/.exec(
          expr
        );
      expect(m, `unrecognised shard expression: ${expr}`).not.toBeNull();
      const perOnly = JSON.parse(m?.[1] ?? '{}') as Record<string, number[]>;
      const fallback = JSON.parse(m?.[2] ?? '[]') as number[];
      const shards = (only: string | undefined) => perOnly[only || 'all'] || fallback;
      for (const only of [undefined, '', 'all', 'unit'])
        expect(shards(only), `only=${only}`).toEqual([1, 2, 3, 4, 5, 6]);
    });

    // `only: unit-<n>` runs one shard; its success says nothing about the other three.
    it('only after a full run of all six shards', () => {
      expect(c[1], 'the second conjunct must exclude single-shard dispatches').toBe(FULL_RUN);
    });

    it('on a PR, only with the label and from a branch in this repo', () => {
      expect(who[0], 'the pull_request alternative').toBe(PR_ALT);
    });

    // The batch verification on `main` and a hand dispatch pass no `pr`, so they remove nothing.
    it('on a dispatch, only when `pr` names the PR', () => {
      expect(who[1], 'the workflow_dispatch alternative').toBe(DISPATCH_ALT);
      expect(who).toHaveLength(2);
      expect(c).toHaveLength(3);
      expect(dispatchArgs('main', 'o/r').some((a) => a.startsWith('pr='))).toBe(false);
    });

    it('`pr` is an optional dispatch input outside the concurrency group', () => {
      const inputs = (
        (doc.on as Record<string, unknown> | undefined)?.workflow_dispatch as
          | { inputs?: Record<string, { required?: boolean; default?: unknown }> }
          | undefined
      )?.inputs;
      expect(inputs?.pr?.required).toBe(false);
      expect(inputs?.pr?.default).toBe('');
      const raw = parse(readFileSync(path.join(WORKFLOW_DIR, 'lint.yml'), 'utf8')) as {
        concurrency?: { group?: string };
      };
      expect(raw.concurrency?.group ?? '').not.toMatch(/inputs\.pr\b/);
    });

    it('is the only job in lint.yml that may edit pull requests', () => {
      expect(job.permissions).toEqual({ 'pull-requests': 'write' });
      const writers = Object.entries(doc.jobs ?? {})
        .filter(([, j]) => j.permissions?.['pull-requests'] === 'write')
        .map(([id]) => id);
      expect(writers).toEqual(['full-ci-done']);
    });

    it('warns instead of failing, treats 404 as already gone, and says how to re-ask', () => {
      const step = (job.steps ?? []).find((st) => (st.run ?? '').includes('labels/full-ci'));
      const run = step?.run ?? '';
      expect(run).toContain(
        'if out=$(gh api -X DELETE "repos/$REPO/issues/$PR/labels/full-ci" 2>&1); then'
      );
      expect(run).toContain('elif grep -q \'HTTP 404\' <<< "$out"; then');
      expect(run).toContain('::warning title=full-ci label not removed::');
      expect(run).toMatch(/--add-label full-ci/);
      expect(step?.['continue-on-error']).toBeUndefined();
      expect(run).not.toContain('${{');
      expect(step?.env?.PR).toBe('${{ github.event.pull_request.number || inputs.pr }}');
    });

    // On a dispatch `pr` is free text: it must be a number naming an open PR whose head is the
    // dispatched branch in this repo, checked before the DELETE.
    it("checks a dispatch's `pr` against the branch before removing anything", () => {
      const run =
        (job.steps ?? []).find((st) => (st.run ?? '').includes('labels/full-ci'))?.run ?? '';
      const check = 'if [ "$head" != "open $REPO $GITHUB_REF_NAME" ]; then';
      expect(run).toContain('if ! [[ "$PR" =~ ^[0-9]+$ ]]; then');
      expect(run).toContain(check);
      expect(run.indexOf(check)).toBeLessThan(run.indexOf('gh api -X DELETE'));
    });
  });

  describe('full-ci.yml, the dispatcher', () => {
    const doc = load('full-ci.yml');
    const jobs = Object.values(doc.jobs ?? {});

    it('fires on pull_request labeled events and nothing else', () => {
      expect(Object.keys(doc.on ?? {})).toEqual(['pull_request']);
      expect(doc.on?.pull_request?.types).toEqual(['labeled']);
    });

    // One job, named so that its skipped check-run (every other label) overlays nothing.
    it('has one job, gated on the label name and on a same-repo PR', () => {
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('Start full CI on label');
      expect(norm(jobs[0].if ?? '')).toBe(DISPATCH_IF);
      // No `pull-requests: write`: this job no longer removes the label (lint.yml does).
      expect(jobs[0].permissions).toEqual({ actions: 'write', contents: 'read' });
    });

    // Script injection: the branch name is attacker-chosen text. It must reach the shell as an
    // env var, and no `run:` may interpolate any `${{ }}` at all.
    it('passes the head ref through env, and interpolates nothing into a script', () => {
      const steps = jobs[0].steps ?? [];
      const runs = steps.filter((s) => typeof s.run === 'string');
      expect(runs.length).toBeGreaterThan(0);
      for (const s of runs) expect(s.run).not.toContain('${{');
      const dispatching = runs.filter((s) => /gh workflow run lint\.yml/.test(s.run ?? ''));
      expect(dispatching).toHaveLength(1);
      const step = dispatching[0];
      expect(step.env?.HEAD_REF).toBe('${{ github.event.pull_request.head.ref }}');
      // `pr`: lint.yml's `full-ci-done` removes this PR's label once the dispatch's shards pass.
      expect(step.run).toContain(
        'gh workflow run lint.yml -R "$REPO" --ref "$HEAD_REF" -f only=all -f skip_passed=true -f pr="$PR"'
      );
      expect(step.env?.PR).toBe('${{ github.event.pull_request.number }}');
      // A continue-on-error dispatch step would read green after failing to start anything.
      expect(step['continue-on-error']).toBeUndefined();
    });

    // Lint is always dispatched; the nine other draft-gated workflows only on a draft PR. On a
    // ready PR their own PR runs on the commit are not draft-gated, so dispatching them only ran
    // them again, unfiltered. Before, all nine were dispatched on every labelled PR.
    describe('the other workflows', () => {
      const step = (jobs[0].steps ?? []).find((s) => /gh workflow run lint\.yml/.test(s.run ?? ''));
      const run = step?.run ?? '';

      it('are dispatched by name only from a loop that skips on a skip verdict first', () => {
        expect(run).not.toMatch(/gh workflow run (?!lint\.yml)[\w.-]+\.yml/);
        const loop =
          /for wf in "\$\{others\[@\]\}"; do\s+if \[ "\$\{verdict\[\$wf\]\}" = skip \]; then\s+echo [^\n]*\n\s+continue\n/;
        const at = run.search(loop);
        expect(at, 'no dispatch loop that skips on a skip verdict first').toBeGreaterThan(-1);
        const dispatches = [...run.matchAll(/gh workflow run "\$wf"/g)].map((m) => m.index ?? -1);
        expect(dispatches.length).toBeGreaterThan(0);
        for (const i of dispatches) expect(i).toBeGreaterThan(at);
      });

      // Runs the step itself, with a stand-in `gh` that records each call (and answers the
      // unit-shard poll with a decided, skipped `Unit tests`, so it dispatches) and a no-op
      // `sleep`, and reads which workflows it dispatched.
      describe('run with a stand-in gh', () => {
        const tmp = mkdtempSync(path.join(tmpdir(), 'full-ci-dispatch-'));
        afterAll(() => rmSync(tmp, { recursive: true, force: true }));
        const bin = path.join(tmp, 'bin');
        mkdirSync(bin);
        const log = path.join(tmp, 'gh.log');
        writeFileSync(
          path.join(bin, 'gh'),
          [
            '#!/usr/bin/env bash',
            `echo "$*" >> '${log}'`,
            'case "$*" in',
            '  *"/actions/workflows/lint.yml/runs"*) echo 1 ;;',
            '  *"/actions/runs/1/jobs"*) echo \'{"jobs":[{"name":"Unit tests","conclusion":"skipped"}]}\' ;;',
            'esac',
            '',
          ].join('\n')
        );
        writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\n');
        chmodSync(path.join(bin, 'gh'), 0o755);
        chmodSync(path.join(bin, 'sleep'), 0o755);
        const script = path.join(tmp, 'step.sh');
        writeFileSync(script, run);

        const dispatched = (draft: string) => {
          writeFileSync(log, '');
          execFileSync('bash', ['-e', script], {
            cwd: path.resolve(HERE, '../..'),
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              GITHUB_STEP_SUMMARY: path.join(tmp, 'summary'),
              GH_TOKEN: 'x',
              HEAD_REF: 'some-branch',
              HEAD_SHA: 'a'.repeat(40),
              DRAFT: draft,
              PR: '1',
              REPO: 'o/r',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          return readFileSync(log, 'utf8')
            .split('\n')
            .map((l) => /^workflow run (\S+)/.exec(l)?.[1])
            .filter(Boolean)
            .sort();
        };
        const NINE = [
          'app-data-go.yml',
          'app-index-go.yml',
          'apps.yml',
          'beacon-go.yml',
          'content-policy-go.yml',
          'feed-go.yml',
          'moderator-boot.yml',
          'registry-adapter-image.yml',
          'storage-hook-runner-image.yml',
        ];

        it('on a ready PR, dispatches Lint and none of the nine', () => {
          expect(dispatched('false')).toEqual(['lint.yml']);
        });

        it('on a draft PR, dispatches Lint and all nine', () => {
          expect(dispatched('true')).toEqual(['lint.yml', ...NINE].sort());
        });

        it('dispatches all nine when the draft flag is anything but an exact false', () => {
          expect(dispatched('')).toEqual(['lint.yml', ...NINE].sort());
        });
      });

      // A ledger, so a new draft-gated workflow is either dispatched here or exempted here.
      it('are exactly the draft-gated, dispatchable workflows other than Lint', () => {
        const EXEMPT: Record<string, string> = {
          'lint.yml': 'dispatched first, with its own inputs, and never filtered',
          'feed-go-release.yml':
            'a dispatch publishes a release for a tag input; its PR run only builds',
        };
        const gated = readdirSync(WORKFLOW_DIR)
          .filter((f) => /\.ya?ml$/.test(f))
          .filter((f) => {
            const wf = load(f);
            const jobsIfs = Object.values(wf.jobs ?? {}).map((j) => j.if ?? '');
            return wf.on && 'workflow_dispatch' in wf.on && jobsIfs.some((c) => c.includes(FULL));
          });
        for (const f of Object.keys(EXEMPT)) expect(gated, f).toContain(f);
        const others = /others=\(([^)]*)\)/.exec(run)?.[1].split(/\s+/).filter(Boolean) ?? [];
        expect(others.length).toBeGreaterThan(0);
        expect([...others].sort()).toEqual(gated.filter((f) => !(f in EXEMPT)).sort());
      });
    });

    // A branch cut before `pr` existed rejects it with this text (measured: gh prints
    // "HTTP 422: Unexpected inputs provided: [...]"). Only then is Lint dispatched without `pr`;
    // any other failure fails the step, and the summary says when the dispatch carries no `pr`.
    it('drops `pr` only on the unknown-input rejection, and says so', () => {
      const run =
        (jobs[0].steps ?? []).find((st) => /gh workflow run lint\.yml/.test(st.run ?? ''))?.run ??
        '';
      const first =
        'if ! err=$(gh workflow run lint.yml -R "$REPO" --ref "$HEAD_REF" -f only=all -f skip_passed=true -f pr="$PR" 2>&1 >/dev/null); then';
      const gate = 'if ! grep -q \'Unexpected inputs provided\' <<< "$err"; then';
      const retry =
        'gh workflow run lint.yml -R "$REPO" --ref "$HEAD_REF" -f only=all -f skip_passed=true \\';
      expect(run).toContain(first);
      expect(run).toContain(gate);
      expect(run.indexOf(first)).toBeLessThan(run.indexOf(gate));
      expect(run.indexOf(gate)).toBeLessThan(run.indexOf(retry));
      expect(run.slice(run.indexOf(gate), run.indexOf(retry))).toContain('exit 1');
      expect(run).toContain('if [ -n "$nopr" ]; then');
      expect(run).toMatch(/carries none: the label stays on until a PR run's unit shards pass/);
    });

    // A PR opened with the label gets `opened` and `labeled` at once, and the `opened` Lint run
    // already starts the shards, so dispatching as well ran the suite twice on one commit. The
    // check must key on the head commit and come BEFORE the first dispatch; WHAT it counts is
    // the classifier's job, tested by behaviour below.
    it("classifies the head commit's PR runs before the first dispatch", () => {
      const steps = jobs[0].steps ?? [];
      const idx = steps.findIndex((s) => /gh workflow run lint\.yml/.test(s.run ?? ''));
      expect(idx, 'no step dispatches lint.yml').toBeGreaterThan(-1);
      const run = steps[idx]?.run ?? '';
      expect(steps[idx]?.env?.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
      expect(run).toContain(
        'repos/$REPO/actions/workflows/lint.yml/runs?event=pull_request&head_sha=$HEAD_SHA'
      );
      const classify = '| node scripts/ci/full-ci-unit-shards.mjs';
      expect(run).toContain(classify);
      expect(run.indexOf(classify)).toBeLessThan(run.indexOf('gh workflow run lint.yml'));
      // The classifier must be on disk when the step runs, and the checkout must not leave the
      // dispatching token in the git config.
      const checkout = steps.slice(0, idx).find((s) => s.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with?.['sparse-checkout']).toBe('scripts/ci/full-ci-unit-shards.mjs');
      expect(checkout?.with?.['persist-credentials']).toBe(false);
    });

    // The label comes off in lint.yml (`full-ci-done`), only after its unit shards PASSED. Removing
    // it here, as soon as the full run started, lost the full run whenever the next push cancelled
    // the PR's own run (PR runs share a cancel-in-progress group).
    it('does not remove the label itself', () => {
      for (const j of jobs) {
        for (const st of j.steps ?? []) {
          expect(st.run ?? '', `step "${st.name}" removes a label`).not.toMatch(
            /labels\/full-ci|--remove-label/
          );
        }
      }
    });
  });

  // The classifier full-ci.yml pipes each PR Lint run's job list through. `expanded` > 0 means
  // skip the dispatch; `skipped` > 0 means stop polling and dispatch. A skipped matrix job has
  // no `(<n>)` suffix, so counting the plain name as "running" would skip the dispatch on exactly
  // the PRs that need it.
  describe('classifyUnitJobs', () => {
    const job = (name: string, conclusion: string | null) => ({ name, conclusion });

    it.each([
      [
        'an expanded shard still queued',
        [job('Unit tests (1)', null)],
        { expanded: 1, skipped: 0 },
      ],
      [
        'four expanded shards, one cancelled',
        [
          job('Unit tests (1)', 'success'),
          job('Unit tests (2)', 'failure'),
          job('Unit tests (3)', 'cancelled'),
          job('Unit tests (4)', 'in_progress'),
        ],
        { expanded: 3, skipped: 0 },
      ],
      ['the unexpanded job, skipped', [job('Unit tests', 'skipped')], { expanded: 0, skipped: 1 }],
      [
        'the unexpanded job, not yet decided',
        [job('Unit tests', null)],
        { expanded: 0, skipped: 0 },
      ],
      ['only cancelled shards', [job('Unit tests (2)', 'cancelled')], { expanded: 0, skipped: 0 }],
      [
        'other jobs with similar names',
        [
          job('Unit tests (x)', 'success'),
          job('Package unit tests', 'skipped'),
          job('Slow Unit tests', 'skipped'),
          job('Unit tests (1) extra', 'success'),
          job('Typecheck', 'success'),
        ],
        { expanded: 0, skipped: 0 },
      ],
      ['no jobs listed yet', [], { expanded: 0, skipped: 0 }],
    ])('%s', (_label, jobs, want) => {
      expect(classifyUnitJobs(jobs)).toEqual(want);
    });
  });
});
