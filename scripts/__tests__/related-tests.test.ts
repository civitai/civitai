import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAP,
  SCANNERS_FILE,
  checkManifest,
  checkShardLists,
  forcedReason,
  importClosure,
  isSmoke,
  parseManifest,
  missingFromReport,
  parseNameStatus,
  planRun,
  splitShards,
  summaryLines,
} from '../ci/related-tests.mjs';

// scripts/ci/related-tests.mjs decides what the per-PR unit tier runs: the related selection plus
// the smoke set, or the smoke set alone ("deferred to batch"). A wrong "related" answer on a
// change the import graph cannot follow reads as a green PR tier over tests that never ran, so the
// fallback rule is what this file pins. Fixture paths are pairwise distinct, and none of them is a
// smoke file unless the test says so, so a selection can never be satisfied by the smoke set alone.

const SMOKE = [
  'src/server/services/__tests__/no-raw-sql.test.ts',
  'scripts/__tests__/feed-go-basemodels.schema-drift.test.ts',
];

describe('forcedReason: which changes the import graph cannot follow', () => {
  it.each([
    ['vitest.config.mts', 'vitest/vite config'],
    ['apps/moderator/vite.config.ts', 'vitest/vite config'],
    ['test/component-setup.tsx', 'test setup (test/)'],
    ['src/server/__tests__/fixtures/payload.ts', 'test fixtures'],
    ['packages/civitai-shared/tsconfig.build.json', 'tsconfig'],
    ['package.json', 'package.json'],
    ['packages/civitai-flipt/package.json', 'package.json'],
    ['pnpm-lock.yaml', 'dependencies / toolchain'],
    ['patches/next@16.3.0.patch', 'dependency patches'],
    ['prisma/schema.prisma', 'Prisma schema'],
    ['packages/civitai-db-schema/src/enums.ts', 'generated db-schema package'],
    ['scripts/test-cache/core.mjs', 'test-cache scripts'],
    ['.github/workflows/lint.yml', 'CI workflows'],
    ['event-engine-common', 'submodule pin'],
  ])('%s forces the fallback (%s)', (file, reason) => {
    expect(forcedReason(file)).toBe(`${reason}: ${file}`);
  });

  // A test may read any of these with readFileSync; no import graph names them.
  it.each(['src/server/sql/hot-read.sql', 'public/images/logo.png', 'CLAUDE.md', '.env-example'])(
    'a non-source file is forced: %s',
    (file) => {
      expect(forcedReason(file)).toBe(
        `not import-visible (a test may read it at runtime): ${file}`
      );
    }
  );

  it('a modified or added source file is not forced', () => {
    expect(forcedReason('src/server/services/model.service.ts', 'M')).toBeNull();
    expect(forcedReason('src/utils/new-helper.tsx', 'A')).toBeNull();
  });

  // Its importers no longer resolve, so the graph cannot list them.
  it.each(['D', 'R100'])('a source file with status %s is forced', (status) => {
    expect(forcedReason('src/server/utils/old-name.ts', status)).toBe(
      'source file removed or renamed (its importers cannot be traced): src/server/utils/old-name.ts'
    );
  });

  it('docs trees force nothing', () => {
    expect(forcedReason('docs/testing/reading-ci-results.md')).toBeNull();
    expect(forcedReason('claudedocs/handoff.md')).toBeNull();
  });

  // No apps exception: a non-source file under apps/<app>/, or an app's manifest, forces the
  // fallback like any other (the cheaper mention rule was not sound and was removed).
  it('a non-source file or manifest under apps/<app>/ is forced', () => {
    expect(forcedReason('apps/feed-go/internal/rank.go')).toBe(
      'not import-visible (a test may read it at runtime): apps/feed-go/internal/rank.go'
    );
    expect(forcedReason('apps/auth/package.json')).toBe('package.json: apps/auth/package.json');
    expect(forcedReason('apps/auth/vitest.config.ts')).toBe(
      'vitest/vite config: apps/auth/vitest.config.ts'
    );
  });

  // The setup closure (the unit setup files and every module they import) comes from the config at
  // run time; forcedReason takes it as a set. Mutant: drop the `setup.has` line and both forced
  // cases below return null (killed).
  it('a setup file, or any module it imports transitively, is forced; other source is not', () => {
    const setup = new Set([
      'src/__tests__/setup.ts',
      'src/__tests__/rsa-test-key.ts',
      'src/mocks/notifications-client.mock.ts',
    ]);
    expect(forcedReason('src/__tests__/setup.ts', 'M', setup)).toBe(
      'unit setup file or a module it imports: src/__tests__/setup.ts'
    );
    expect(forcedReason('src/mocks/notifications-client.mock.ts', 'M', setup)).toBe(
      'unit setup file or a module it imports: src/mocks/notifications-client.mock.ts'
    );
    expect(forcedReason('src/server/services/model.service.ts', 'M', setup)).toBeNull();
    // With no closure (e.g. a caller that does not pass one) nothing is forced by it.
    expect(forcedReason('src/__tests__/rsa-test-key.ts')).toBeNull();
  });
});

