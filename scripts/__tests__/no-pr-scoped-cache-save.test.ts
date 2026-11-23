import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// Guards the repo's GitHub Actions CACHE BUDGET against entries saved outside `main`.
//
// Actions caches are scoped to a ref: a run reads its own ref's entries and the default branch's,
// and saves into its own ref. An entry saved by a pull request (refs/pull/<n>/merge) or by a
// dispatch on a branch is readable by that ref alone, and still counts against the repo's 10 GB
// cap, where GitHub evicts the least recently used entries, `main`'s included. Measured
// 2026-11-23: nine pnpm-store copies saved by PR and branch runs, ~5 GB, from setup-node's
// `cache: pnpm`, which saves on every run that misses and has no input to stop it.
//
// THE RULE, for every step in .github/workflows/*.yml and .github/actions/*/action.yml:
//   a step that SAVES a cache must be gated, by its own `if` or its job's, to a non-PR run on
//   `main`. The saving steps recognised:
//     - `actions/cache/save@*`
//     - `actions/cache@*` (restores, then saves in a post step)
//     - `actions/setup-node@*` with a non-empty `cache:` input (saves in a post step; an
//       expression counts, since it can evaluate to a package manager on a PR)
//   Restore steps (`actions/cache/restore@*`) are always fine. Use ./.github/actions/pnpm-store-restore
//   and ./.github/actions/pnpm-store-save for the pnpm store; the save action carries the gate.
//
// "Gated" means the `if` is a pure conjunction (no `||`) containing BOTH
//   `github.ref == 'refs/heads/main'`, and
//   an event conjunct that excludes pull requests: `github.event_name != 'pull_request'`, or
//   `github.event_name == 'push' | 'workflow_dispatch' | 'schedule'`.
// The event conjunct is not redundant with the ref: on `pull_request_target` `github.ref` IS the
// base branch, so a ref check alone would let a PR-triggered run save into `main`'s scope.
// Deliberately stricter than a reachability analysis (which jobs a PR can reach): a misread
// trigger or job `if` is how such an analysis reports safe over a leak, and the gate costs one
// line where it is not needed.
//
// NOT COVERED, stated so this does not read as wider than it is: actions whose cache is built in
// and on by default under another input name, notably `actions/setup-go` (`cache`, default true)
// and `golangci/golangci-lint-action`. They save on a miss in any ref too; their keys change only
// with go.sum (and, for golangci-lint, a time interval), and on 2026-11-23 no PR-scoped entry of
// either existed.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');
const ACTIONS_DIR = path.join(ROOT, '.github/actions');

type Step = { uses?: unknown; if?: unknown; with?: Record<string, unknown>; name?: unknown };
type StepSet = { where: string; jobIf?: unknown; steps: Step[] };

const MAIN_REF = "github.ref == 'refs/heads/main'";
const NON_PR_EVENT = [
  "github.event_name != 'pull_request'",
  "github.event_name == 'push'",
  "github.event_name == 'workflow_dispatch'",
  "github.event_name == 'schedule'",
];

/** The conjuncts of an `if`, or null when it is not a pure conjunction. */
function conjuncts(cond: unknown): string[] | null {
  if (typeof cond !== 'string') return null;
  let s = cond.trim();
  if (s.startsWith('${{') && s.endsWith('}}')) s = s.slice(3, -2);
  s = s.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  if (s.includes('||')) return null;
  return s.split('&&').map((c) => c.trim());
}

/** Is this `if` a gate to a non-PR run on `main`? */
function gatedToMain(cond: unknown): boolean {
  const cs = conjuncts(cond);
  if (!cs) return false;
  return cs.includes(MAIN_REF) && cs.some((c) => NON_PR_EVENT.includes(c));
}

/** Why this step saves a cache, or null when it does not. */
function savesCache(step: Step): string | null {
  const uses = typeof step.uses === 'string' ? step.uses : '';
  if (/^actions\/cache\/save@/.test(uses)) return 'actions/cache/save';
  if (/^actions\/cache@/.test(uses)) return 'actions/cache (saves in its post step)';
  if (/^actions\/setup-node@/.test(uses)) {
    const cache = step.with?.cache;
    if (cache !== undefined && cache !== null && cache !== false && String(cache).trim() !== '')
      return `actions/setup-node \`cache: ${String(cache)}\` (saves in its post step)`;
  }
  return null;
}

/** Every saving step not gated to `main`, as "where: step: reason". */
function offenders(sets: StepSet[]): string[] {
  return sets.flatMap(({ where, jobIf, steps }) =>
    steps.flatMap((step, i) => {
      const why = savesCache(step);
      if (!why || gatedToMain(step.if) || gatedToMain(jobIf)) return [];
      return [`${where} step ${String(step.name ?? step.uses ?? i)}: ${why}`];
    })
  );
}

type Job = { if?: unknown; steps?: Step[] };
type YamlDoc = { jobs?: Record<string, Job | null>; runs?: { steps?: Step[] } };

function yamlFile(p: string): YamlDoc {
  return parse(readFileSync(p, 'utf8')) as YamlDoc;
}

