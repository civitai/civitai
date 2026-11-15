import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { failedByProject, parseFirstBad } from '../ci/nightly-bisect.mjs';
import {
  FS_IMPORT,
  decide,
  fullRunTriggers,
  isReaderCandidate,
  ledger,
  lintRulesFiles,
  makeDependents,
  select,
  unitPlan,
} from '../ci/test-selection.mjs';

// scripts/ci/test-selection.mjs decides what a change-scoped run of the `unit` and `component`
// suites would run (shadow mode in lint.yml). Its safety model is FAIL OPEN: a change the import
// graph cannot see must select the full suite. These pin the fallback list entry by entry, the
// always-run set, and the record the miss ledger is computed from.

const reasonOf = (f: string, deleted: string[] = []) => fullRunTriggers([f], deleted)[0]?.reason;

describe('fullRunTriggers: the fallback list', () => {
  it.each([
    ['pnpm-lock.yaml', 'lockfile: resolved versions of every dependency'],
    ['package.json', 'package manifest: dependency versions, workspace links, scripts'],
    ['apps/auth/package.json', 'package manifest: dependency versions, workspace links, scripts'],
    ['pnpm-workspace.yaml', 'workspace layout and catalog versions'],
    ['patches/next@16.0.0.patch', 'pnpm patches rewrite files inside node_modules'],
    [
      'packages/civitai-db-schema/prisma/schema.full.prisma',
      'Prisma schema: install regenerates the client every DB test loads',
    ],
    ['vitest.config.mts', 'test runner config'],
    ['apps/auth/vite.config.ts', 'test runner config'],
    ['tsconfig.json', 'path aliases decide what every import resolves to'],
    ['test/component-setup.tsx', 'browser-mode global setup, setup files and fixtures'],
    ['scripts/test-unit-run.mjs', 'the unit suite runner'],
    ['.github/workflows/feed-go.yml', 'CI workflow files'],
    ['scripts/ci/test-selection.mjs', 'CI pipeline scripts, this selector included'],
    ['.nvmrc', 'toolchain version'],
    ['flake.lock', 'toolchain version'],
    ['event-engine-common', 'submodule pointer: src imports the submodule by path'],
    ['public/fonts/Inter.woff2', 'a non-module file imported code may read at runtime'],
    ['packages/civitai-x/data.json', 'a non-module file imported code may read at runtime'],
    ['scripts/test-perf/budget.json', 'a non-module file imported code may read at runtime'],
    ['bundle-budget.json', 'a non-module file at the repo root, read by tooling and some routes'],
    ['CLAUDE.md', 'a non-module file at the repo root, read by tooling and some routes'],
  ])('%s forces a full run', (file, reason) => {
    expect(reasonOf(file)).toBe(reason);
  });

  it.each([
    'src/server/services/model.service.ts',
    'scripts/lib/thing.mjs',
    'src/components/Foo/Foo.module.scss', // src non-module: decide() asks the graph
    'apps/feed-go/internal/hydrate/users.go',
    'apps/auth/.env.example',
    '.claude/rules/testing.md',
    'docs/dev/convention-guards.md',
    'apps/moderator/src/lib/thing.ts',
  ])('%s leaves the decision to the graph', (file) => {
    expect(fullRunTriggers([file])).toEqual([]);
  });

  it('a deleted module forces a full run; a deleted test file does not', () => {
    expect(reasonOf('src/utils/gone.ts', ['src/utils/gone.ts'])).toBe(
      'a deleted module: its importers are not in the HEAD graph'
    );
    expect(fullRunTriggers(['src/a.test.ts'], ['src/a.test.ts'])).toEqual([]);
  });
});