describe('importClosure: the setup files and everything they import', () => {
  const graph: Record<string, string[]> = {
    '/r/src/__tests__/setup.ts': ['/r/src/__tests__/rsa-test-key.ts', '/r/src/mocks/a.mock.ts'],
    '/r/src/mocks/a.mock.ts': ['/r/src/mocks/b.ts', '/r/src/__tests__/setup.ts'],
    '/r/src/mocks/b.ts': [],
    '/r/src/__tests__/network-guard.ts': [],
    '/r/src/unrelated.ts': ['/r/src/mocks/b.ts'],
  };
  // Mutant: visit only direct imports and `b.ts` (two hops) is missing (killed).
  it('follows imports transitively, once each, cycles included; nothing it does not reach', async () => {
    const got = await importClosure(
      ['/r/src/__tests__/setup.ts', '/r/src/__tests__/network-guard.ts'],
      async (f: string) => graph[f] ?? []
    );
    expect([...got].sort()).toEqual([
      '/r/src/__tests__/network-guard.ts',
      '/r/src/__tests__/rsa-test-key.ts',
      '/r/src/__tests__/setup.ts',
      '/r/src/mocks/a.mock.ts',
      '/r/src/mocks/b.ts',
    ]);
    expect(got.has('/r/src/unrelated.ts')).toBe(false);
  });

  it('a transitive import forces the plan; a file the setup does not import does not', () => {
    const setup = new Set(['src/__tests__/setup.ts', 'src/mocks/b.ts']);
    expect(
      planRun({ changes: [{ status: 'M', file: 'src/mocks/b.ts' }], smoke: SMOKE, setup }).mode
    ).toBe('smoke');
    expect(
      planRun({
        changes: [{ status: 'M', file: 'src/unrelated.ts' }],
        smoke: SMOKE,
        related: () => ['src/__tests__/unrelated.test.ts'],
        setup,
      }).mode
    ).toBe('related');
  });
});

