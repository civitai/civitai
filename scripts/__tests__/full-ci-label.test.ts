import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// The `full-ci` PR label (lint.yml and apps.yml): adding it runs the full suite on a PR.
//
// INVARIANT GUARD, not a regression test. Nothing here was ever broken on `main`; it pins
// the shape of the change that added the label, and the behaviour behind that shape was
// proven on a live throwaway PR when it shipped (see the PR that added this file): another
// label started a run whose jobs all skipped and did NOT cancel the run in flight; `full-ci`
// on a draft ran every job and the four unit shards; a later push ran them again; removing
// the label went back to ESLint only.
//
// What it guards against is the cheap way to break that: `types` lists `labeled`, so EVERY
// label anyone adds fires these workflows. A new job written without the noise clause starts
// work on every label; a concurrency group that loses its noise branch lets an all-skipped
// run cancel the PR's real run. Neither shows up as a red check, only as wasted or lost runs.
//
// The clauses are pinned as whole normalised strings rather than keywords, and each must be a
// top-level AND conjunct of the job's `if`: a clause that sits inside an `||` gates nothing.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(HERE, '../../.github/workflows');

const FULL = "contains(github.event.pull_request.labels.*.name, 'full-ci')";
const NOISE_SKIP = "(github.event.action != 'labeled' || github.event.label.name == 'full-ci')";
const DRAFT_GATE = `(github.event_name != 'pull_request' || !github.event.pull_request.draft || ${FULL})`;
const UNIT_PR_GATE = `(github.event_name != 'pull_request' || ${FULL})`;
const NOISE_GROUP =
  "github.event.action == 'labeled' && github.event.label.name != 'full-ci' && format('noise-{0}', github.run_id)";

type Job = { if?: string };
type Workflow = {
  on?: { pull_request?: { types?: string[] } };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
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

/**
 * Split an expression on the operator `op` at paren depth 0 (quotes respected). Returns
 * one part when `op` never appears at the top level.
 */
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

/** The top-level AND conjuncts of a job's `if`, or null when an `||` sits at the top level. */
function conjuncts(ifExpr: string): string[] | null {
  const e = unwrap(norm(ifExpr));
  if (splitTop(e, '||').length > 1) return null;
  return splitTop(e, '&&');
}

const FILES = ['lint.yml', 'apps.yml'];

describe('the full-ci label', () => {
  it.each(FILES)('%s fires on labeled pull_request events', (file) => {
    expect(load(file).on?.pull_request?.types).toContain('labeled');
  });

  // (a) Every job, so a job added later without the clause fails here.
  it.each(FILES)(
    '%s: every job skips a labeled event for any other label (top-level conjunct)',
    (file) => {
      const offenders = Object.entries(load(file).jobs ?? {})
        .filter(([, job]) => {
          const parts = job.if ? conjuncts(job.if) : null;
          return !parts || !parts.includes(NOISE_SKIP);
        })
        .map(([id]) => id);
      expect(offenders, `jobs whose if lacks ${NOISE_SKIP} as a top-level && clause`).toEqual([]);
    }
  );

  // (b) Pinned whole: the noise branch must sit between the dispatch branch and the ref
  // fallback, and only github.run_id makes the group unique per run.
  it('lint.yml routes a noise-labeled run to a group of its own', () => {
    const c = load('lint.yml').concurrency;
    expect(c?.['cancel-in-progress']).toBe(true);
    expect(norm(c?.group ?? '')).toBe(
      `lint-\${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}-{1}', github.ref, inputs.only) || ${NOISE_GROUP} || github.ref }}`
    );
  });

  it('apps.yml routes a noise-labeled run to a group of its own', () => {
    const c = load('apps.yml').concurrency;
    expect(c?.['cancel-in-progress']).toBe(true);
    expect(norm(c?.group ?? '')).toBe(
      `apps-\${{ github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.ref) || ${NOISE_GROUP} || github.ref }}`
    );
  });

  // (c) The point of the label: the unit shards run on a labeled PR.
  it('lint.yml runs the unit job on a PR only when it has the label', () => {
    const parts = conjuncts(load('lint.yml').jobs?.unit?.if ?? '');
    expect(parts).toContain(UNIT_PR_GATE);
  });

  // The label lifts the draft gate on every job that has one. `eslint` has none (it runs on
  // drafts already) and `unit` is gated by UNIT_PR_GATE, which implies it.
  it.each([
    ['lint.yml', 'typecheck'],
    ['lint.yml', 'packages'],
    ['lint.yml', 'component'],
    ['apps.yml', 'apps'],
  ])('%s:%s runs on a labeled draft', (file, id) => {
    const parts = conjuncts(load(file).jobs?.[id]?.if ?? '');
    expect(parts).toContain(DRAFT_GATE);
  });

  // Ledger: the job set the two assertions above were written against. A new job fails here
  // so its author decides which draft gate it takes; (a) already makes it carry the noise skip.
  it.each([
    ['lint.yml', ['component', 'eslint', 'packages', 'typecheck', 'unit']],
    ['apps.yml', ['apps']],
  ])('%s has exactly the jobs this guard was written for', (file, ids) => {
    expect(Object.keys(load(file).jobs ?? {}).sort()).toEqual(ids);
  });
});
