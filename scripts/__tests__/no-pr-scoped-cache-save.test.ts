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
// cap, where GitHub evicts the least recently used entries, `main`'s included. The case that
// prompted this: setup-node's `cache: pnpm`, which saves on every run that misses, on any ref, and
// has no input to stop it, so PR and branch runs each saved their own copy of the pnpm store.
//
// THE RULE, for every step in .github/workflows/*.yml and .github/actions/*/action.yml:
//   a step that SAVES a cache must be gated, by its own `if` or its job's, to a push, dispatch or
//   schedule run on `main`. The saving steps recognised:
//     - `actions/cache/save@*`
//     - `actions/cache@*` (restores, then saves in a post step)
//     - `actions/setup-node@*` with a non-empty `cache:` input (saves in a post step; an
//       expression counts, since it can evaluate to a package manager on a PR)
//     - `pnpm/action-setup@*` with a truthy `cache:` input (saves the store in a post step)
//     - `actions/setup-go@*` unless `cache:` is explicitly false (its cache DEFAULTS to true, so
//       an absent input saves; an expression counts, since it can be true on a PR)
//     - `golangci/golangci-lint-action@*` unless `skip-cache` is literally true, or
//       `skip-save-cache` is the negation of a main gate: `${{ !(<gate>) }}` (its cache is on by
//       default and saves in a post step)
//   Restore steps (`actions/cache/restore@*`) are always fine. Use ./.github/actions/pnpm-store-restore
//   and ./.github/actions/pnpm-store-save for the pnpm store, ./.github/actions/go-cache-restore
//   and ./.github/actions/go-cache-save for Go's; the save actions carry the gate.
//
// "Gated" means the `if` is a pure conjunction (no `||`) containing BOTH
//   `github.ref == 'refs/heads/main'`, and
//   an event ALLOWLIST: `github.event_name == 'push' | 'workflow_dispatch' | 'schedule'`, or
//   `contains(fromJSON('[...]'), github.event_name)` naming only those.
// The event conjunct is not redundant with the ref, and a deny-one `!= 'pull_request'` is not
// enough: `pull_request_target`, `issue_comment` and `workflow_run` all run with `github.ref` =
// the default branch, so either would let a run that a PR or a comment triggered save into
// `main`'s scope, which every ref reads.
// Deliberately stricter than a reachability analysis (which jobs a PR can reach): a misread
// trigger or job `if` is how such an analysis reports safe over a leak, and the gate costs one
// line where it is not needed.
//
// NOT COVERED, stated so this does not read as wider than it is: any other action with a built-in
// cache. The list above is every cache-saving action this repo used when the guard was written; a
// new one needs a branch in savesCache.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');
const ACTIONS_DIR = path.join(ROOT, '.github/actions');

type Step = { uses?: unknown; if?: unknown; with?: Record<string, unknown>; name?: unknown };
type StepSet = { where: string; jobIf?: unknown; steps: Step[] };

const MAIN_REF = "github.ref == 'refs/heads/main'";
const ALLOWED_EVENTS = ['push', 'workflow_dispatch', 'schedule'];

/** Is this conjunct an event check admitting only ALLOWED_EVENTS? (quotes already normalised) */
function allowlistsEvent(c: string): boolean {
  const eq = /^github\.event_name == '([a-z_]+)'$/.exec(c);
  if (eq) return ALLOWED_EVENTS.includes(eq[1]);
  const list = /^contains\(fromJSON\('\[([^\]]*)\]'\), github\.event_name\)$/.exec(c);
  if (!list) return false;
  const items = list[1].split(',').map((x) => /^'([a-z_]+)'$/.exec(x.trim())?.[1]);
  return items.length > 0 && items.every((x) => x !== undefined && ALLOWED_EVENTS.includes(x));
}

/** The conjuncts of an `if`, or null when it is not a pure conjunction. */
function conjuncts(cond: unknown): string[] | null {
  if (typeof cond !== 'string') return null;
  let s = cond.trim();
  if (s.startsWith('${{') && s.endsWith('}}')) s = s.slice(3, -2);
  s = s.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  if (s.includes('||')) return null;
  return s.split('&&').map((c) => c.trim());
}