describe('isSmoke: the smoke set, by name or by the scanner list', () => {
  it.each([
    'src/server/services/__tests__/no-raw-sql.test.ts',
    'src/server/__tests__/routes.ledger.test.ts',
    'src/server/__tests__/auth.seam.test.ts',
    'src/server/services/__tests__/moderator-delete-hold-parity.test.ts',
    'scripts/__tests__/feed-go-basemodels.schema-drift.test.ts',
    // case-insensitive: a camelCase `Parity` is a parity test too
    'src/components/AppBlocks/hostHandlerParity.test.ts',
  ])('%s is in it by name', (f) => expect(isSmoke(f)).toBe(true));

  // Mutant: drop `scanners.has(file)` and the listed file is out (killed).
  it('a listed scanner is in it; the same file unlisted is not', () => {
    const f = 'src/components/Apps/__tests__/appListingDescriptionCallSites.test.ts';
    expect(isSmoke(f, new Set([f]))).toBe(true);
    expect(isSmoke(f, new Set())).toBe(false);
  });

  // Unlisted, and no name pattern: out.
  it.each([
    'src/server/services/__tests__/model.service.test.ts',
    // `no-` must start the file name, not a directory
    'src/no-dir/__tests__/thing.test.ts',
  ])('%s is not in it', (f) => expect(isSmoke(f, new Set())).toBe(false));

  // Outside the unit project: out even when listed (checkManifest rejects such a listing).
  it.each([
    'src/components/__tests__/no-overflow.browser.test.tsx',
    'apps/moderator/src/no-thing.test.ts',
  ])('%s is not in it, even listed', (f) => expect(isSmoke(f, new Set([f]))).toBe(false));
});

// The list is checked in, so it can rot: a renamed or deleted scanner would silently leave the
// smoke set. checkManifest names every bad path, and the job fails on any (see run()).
describe('the scanner list', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  it('parses one path per line, dropping comments and blanks', () => {
    expect(parseManifest('# header\n\nsrc/a.test.ts\n  scripts/b.test.ts  # note\n')).toEqual([
      'src/a.test.ts',
      'scripts/b.test.ts',
    ]);
  });

  // The guard, shown failing: each bad entry is named. Mutant: return [] and all three go missing.
  it('names a missing path, a non-test path and a duplicate', () => {
    const present = new Set(['src/x/a.test.ts']);
    expect(
      checkManifest(
        ['src/x/a.test.ts', 'src/x/gone.test.ts', 'src/x/a.ts', 'src/x/a.test.ts'],
        (f: string) => present.has(f)
      )
    ).toEqual([
      `${SCANNERS_FILE}: no such file: src/x/gone.test.ts`,
      `${SCANNERS_FILE}: not a unit-project test file (src|scripts/**/*.test.ts): src/x/a.ts`,
      `${SCANNERS_FILE}: listed twice: src/x/a.test.ts`,
    ]);
  });

  // The real file, against the tree: sound, non-empty, and no entry a name pattern already covers
  // (those would be listed for nothing).
  it('the checked-in list is sound', () => {
    const paths = parseManifest(readFileSync(path.join(ROOT, SCANNERS_FILE), 'utf8'));
    expect(paths.length).toBeGreaterThan(100);
    expect(checkManifest(paths, (f: string) => existsSync(path.join(ROOT, f)))).toEqual([]);
    expect(paths.filter((f) => isSmoke(f))).toEqual([]);
  });
});

describe('parseNameStatus', () => {
  it('reads add / modify / delete, and a rename as old (R) + new (A)', () => {
    expect(
      parseNameStatus(
        'M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.ts\nR087\tsrc/old.ts\tsrc/new.ts\nC100\tsrc/d.ts\tsrc/e.ts\n'
      )
    ).toEqual([
      { status: 'M', file: 'src/a.ts' },
      { status: 'A', file: 'src/b.ts' },
      { status: 'D', file: 'src/c.ts' },
      { status: 'R087', file: 'src/old.ts' },
      { status: 'A', file: 'src/new.ts' },
      { status: 'A', file: 'src/e.ts' },
    ]);
  });
});