// A small graph: two leaf tests, one hub, one setup-reachable module, one fs-reading guard.
//   a.test.ts -> a.ts -> hub.ts ;  b.test.ts -> b.ts -> hub.ts ;  c.test.ts -> c.ts
//   setup.ts -> env.ts ;  guard.test.ts reads the tree (always-run)
const edges = new Map<string, Set<string>>([
  ['src/a.test.ts', new Set(['src/a.ts'])],
  ['src/a.ts', new Set(['src/hub.ts', 'src/a.module.scss'])],
  ['src/b.test.ts', new Set(['src/b.ts'])],
  ['src/b.ts', new Set(['src/hub.ts'])],
  ['src/c.test.ts', new Set(['src/c.ts'])],
  ['src/c.ts', new Set()],
  ['src/hub.ts', new Set()],
  ['src/a.module.scss', new Set()],
  ['src/guard.test.ts', new Set()],
  ['src/setup.ts', new Set(['src/env.ts'])],
  ['src/env.ts', new Set()],
]);
const tests = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/guard.test.ts'];
const graph = {
  unit: {
    tests,
    setupReach: ['src/setup.ts', 'src/env.ts'],
    has: (f: string) => edges.has(f),
    importsOf: (f: string) => edges.get(f)?.size ?? 0,
    dependents: makeDependents(edges),
  },
};
const alwaysRun = { unit: ['src/guard.test.ts'] };
const run = (changed: string[], deleted: string[] = []) =>
  decide({ changed, deleted, graph, alwaysRun }).projects.unit;

describe('decide', () => {
  it('selects the tests that reach a changed module, plus the always-run set', () => {
    expect(run(['src/c.ts'])).toEqual({
      mode: 'scoped',
      total: 4,
      selected: ['src/c.test.ts', 'src/guard.test.ts'],
    });
  });

  // 🔴 POSITIVE CONTROL for the always-run set: guard.test.ts imports nothing the diff touches.
  it('runs an always-run test on a diff it does not import', () => {
    expect(run(['src/c.ts']).selected).toContain('src/guard.test.ts');
    expect(graph.unit.dependents(['src/c.ts']).has('src/guard.test.ts')).toBe(false);
  });

  it('selects a changed test file itself', () => {
    expect(run(['src/c.test.ts']).selected).toEqual(['src/c.test.ts', 'src/guard.test.ts']);
  });

  it('follows a stylesheet under src/ through the graph', () => {
    expect(run(['src/a.module.scss']).selected).toEqual(['src/a.test.ts', 'src/guard.test.ts']);
  });

  it('runs in full when a non-module file under src/ is in no graph', () => {
    expect(run(['src/static-content/rules.md'])).toEqual({
      mode: 'full',
      total: 4,
      reason:
        'src/static-content/rules.md: a non-module file under src/ that no test imports: code may read it at runtime',
    });
  });

  it('runs in full when a change reaches a setup file', () => {
    expect(run(['src/env.ts'])).toEqual({
      mode: 'full',
      total: 4,
      reason: 'src/env.ts: reached from a unit setup file, which every unit test runs',
    });
  });

  // 3 of 4 is over half; 2 of 4 is not. The boundary is exclusive.
  it('runs in full when the selection is over half the suite, not at exactly half', () => {
    expect(run(['src/hub.ts'])).toEqual({
      mode: 'full',
      total: 4,
      reason: 'selects 3 of 4 files, over 50%',
    });
    expect(run(['src/a.ts']).mode).toBe('scoped');
  });

  it('runs in full, with the trigger as the reason, on a fallback-list change', () => {
    expect(run(['src/c.ts', 'pnpm-lock.yaml'])).toEqual({
      mode: 'full',
      total: 4,
      reason: 'pnpm-lock.yaml: lockfile: resolved versions of every dependency',
    });
  });

  // 🔴 A blind walk (no imports resolved) would otherwise read as a perfectly narrow selection.
  it('throws (so select() falls back to full) when most test files import nothing', () => {
    const blind = { unit: { ...graph.unit, importsOf: () => 0 } };
    expect(() => decide({ changed: ['src/c.ts'], graph: blind, alwaysRun })).toThrow(
      'unit: only 0 of 4 test files import anything; the walk is blind'
    );
  });

  it('accepts a graph where exactly half the test files import something', () => {
    const half = {
      unit: {
        ...graph.unit,
        importsOf: (f: string) => (f === 'src/a.test.ts' || f === 'src/b.test.ts' ? 1 : 0),
      },
    };
    expect(decide({ changed: ['src/c.ts'], graph: half, alwaysRun }).projects.unit.mode).toBe(
      'scoped'
    );
  });
});

