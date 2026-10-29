import { describe, expect, it } from 'vitest';

import { decide, fullRunTriggers, planShards, readsSourceByPath } from '../ci/unit-targets.mjs';

/**
 * scripts/ci/unit-targets.mjs decides whether a PR's unit run is FULL or NARROWED and splits a
 * narrowed selection into jobs. The vitest graph walk itself is not exercised here (it needs the
 * real projects loaded); `decide` takes its outputs as plain lists.
 */

describe('fullRunTriggers', () => {
  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'packages/civitai-auth/package.json',
    'apps/moderator/package.json',
    '.github/workflows/lint.yml',
    'pnpm-workspace.yaml',
    'patches/some-lib@1.0.0.patch',
    '.nvmrc',
    'event-engine-common',
    'tsconfig.json',
    'apps/moderator/tsconfig.app.json',
    'vitest.config.mts',
    'scripts/test-unit-run.mjs',
    'scripts/ci/unit-targets.mjs',
    'scripts/ci/full-run-triggers.mjs',
    'scripts/ci/assert-shard-ran.mjs',
    'scripts/ci/assert-unit-files-ran.mjs',
    // Not modules, so the import graph cannot see who reads them.
    'src/server/services/CLAUDE.md',
    '.claude/rules/testing.md',
    'packages/civitai-db-schema/prisma/schema.full.prisma',
    'src/server/clickhouse/migrations/add-index.sql',
    'src/__tests__/mocks/direct-mock-allowlist.json',
    'apps/knights/src/routes/play/+page.svelte',
    '.github/workflows/other.yml',
    'docs/dev/convention-guards.md',
  ])('forces a full run for %s', (path) => {
    expect(fullRunTriggers([path, 'src/plain-module.ts'])).toEqual([path]);
  });

  it.each([
    'src/server/services/model.service.ts',
    'src/components/Thing/Thing.tsx',
    'scripts/ci/lint-targets.mjs',
    'apps/event-engine/src/vector-sync/backfill.ts',
    'docs/features/some-feature.md',
    'claudedocs/handoff-notes.md',
    'src/server/services/package.json.ts',
  ])('leaves %s to the import graph', (path) => {
    expect(fullRunTriggers([path])).toEqual([]);
  });
});

describe('readsSourceByPath', () => {
  it.each([
    ["import { readdirSync } from 'node:fs';\nreaddirSync(dir);", 'walks a directory'],
    ["import fs from 'fs';\nfs.readFileSync(join(ROOT, 'src/x.service.ts'));", 'names a .ts path'],
    ["import { execFileSync } from 'child_process';\nexecFileSync('git', ['ls-files']);", 'spawns'],
    ["const fs = require('fs/promises');\nawait fs.readdir(d);", 'requires fs/promises'],
    [
      "import { readFileSync } from 'node:fs';\nreadFileSync('apps/x/Page.svelte');",
      'names .svelte',
    ],
  ])('flags a test that %#', (text) => {
    expect(readsSourceByPath(text)).toBe(true);
  });

  it.each([
    // Reads only a non-module fixture: a change to that file forces a full run anyway.
    ["import { readFileSync } from 'node:fs';\nreadFileSync(join(__dirname, 'migration.sql'));"],
    // Names a module path but loads no fs: an ordinary import.
    ["import { thing } from './thing.ts';\nexpect(thing).toBe(1);"],
    ['const files = readdirSync(dir); // no fs import in this text'],
  ])('does not flag %#', (text) => {
    expect(readsSourceByPath(text)).toBe(false);
  });
});

describe('planShards', () => {
  const files = (n: number, prefix = 'src/a') =>
    Array.from({ length: n }, (_, i) => `${prefix}/f${String(i).padStart(4, '0')}.test.ts`);

  it('returns no chunks for an empty selection', () => {
    expect(planShards([], 4000)).toEqual([]);
  });

  it('keeps a selection up to one full shard in one job', () => {
    // 4000 / 4 = 1000 files per shard.
    expect(planShards(files(1000), 4000)?.map((c) => c.length)).toEqual([1000]);
  });

  it('adds a job per full-shard share past that', () => {
    expect(planShards(files(1001), 4000)?.map((c) => c.length)).toEqual([501, 500]);
    expect(planShards(files(2900), 4000)?.map((c) => c.length)).toEqual([967, 967, 966]);
  });

  it('gives up (full run) past three jobs', () => {
    expect(planShards(files(3001), 4000)).toBeNull();
  });

  it('puts every file in exactly one chunk', () => {
    const input = files(2500);
    const chunks = planShards(input, 4000)!;
    expect(chunks.flat().sort()).toEqual(input);
  });
});

describe('decide', () => {
  const allTests = ['src/a.test.ts', 'src/b.test.ts', 'src/guard.test.ts', 'scripts/c.test.ts'];

  it('is full, with the trigger, when the PR changes a dependency', () => {
    expect(
      decide({ changed: ['pnpm-lock.yaml', 'src/a.ts'], allTests, related: [], sourceReaders: [] })
    ).toEqual({ mode: 'full', reason: 'trigger', triggers: ['pnpm-lock.yaml'] });
  });

  it('selects the related tests plus the source readers, in one job', () => {
    const r = decide({
      changed: ['src/b.ts'],
      allTests,
      related: ['src/b.test.ts'],
      sourceReaders: ['src/guard.test.ts'],
    });
    expect(r.mode).toBe('narrowed');
    expect(r.selected).toEqual(['src/b.test.ts', 'src/guard.test.ts']);
    expect(r.chunks).toEqual([['src/b.test.ts', 'src/guard.test.ts']]);
  });

  it('selects nothing, explicitly, when nothing changed', () => {
    expect(
      decide({ changed: [], allTests, related: [], sourceReaders: ['src/guard.test.ts'] })
    ).toEqual({ mode: 'narrowed', selected: [], chunks: [] });
  });

  it('drops selections outside the unit projects', () => {
    const r = decide({
      changed: ['src/b.ts'],
      allTests,
      related: ['src/b.test.ts', 'src/Comp.browser.test.tsx'],
      sourceReaders: [],
    });
    expect(r.selected).toEqual(['src/b.test.ts']);
  });

  it('refuses a selection that leaves out a changed test file', () => {
    // The graph walk must at least find the test files the PR edited; an empty related set here
    // is the silent zero an unresolved base or an unloaded project would produce.
    expect(() =>
      decide({ changed: ['src/a.test.ts'], allTests, related: [], sourceReaders: [] })
    ).toThrow('src/a.test.ts');
  });

  it('falls back to full when the selection needs more than three jobs', () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/t${i}.test.ts`);
    const r = decide({
      changed: ['src/hub.ts'],
      allTests: many,
      related: many.slice(0, 31),
      sourceReaders: [],
    });
    expect(r.mode).toBe('full');
    expect(r.reason).toBe('size');
  });
});