function loadStepSets(): StepSet[] {
  const sets: StepSet[] = [];
  for (const file of readdirSync(WORKFLOW_DIR).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const doc = yamlFile(path.join(WORKFLOW_DIR, file));
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      sets.push({
        where: `.github/workflows/${file}:${id}`,
        jobIf: job?.if,
        steps: job?.steps ?? [],
      });
    }
  }
  if (existsSync(ACTIONS_DIR)) {
    for (const dir of readdirSync(ACTIONS_DIR).sort()) {
      const file = ['action.yml', 'action.yaml']
        .map((f) => path.join(ACTIONS_DIR, dir, f))
        .find((f) => existsSync(f));
      if (!file) continue;
      const doc = yamlFile(file);
      sets.push({ where: `.github/actions/${dir}`, steps: doc.runs?.steps ?? [] });
    }
  }
  return sets;
}

const sets = loadStepSets();

describe('no cache is saved outside main', () => {
  it('reads the workflows and the local actions it scans', () => {
    // Positive control on the instrument: a scan that loads nothing reports zero offenders.
    expect(sets.filter((s) => s.where.startsWith('.github/workflows/')).length).toBeGreaterThan(20);
    expect(sets.map((s) => s.where)).toEqual(
      expect.arrayContaining([
        '.github/actions/pnpm-store-restore',
        '.github/actions/pnpm-store-save',
      ])
    );
    // ...and it finds the saving steps that exist, so a zero below is not a matcher that never fires.
    const saving = sets.flatMap((s) => s.steps.filter((st) => savesCache(st)).map(() => s.where));
    expect(saving).toContain('.github/actions/pnpm-store-save');
    expect(saving.length).toBeGreaterThanOrEqual(4);
  });

  it('gates every cache save to a non-PR run on main', () => {
    const found = offenders(sets);
    expect(
      found,
      `These save an Actions cache on pull requests or branch runs, where the entry is readable only by that ref and spends the repo's 10 GB budget. Gate the save with \`github.event_name != 'pull_request' && github.ref == 'refs/heads/main'\`, or use ./.github/actions/pnpm-store-restore + pnpm-store-save instead of setup-node's \`cache:\`:\n${found.join(
        '\n'
      )}`
    ).toEqual([]);
  });

  it('uses the pnpm store save action only after the restore action, in the same job', () => {
    const bad = sets.flatMap(({ where, steps }) => {
      const uses = steps.map((s) => (typeof s.uses === 'string' ? s.uses : ''));
      const save = uses.indexOf('./.github/actions/pnpm-store-save');
      const restore = uses.indexOf('./.github/actions/pnpm-store-restore');
      return save !== -1 && (restore === -1 || restore > save) ? [where] : [];
    });
    expect(bad).toEqual([]);
  });

  // The detector on fixtures, so each branch above is seen to go red.
  describe('the detector', () => {
    const set = (steps: Step[], jobIf?: string): StepSet[] => [
      { where: 'fixture:job', jobIf, steps },
    ];
    const GATE = "${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' }}";

    it.each([
      ['setup-node cache: pnpm', { uses: 'actions/setup-node@v7', with: { cache: 'pnpm' } }],
      [
        'setup-node cache as an expression',
        {
          uses: 'actions/setup-node@v7',
          with: { cache: "${{ steps.nm.outputs.cache-hit != 'true' && 'pnpm' || '' }}" },
        },
      ],
      ['an ungated save', { uses: 'actions/cache/save@v6', with: { key: 'k', path: 'p' } }],
      [
        'actions/cache (restore + post save)',
        { uses: 'actions/cache@v6', with: { key: 'k', path: 'p' } },
      ],
      [
        'a save gated on the ref only',
        { uses: 'actions/cache/save@v6', if: "github.ref == 'refs/heads/main'" },
      ],
      [
        'a save gated on the event only',
        { uses: 'actions/cache/save@v6', if: "github.event_name != 'pull_request'" },
      ],
      [
        'a gate weakened by ||',
        {
          uses: 'actions/cache/save@v6',
          if: "github.event_name != 'pull_request' && github.ref == 'refs/heads/main' || github.event_name == 'pull_request'",
        },
      ],
      [
        'a ref gate to another branch',
        {
          uses: 'actions/cache/save@v6',
          if: "github.event_name != 'pull_request' && github.ref == 'refs/heads/release'",
        },
      ],
    ])('flags %s', (_label, step) => {
      expect(offenders(set([step as Step]))).toHaveLength(1);
    });

    it.each([
      ['a restore', { uses: 'actions/cache/restore@v6', with: { key: 'k', path: 'p' } }, undefined],
      [
        'setup-node without cache',
        { uses: 'actions/setup-node@v7', with: { 'node-version-file': '.nvmrc' } },
        undefined,
      ],
      [
        'setup-node with an empty cache',
        { uses: 'actions/setup-node@v7', with: { cache: '' } },
        undefined,
      ],
      [
        'a save gated by its own if',
        {
          uses: 'actions/cache/save@v6',
          if: `${GATE.slice(0, -2)} && steps.x.outputs.cache-hit != 'true' }}`,
        },
        undefined,
      ],
      [
        "a save in a job gated to main's batch dispatch",
        { uses: 'actions/cache/save@v6', if: "steps.nm.outputs.cache-hit != 'true'" },
        "${{ github.event_name == 'workflow_dispatch' && github.actor == 'github-actions[bot]' && github.ref == 'refs/heads/main' }}",
      ],
      [
        'setup-node cache in a main-gated job',
        { uses: 'actions/setup-node@v7', with: { cache: 'pnpm' } },
        GATE,
      ],
    ])('passes %s', (_label, step, jobIf) => {
      expect(offenders(set([step as Step], jobIf))).toEqual([]);
    });
  });
});