describe('makeDependents', () => {
  it('is transitive and excludes the targets themselves unless something imports them', () => {
    expect([...makeDependents(edges)(['src/hub.ts'])].sort()).toEqual([
      'src/a.test.ts',
      'src/a.ts',
      'src/b.test.ts',
      'src/b.ts',
    ]);
  });
});

describe('the always-run set inputs', () => {
  it.each([
    "import { readFileSync } from 'node:fs';",
    "import fs from 'fs';",
    "import { readdir } from 'fs/promises';",
    "const { execFileSync } = require('child_process');",
    "const fs = await import('node:fs');",
    "import { globSync } from 'tinyglobby';",
  ])('FS_IMPORT matches %s', (line) => {
    expect(FS_IMPORT.test(line)).toBe(true);
  });

  it.each([
    "import { fsx } from './fs-helpers';",
    '// reads fs at runtime',
    "import path from 'node:path';",
  ])('FS_IMPORT does not match %s', (line) => {
    expect(FS_IMPORT.test(line)).toBe(false);
  });

  it.each([
    ['src/server/services/__tests__/no-x.test.ts', true],
    ['src/__tests__/helpers/read-tree.ts', true],
    ['test/browser-global-setup.mjs', true],
    ['scripts/lib/load-config.mjs', true],
    ['src/foo.fixture.ts', true],
    ['src/server/services/content.service.ts', false],
  ])('isReaderCandidate(%s) is %s', (f, want) => {
    expect(isReaderCandidate(f)).toBe(want);
  });

  it('reads the test:lint-rules file list from package.json', () => {
    const pkg = JSON.stringify({
      scripts: {
        'test:lint-rules': "vitest run --project 'unit*' src/a/no-x.test.ts src/b/y.guard.test.ts",
      },
    });
    expect(lintRulesFiles(pkg)).toEqual(['src/a/no-x.test.ts', 'src/b/y.guard.test.ts']);
  });

  it('the real test:lint-rules list is non-empty and names the convention guards', () => {
    const pkg = readFileSync(resolve(__dirname, '../../package.json'), 'utf8');
    expect(lintRulesFiles(pkg)).toContain(
      'src/server/services/__tests__/no-lint-rules-script-drift.test.ts'
    );
  });
});

describe('ledger', () => {
  const root = '/repo';
  const report = (files: [string, string][]) => ({
    testResults: files.map(([name, status]) => ({ name: `${root}/${name}`, status })),
  });
  const sel = {
    sha: 'h',
    base: 'b',
    projects: {
      unit: { mode: 'scoped', total: 10, selected: ['src/a.test.ts', 'src/g.test.ts'] },
      component: { mode: 'full', total: 5, reason: 'pnpm-lock.yaml: lockfile' },
    },
  };

  it('records failures outside a scoped selection as misses', () => {
    const r = ledger(
      sel,
      [
        report([
          ['src/a.test.ts', 'failed'],
          ['src/z.test.ts', 'failed'],
          ['src/g.test.ts', 'passed'],
          ['src/x/X.browser.test.tsx', 'failed'],
        ]),
      ],
      { root, runId: '42', event: 'push' }
    );
    expect(r).toEqual({
      v: 1,
      run_id: '42',
      enforced: false,
      sha: 'h',
      base: 'b',
      event: 'push',
      fallback: null,
      projects: {
        unit: {
          mode: 'scoped',
          reason: null,
          selected: 2,
          total: 10,
          ran: true,
          failed: ['src/a.test.ts', 'src/z.test.ts'],
          failed_outside_selection: ['src/z.test.ts'],
          not_run: [],
        },
        component: {
          mode: 'full',
          reason: 'pnpm-lock.yaml: lockfile',
          selected: 5,
          total: 5,
          ran: true,
          failed: ['src/x/X.browser.test.tsx'],
          failed_outside_selection: [],
          not_run: [],
        },
      },
    });
  });

  it('marks a suite that did not run in this run', () => {
    expect(ledger(sel, [], { root, runId: '1', event: 'pull_request' }).projects.unit.ran).toBe(
      false
    );
  });

  it('on an enforced scoped run, lists selected files vitest never reported', () => {
    const enforced = {
      ...sel,
      enforced: true,
      projects: { unit: { ...sel.projects.unit, scopedRun: true } },
    };
    const r = ledger(enforced, [report([['src/a.test.ts', 'passed']])], {
      root,
      runId: '1',
      event: 'push',
    });
    expect(r.projects.unit.not_run).toEqual(['src/g.test.ts']);
  });
});

