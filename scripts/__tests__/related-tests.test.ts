import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAP,
  forcedReason,
  importClosure,
  isSmoke,
  missingFromReport,
  parseNameStatus,
  planRun,
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

describe('isSmoke: the smoke set, by name or by content', () => {
  it.each([
    'src/server/services/__tests__/no-raw-sql.test.ts',
    'src/server/__tests__/routes.ledger.test.ts',
    'src/server/__tests__/auth.seam.test.ts',
    'src/server/services/__tests__/moderator-delete-hold-parity.test.ts',
    'scripts/__tests__/feed-go-basemodels.schema-drift.test.ts',
    // case-insensitive: a camelCase `Parity` is a parity test too
    'src/components/AppBlocks/hostHandlerParity.test.ts',
  ])('%s is in it by name', (f) => expect(isSmoke(f, '')).toBe(true));

  // The content rule: a test that reads files. Mutant: drop READS_FILES from isSmoke and every
  // case here goes false (killed).
  it.each([
    ["readFileSync(path.join(ROOT, 'src/x.ts'), 'utf8')"],
    ['const files = readdirSync(dir)'],
    ["await readFile(new URL('../a.ts', import.meta.url))"],
    ["import { readFile } from 'node:fs/promises';"],
    ["import fg from 'fast-glob';"],
    ['const hits = globSync("src/**/*.tsx")'],
    ['await fs.promises.readdir(SRC)'],
  ])('a test whose text has %s is in it', (text) =>
    expect(
      isSmoke('src/components/Apps/__tests__/appListingDescriptionCallSites.test.ts', text)
    ).toBe(true)
  );

  it.each([
    [
      'src/server/services/__tests__/model.service.test.ts',
      "import { x } from '../model.service';",
    ],
    // `existsSync` and writes are not reads of the tree
    ['src/server/utils/__tests__/tmp.test.ts', 'writeFileSync(tmp, "x"); existsSync(tmp)'],
    // the component project, not unit, whatever it reads
    ['src/components/__tests__/no-overflow.browser.test.tsx', 'readFileSync(x)'],
    // apps are not in the unit project's include
    ['apps/moderator/src/no-thing.test.ts', 'readFileSync(x)'],
    // `no-` must start the file name, not a directory
    ['src/no-dir/__tests__/thing.test.ts', ''],
  ])('%s is not in it', (f, text) => expect(isSmoke(f, text)).toBe(false));
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