/** Is this `if` a gate to a push / dispatch / schedule run on `main`? */
function gatedToMain(cond: unknown): boolean {
  const cs = conjuncts(cond);
  if (!cs) return false;
  return cs.includes(MAIN_REF) && cs.some(allowlistsEvent);
}

/** Why this step saves a cache, or null when it does not. */
function savesCache(step: Step): string | null {
  // Lower-cased: GitHub resolves `owner/repo` case-insensitively, so `Actions/Setup-Go@v6` runs
  // the same action and must not walk past the matchers below.
  const uses = (typeof step.uses === 'string' ? step.uses : '').trim().toLowerCase();
  if (/^actions\/cache\/save@/.test(uses)) return 'actions/cache/save';
  if (/^actions\/cache@/.test(uses)) return 'actions/cache (saves in its post step)';
  if (/^actions\/setup-node@/.test(uses)) {
    const cache = step.with?.cache;
    if (cache !== undefined && cache !== null && cache !== false && String(cache).trim() !== '')
      return `actions/setup-node \`cache: ${String(cache)}\` (saves in its post step)`;
  }
  if (/^pnpm\/action-setup@/.test(uses)) {
    const cache = step.with?.cache;
    if (
      cache !== undefined &&
      cache !== null &&
      cache !== false &&
      !['', 'false'].includes(String(cache).trim())
    )
      return `pnpm/action-setup \`cache: ${String(cache)}\` (saves the store in its post step)`;
  }
  if (/^actions\/setup-go@/.test(uses)) {
    const cache = step.with?.cache;
    if (cache !== false && String(cache).trim() !== 'false')
      return `actions/setup-go \`cache: ${
        cache === undefined ? '(default true)' : String(cache)
      }\` (saves in its post step)`;
  }
  if (/^golangci\/golangci-lint-action@/.test(uses)) {
    const isTrue = (v: unknown) => v === true || String(v).trim() === 'true';
    if (isTrue(step.with?.['skip-cache']) || isTrue(step.with?.['skip-save-cache'])) return null;
    if (!skipsSaveOffMain(step.with?.['skip-save-cache']))
      return 'golangci-lint-action cache (saves in its post step; set skip-save-cache to ${{ !(<main gate>) }})';
  }
  return null;
}