describe('unitPlan', () => {
  const scoped = (n: number) => ({
    projects: { unit: { mode: 'scoped', total: 5108, selected: Array(n).fill('f') } },
  });
  it('is the full four shards unless enforced', () => {
    expect(unitPlan(scoped(900), false)).toEqual({ scoped: false, shards: [1, 2, 3, 4] });
  });
  it('packs an enforced selection into as few shards as a full shard holds', () => {
    expect(unitPlan(scoped(900), true)).toEqual({ scoped: true, shards: [1] });
    expect(unitPlan(scoped(1278), true)).toEqual({ scoped: true, shards: [1, 2] });
  });
  it('stays full when the packed selection would need every shard anyway', () => {
    expect(unitPlan(scoped(3900), true)).toEqual({ scoped: false, shards: [1, 2, 3, 4] });
  });
  it('stays full when the selection fell back', () => {
    expect(unitPlan({ projects: { unit: { mode: 'full', total: 5108 } } }, true)).toEqual({
      scoped: false,
      shards: [1, 2, 3, 4],
    });
  });
});

describe('select fails open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-selection-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const repo = resolve(__dirname, '../..');

  it('runs everything with no usable base', async () => {
    const r = await select('-', join(dir, 'a.json'), repo, async () => {
      throw new Error('must not build a graph without a base');
    });
    expect(r.projects).toEqual({
      unit: { mode: 'full', reason: 'no usable base (-): nothing to diff against' },
      component: { mode: 'full', reason: 'no usable base (-): nothing to diff against' },
    });
  });

  // A re-run of an old red run: the last successful run is NEWER than this HEAD, so `base...HEAD`
  // is empty and would scope down to the always-run set.
  it('runs everything when the base is not an ancestor of HEAD', async () => {
    const g = join(dir, 'repo');
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', g, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
        encoding: 'utf8',
      }).trim();
    execFileSync('git', ['init', '-q', g]);
    git('commit', '-q', '--allow-empty', '-m', 'a');
    const a = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'b');
    const b = git('rev-parse', 'HEAD');
    git('checkout', '-q', a);
    const r = await select(b, join(dir, 'c.json'), g, async () => {
      throw new Error('must not build a graph for a descendant base');
    });
    expect(r.projects.unit).toEqual({
      mode: 'full',
      reason: `no usable base (${b}): nothing to diff against`,
    });
  });

  it('runs everything when the graph walk throws', async () => {
    const r = await select('HEAD', join(dir, 'b.json'), repo, async () => {
      throw new Error('boom');
    });
    expect(r.projects.unit).toEqual({ mode: 'full', reason: 'selector error: boom' });
    expect(JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')).projects.component.mode).toBe(
      'full'
    );
  });
});

describe('nightly-bisect helpers', () => {
  it('splits failed files by project', () => {
    expect(
      failedByProject(
        [
          {
            testResults: [
              { name: '/r/src/a.test.ts', status: 'failed' },
              { name: '/r/src/B.browser.test.tsx', status: 'failed' },
              { name: '/r/src/c.test.ts', status: 'passed' },
            ],
          },
        ],
        '/r'
      )
    ).toEqual({ unit: ['src/a.test.ts'], component: ['src/B.browser.test.tsx'] });
  });

  it('reads the first bad commit from git bisect output', () => {
    const sha = 'a'.repeat(40);
    expect(parseFirstBad(`running node step\n${sha} is the first bad commit\ncommit ${sha}`)).toBe(
      sha
    );
    expect(parseFirstBad('bisect found only skipped commits')).toBeNull();
  });
});