describe('planRun: related, or smoke only and deferred', () => {
  const related = [
    'src/server/services/__tests__/model.service.test.ts',
    'src/utils/__tests__/x.test.ts',
  ];

  it('a source-only change runs the smoke set plus its related files', () => {
    const p = planRun({
      changes: [{ status: 'M', file: 'src/server/services/model.service.ts' }],
      smoke: SMOKE,
      related: () => related,
    });
    expect(p.mode).toBe('related');
    expect(p.related).toBe(2);
    expect(p.files).toEqual([...SMOKE, ...related].sort());
  });

  // The guard the whole fallback exists for. Mutation: drop the `if (forced.length)` branch and
  // this returns mode 'related' with the related files; killed by the mode and files assertions.
  it('a forced trigger runs the smoke set only, and never consults the selection', () => {
    let asked = false;
    const p = planRun({
      changes: [
        { status: 'M', file: 'src/server/services/model.service.ts' },
        { status: 'M', file: 'pnpm-lock.yaml' },
      ],
      smoke: SMOKE,
      related: () => ((asked = true), related),
    });
    expect(p.mode).toBe('smoke');
    expect(p.files).toEqual([...SMOKE].sort());
    expect(p.reason).toBe('forced trigger (1): dependencies / toolchain: pnpm-lock.yaml');
    expect(asked).toBe(false);
  });

  // Mutation: `>` to `>=`, or comparing against a constant instead of `cap` — the at-cap and
  // over-cap cases below split them. The cap here (3) is not DEFAULT_CAP, so a hard-coded 250
  // passes neither.
  it('a selection over the cap is deferred; one exactly at the cap is not', () => {
    const three = ['src/p.test.ts', 'src/q.test.ts', 'src/r.test.ts'];
    const four = [...three, 'src/s.test.ts'];
    const change = [{ status: 'M', file: 'src/shared/util.ts' }];
    const at = planRun({ changes: change, smoke: SMOKE, related: () => three, cap: 3 });
    expect(at.mode).toBe('related');
    expect(at.files).toHaveLength(SMOKE.length + 3);
    const over = planRun({ changes: change, smoke: SMOKE, related: () => four, cap: 3 });
    expect(over.mode).toBe('smoke');
    expect(over.related).toBe(4);
    expect(over.reason).toBe('related selection is 4 files, over the cap of 3');
    expect(over.files).toEqual([...SMOKE].sort());
  });

  it('defaults the cap to DEFAULT_CAP (250)', () => {
    expect(DEFAULT_CAP).toBe(250);
    const many = Array.from({ length: 251 }, (_, i) => `src/gen/t${i}.test.ts`);
    expect(
      planRun({
        changes: [{ status: 'M', file: 'src/shared/util.ts' }],
        smoke: SMOKE,
        related: () => many,
      }).mode
    ).toBe('smoke');
  });

  // Deleted files are forced (above), so only live source files reach `related`.
  it('hands only the changed source files to `related`', () => {
    let seen: string[] = [];
    planRun({
      changes: [
        { status: 'M', file: 'src/a.ts' },
        { status: 'A', file: 'src/b.tsx' },
      ],
      smoke: SMOKE,
      related: (files: string[]) => ((seen = files), []),
    });
    expect(seen).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('no related tests still runs the smoke set', () => {
    const p = planRun({ changes: [{ status: 'M', file: 'src/lonely.ts' }], smoke: SMOKE });
    expect(p.mode).toBe('related');
    expect(p.files).toEqual([...SMOKE].sort());
  });
});

describe('summaryLines', () => {
  it('a deferred run says "Deferred to batch" with the reason', () => {
    const lines = summaryLines({ mode: 'smoke', reason: 'forced trigger (1): x', files: SMOKE }, 2);
    expect(lines[2]).toBe(
      '**Deferred to batch.** Ran the smoke set only (2 files): forced trigger (1): x.'
    );
  });

  it('a related run does not', () => {
    const lines = summaryLines(
      {
        mode: 'related',
        reason: '1 related file(s) for 1 changed source file(s)',
        files: [...SMOKE, 'a'],
      },
      2
    );
    expect(lines.join('\n')).not.toMatch(/Deferred/);
    expect(lines[2]).toBe(
      'Ran 3 file(s): the smoke set (2) and 1 related file(s) for 1 changed source file(s).'
    );
  });
});

// vitest given a filter that matches nothing exits 0. Mutation: return [] always and the second
// case goes green; killed by its `toEqual`.
describe('missingFromReport', () => {
  const report = {
    testResults: [{ name: '/r/src/a.test.ts' }, { name: '/r/src/extra.test.ts' }],
  };
  it('is empty when every listed file ran (extras are fine)', () => {
    expect(missingFromReport(['src/a.test.ts'], report, '/r')).toEqual([]);
  });
  it('names a listed file the report does not contain', () => {
    expect(missingFromReport(['src/a.test.ts', 'src/b.test.ts'], report, '/r')).toEqual([
      'src/b.test.ts',
    ]);
  });
});

// The 2-way split every shard computes for itself. Every file must land in exactly one shard (a
// file in none is never run; a file in two runs twice), and the split must not depend on input
// order, or two shards would disagree.
describe('splitShards', () => {
  const files = [
    'src/a.test.ts',
    'src/b.test.ts',
    'src/c.test.ts',
    'src/d.test.ts',
    'src/e.test.ts',
  ];

  // Mutant: drop the round-robin and put everything in shard 1 (killed by the sizes).
  it('deals the sorted files round-robin, every file exactly once', () => {
    const got = splitShards(files, 2);
    expect(got).toEqual([
      ['src/a.test.ts', 'src/c.test.ts', 'src/e.test.ts'],
      ['src/b.test.ts', 'src/d.test.ts'],
    ]);
    const all = got.flat();
    expect([...all].sort()).toEqual(files);
    expect(new Set(all).size).toBe(all.length);
  });

  // Mutant: drop the sort, and a reversed input splits differently (killed).
  it('is deterministic: input order and duplicates do not change it', () => {
    expect(splitShards([...files].reverse().concat(files[0]), 2)).toEqual(splitShards(files, 2));
  });

  it('more shards than files leaves the rest empty', () => {
    expect(splitShards(['src/a.test.ts'], 2)).toEqual([['src/a.test.ts'], []]);
  });
});

// The ledger's check that the shards, each planning alone, agreed and covered the plan.
describe('checkShardLists', () => {
  const plan = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
  const ok = [
    { shard: 1, files: plan, mine: ['src/a.test.ts', 'src/c.test.ts'] },
    { shard: 2, files: [...plan].reverse(), mine: ['src/b.test.ts'] },
  ];

  it('passes when both planned the same files and split them exactly', () => {
    expect(checkShardLists(ok, 2)).toEqual({ errors: [], files: plan });
  });

  // Each guard, shown failing. Mutant: return no errors, and every case below goes green.
  it('names a missing shard', () => {
    expect(checkShardLists([ok[0]], 2).errors).toEqual([
      'shard 2/2: no plan uploaded (it did not finish its plan, or its upload failed)',
    ]);
  });

  it('names two shards that planned different files', () => {
    const got = checkShardLists(
      [ok[0], { shard: 2, files: ['src/b.test.ts'], mine: ['src/b.test.ts'] }],
      2
    );
    expect(got.errors[0]).toBe(
      'shard 2 planned 1 files, shard 1 planned 3 files: the shards computed different plans'
    );
  });

  it('names a file in two shards, and a planned file in none', () => {
    expect(
      checkShardLists(
        [
          { shard: 1, files: plan, mine: ['src/a.test.ts', 'src/b.test.ts'] },
          { shard: 2, files: plan, mine: ['src/b.test.ts'] },
        ],
        2
      ).errors
    ).toEqual(['src/b.test.ts: in shard 1 and shard 2', 'src/c.test.ts: planned, in no shard']);
  });

  it('names a file run that was not planned, and a shard outside the matrix', () => {
    expect(
      checkShardLists(
        [...ok.slice(0, 1), { shard: 2, files: plan, mine: ['src/b.test.ts', 'src/x.test.ts'] }],
        2
      ).errors
    ).toEqual(['src/x.test.ts: in a shard, not planned']);
    expect(checkShardLists([...ok, { shard: 3, files: plan, mine: [] }], 2).errors).toContain(
      'shard 3: outside 1..2'
    );
  });
});