/** Is this a `skip-save-cache` value that is true everywhere but a gated run on `main`? */
function skipsSaveOffMain(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = /^\$\{\{\s*!\s*\(([\s\S]*)\)\s*\}\}$/.exec(v.trim());
  return m !== null && gatedToMain(m[1]);
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
  // Recursive: a local action can live at any depth (`./.github/actions/go/restore`).
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/^action\.ya?ml$/.test(ent.name)) {
        const where = path.relative(ROOT, dir).split(path.sep).join('/');
        sets.push({ where, steps: yamlFile(full).runs?.steps ?? [] });
      }
    }
  };
  if (existsSync(ACTIONS_DIR)) walk(ACTIONS_DIR);
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
        '.github/actions/go-cache-restore',
        '.github/actions/go-cache-save',
      ])
    );
    // ...and it finds the saving steps that exist, so a zero below is not a matcher that never fires.
    const saving = sets.flatMap((s) => s.steps.filter((st) => savesCache(st)).map(() => s.where));
    expect(saving).toContain('.github/actions/pnpm-store-save');
    expect(saving).toContain('.github/actions/go-cache-save');
    expect(saving.length).toBeGreaterThanOrEqual(4);
  });

  it('gates every cache save to a push, dispatch or schedule run on main', () => {
    const found = offenders(sets);
    expect(
      found,
      `These save an Actions cache on pull requests or branch runs, where the entry is readable only by that ref and spends the repo's 10 GB budget. Gate the save with \`contains(fromJSON('["push", "workflow_dispatch", "schedule"]'), github.event_name) && github.ref == 'refs/heads/main'\`, or use ./.github/actions/pnpm-store-restore + pnpm-store-save instead of setup-node's \`cache:\`, go-cache-restore + go-cache-save with setup-go \`cache: false\`, and golangci-lint-action \`skip-save-cache: \${{ !(<that gate>) }}\`:\n${found.join(
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
    const GATE = `\${{ contains(fromJSON('["push", "workflow_dispatch", "schedule"]'), github.event_name) && github.ref == 'refs/heads/main' }}`;

    it.each([
      ['setup-node cache: pnpm', { uses: 'actions/setup-node@v7', with: { cache: 'pnpm' } }],
      [
        'setup-node cache as an expression',
        {
          uses: 'actions/setup-node@v7',
          with: { cache: "${{ steps.nm.outputs.cache-hit != 'true' && 'pnpm' || '' }}" },
        },
      ],
      ['pnpm/action-setup cache: true', { uses: 'pnpm/action-setup@v6', with: { cache: true } }],
      [
        'setup-go with no cache input (defaults to true)',
        { uses: 'actions/setup-go@v6', with: { 'go-version-file': 'go.mod' } },
      ],
      ['setup-go cache: true', { uses: 'actions/setup-go@v6', with: { cache: true } }],
      [
        'a mixed-case setup-go with its default cache',
        { uses: 'Actions/Setup-Go@v6', with: { 'go-version-file': 'go.mod' } },
      ],
      [
        'setup-go cache as an expression',
        { uses: 'actions/setup-go@v6', with: { cache: "${{ github.ref == 'refs/heads/main' }}" } },
      ],
      [
        'golangci-lint-action with its default cache',
        { uses: 'golangci/golangci-lint-action@abc', with: { version: 'v2' } },
      ],
      [
        'golangci-lint-action skip-save-cache on a deny-one gate',
        {
          uses: 'golangci/golangci-lint-action@abc',
          with: { 'skip-save-cache': "${{ github.event_name == 'pull_request' }}" },
        },
      ],
      [
        'golangci-lint-action skip-save-cache: false',
        { uses: 'golangci/golangci-lint-action@abc', with: { 'skip-save-cache': false } },
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
        { uses: 'actions/cache/save@v6', if: "github.event_name == 'push'" },
      ],
      [
        // pull_request_target, issue_comment and workflow_run all run with github.ref = main.
        "a deny-one event gate (`!= 'pull_request'`)",
        {
          uses: 'actions/cache/save@v6',
          if: "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
        },
      ],
      [
        'an event list that admits pull_request_target',
        {
          uses: 'actions/cache/save@v6',
          if: `contains(fromJSON('["push", "pull_request_target"]'), github.event_name) && github.ref == 'refs/heads/main'`,
        },
      ],
      [
        'a gate weakened by ||',
        {
          uses: 'actions/cache/save@v6',
          if: "github.event_name == 'push' && github.ref == 'refs/heads/main' || github.event_name == 'pull_request'",
        },
      ],
      [
        'a ref gate to another branch',
        {
          uses: 'actions/cache/save@v6',
          if: "github.event_name == 'push' && github.ref == 'refs/heads/release'",
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
      ['pnpm/action-setup without cache', { uses: 'pnpm/action-setup@v6' }, undefined],
      ['setup-go cache: false', { uses: 'actions/setup-go@v6', with: { cache: false } }, undefined],
      [
        'golangci-lint-action skip-cache: true',
        { uses: 'golangci/golangci-lint-action@abc', with: { 'skip-cache': true } },
        undefined,
      ],
      [
        'golangci-lint-action skip-save-cache: true',
        { uses: 'golangci/golangci-lint-action@abc', with: { 'skip-save-cache': true } },
        undefined,
      ],
      [
        'golangci-lint-action skip-save-cache off main',
        {
          uses: 'golangci/golangci-lint-action@abc',
          with: {
            'skip-save-cache': `\${{ !(contains(fromJSON('["push", "workflow_dispatch", "schedule"]'), github.event_name) && github.ref == 'refs/heads/main') }}`,
          },
        },
        undefined,
      ],
      [
        'setup-go default cache in a main-gated job',
        { uses: 'actions/setup-go@v6' },
        "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
      ],
      [
        'pnpm/action-setup cache: false',
        { uses: 'pnpm/action-setup@v6', with: { cache: false } },
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
        'a save gated by == push',
        {
          uses: 'actions/cache/save@v6',
          if: "github.event_name == 'push' && github.ref == 'refs/heads/main'",
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
