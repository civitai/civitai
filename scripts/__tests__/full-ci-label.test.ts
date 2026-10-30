import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// The `full-ci` PR label: lint.yml and apps.yml read it on every PR run, and full-ci.yml
// dispatches both when it is added.
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

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; permissions?: Record<string, string>; steps?: Step[] };
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
  it.each(['lint.yml', 'apps.yml'])('%s does not fire on labeled events', (file) => {
    const types = load(file).on?.pull_request?.types;
    expect(types, `${file} must list its pull_request types explicitly`).toBeDefined();
    expect(types).not.toContain('labeled');
  });

  it('lint.yml runs the unit job on a PR only when it has the label', () => {
    expect(conjuncts(load('lint.yml').jobs?.unit?.if ?? '')).toContain(UNIT_PR_GATE);
  });

  // The label lifts the draft gate on every job that has one. `eslint` has none (it runs on
  // drafts already) and `unit` is gated by UNIT_PR_GATE, which implies it.
  it.each([
    ['lint.yml', 'typecheck'],
    ['lint.yml', 'packages'],
    ['lint.yml', 'component'],
    ['apps.yml', 'apps'],
  ])('%s:%s runs on a labeled draft', (file, id) => {
    expect(conjuncts(load(file).jobs?.[id]?.if ?? '')).toContain(DRAFT_GATE);
  });

  // Ledger: the job set the assertions above were written against. A new job fails here so its
  // author decides which draft gate it takes.
  it.each([
    ['lint.yml', ['component', 'eslint', 'packages', 'typecheck', 'unit']],
    ['apps.yml', ['apps']],
  ])('%s has exactly the jobs this guard was written for', (file, ids) => {
    expect(Object.keys(load(file).jobs ?? {}).sort()).toEqual(ids);
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
      expect(step.run).toContain(
        'gh workflow run lint.yml -R "$REPO" --ref "$HEAD_REF" -f only=all'
      );
      expect(step.run).toContain('gh workflow run apps.yml -R "$REPO" --ref "$HEAD_REF"');
    });
  });
});
