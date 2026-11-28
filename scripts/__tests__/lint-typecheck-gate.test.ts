import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// lint.yml's `typecheck` job (`Typecheck (main pushes / fork PRs / non-main base)`): WHEN it runs,
// evaluated rather than read. It is the only typecheck on a push to `main`, on a fork PR and on a
// PR into a branch other than `main`; everywhere else `tekton / typecheck` covers the PR.
//
// REGRESSION TEST. Its two PR disjuncts used to be unpinned, so on a workflow_dispatch they
// compared null with a string, which is true, and every `only: all` dispatch (every full-ci.yml
// dispatch) typechecked the whole repo a second time. The `only: all` dispatch case below is red
// against that `if`.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '../../.github/workflows/lint.yml');
const lint = parse(readFileSync(FILE, 'utf8')) as { jobs: Record<string, { if?: string }> };
const IF = lint.jobs.typecheck?.if ?? '';

type Ctx = { github: Record<string, unknown>; inputs?: Record<string, string> };

// The Actions expression subset this `if` uses: property lookups on a missing object give null,
// `==`/`!=` compare, `!` negates, `&&`/`||` return an operand, `contains(<array>, <value>)`, and
// the `.*.` object filter (`labels.*.name`). Same approach as self-hosted-runner-gate.test.ts.
function evaluate(expr: string, ctx: Ctx): boolean {
  const pluck = (arr: unknown, key: string) =>
    Array.isArray(arr) ? arr.map((o) => (o as Record<string, unknown>)?.[key]) : [];
  const contains = (hay: unknown, needle: unknown) =>
    Array.isArray(hay)
      ? hay.includes(needle)
      : String(hay ?? '')
          .toLowerCase()
          .includes(String(needle).toLowerCase());
  const body = expr
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/\b((?:github|inputs)(?:\.[\w-]+)+)\.\*\.([\w-]+)/g, "pluck($1, '$2')")
    .replace(/!=/g, '!==')
    .replace(/(?<![!=])==(?!=)/g, '===')
    .replace(
      /\b(github|inputs)((?:\.[\w-]+)+)/g,
      (_, root: string, rest: string) => `(${root}${rest.replace(/\./g, '?.')} ?? null)`
    );
  return Boolean(
    new Function('github', 'inputs', 'pluck', 'contains', `return (${body});`)(
      ctx.github,
      ctx.inputs ?? {},
      pluck,
      contains
    )
  );
}

const REPO = 'civitai/civitai';
const push = (): Ctx => ({ github: { event_name: 'push', repository: REPO } });
const dispatch = (only: string): Ctx => ({
  github: { event_name: 'workflow_dispatch', repository: REPO },
  inputs: { only },
});
const pr = ({ head = REPO, base = 'main', draft = false, labels = [] as string[] } = {}): Ctx => ({
  github: {
    event_name: 'pull_request',
    repository: REPO,
    event: {
      pull_request: {
        draft,
        head: { repo: { full_name: head } },
        base: { ref: base },
        labels: labels.map((name) => ({ name })),
      },
    },
  },
});

describe("lint.yml typecheck job's `if`", () => {
  it('is present', () => {
    expect(IF).toContain("github.event_name == 'push'");
  });

  it.each<[string, Ctx, boolean]>([
    ['a push to main', push(), true],
    ['an internal PR into main', pr(), false],
    ['an internal PR into main with the full-ci label', pr({ labels: ['full-ci'] }), false],
    ['a fork PR', pr({ head: 'someone/civitai' }), true],
    ['a PR into release', pr({ base: 'release' }), true],
    ['a draft fork PR without the label', pr({ head: 'someone/civitai', draft: true }), false],
    [
      'a draft fork PR with the full-ci label',
      pr({ head: 'someone/civitai', draft: true, labels: ['full-ci'] }),
      true,
    ],
    ['an `only: all` dispatch (full-ci.yml dispatches this)', dispatch('all'), false],
    ['an `only: typecheck` dispatch', dispatch('typecheck'), true],
    ['an `only: unit` dispatch (the main batch)', dispatch('unit'), false],
    ['an `only: component` dispatch', dispatch('component'), false],
  ])('on %s: %s', (_label, ctx, want) => {
    expect(evaluate(IF, ctx)).toBe(want);
  });

  // The evaluator itself, so a green above is a claim about the `if` and not about a harness
  // that answers one value for everything.
  it('the evaluator reads the unpinned gate this replaced as running on every dispatch', () => {
    const OLD =
      "(github.event_name == 'push' || github.event.pull_request.head.repo.full_name != github.repository || github.event.pull_request.base.ref != 'main') && (!inputs.only || inputs.only == 'all' || inputs.only == 'typecheck') && (github.event_name != 'pull_request' || !github.event.pull_request.draft || contains(github.event.pull_request.labels.*.name, 'full-ci'))";
    expect(evaluate(OLD, dispatch('all'))).toBe(true);
    expect(evaluate(OLD, pr())).toBe(false);
    expect(evaluate(OLD, pr({ head: 'someone/civitai', draft: true, labels: ['full-ci'] }))).toBe(
      true
    );
  });
});
