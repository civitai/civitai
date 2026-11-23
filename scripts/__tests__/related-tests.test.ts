import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAP,
  forcedReason,
  isSmoke,
  mentionKey,
  missingFromReport,
  parseNameStatus,
  planRun,
  selectByMention,
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
    ['src/__tests__/setup.ts', 'unit setup file'],
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

  // The apps exception: an app's own non-source files and manifest select by mention instead.
  it('a non-source file or manifest under apps/<app>/ is not forced', () => {
    expect(forcedReason('apps/feed-go/internal/rank.go')).toBeNull();
    expect(forcedReason('apps/auth/package.json')).toBeNull();
    // …but a vite config under an app still is (FORCED is checked before the exception).
    expect(forcedReason('apps/auth/vitest.config.ts')).toBe(
      'vitest/vite config: apps/auth/vitest.config.ts'
    );
  });
});

describe('mentionKey / selectByMention', () => {
  it('keys a non-source app file on apps/<app>, and nothing else', () => {
    expect(mentionKey('apps/feed-go/internal/rank.go')).toBe('apps/feed-go');
    expect(mentionKey('apps/auth/src/token.ts')).toBeNull();
    expect(mentionKey('src/server/sql/x.sql')).toBeNull();
  });

  it('selects the test files whose text names a key', () => {
    const text: Record<string, string> = {
      'scripts/__tests__/ports-touched.test.ts': "read('apps/feed-go/go.mod')",
      'src/server/a.test.ts': "import x from './a'",
      'src/server/b.test.ts': "path.join('apps/auth', 'x')",
    };
    expect(selectByMention(['apps/feed-go'], Object.keys(text), (f) => text[f])).toEqual([
      'scripts/__tests__/ports-touched.test.ts',
    ]);
    expect(selectByMention([], Object.keys(text), (f) => text[f])).toEqual([]);
  });
});

describe('isSmoke: the repo-scan smoke set', () => {
  it.each([
    'src/server/services/__tests__/no-raw-sql.test.ts',
    'src/server/__tests__/routes.ledger.test.ts',
    'src/server/__tests__/auth.seam.test.ts',
    'src/server/services/__tests__/moderator-delete-hold-parity.test.ts',
    'scripts/__tests__/feed-go-basemodels.schema-drift.test.ts',
  ])('%s is in it', (f) => expect(isSmoke(f)).toBe(true));

  it.each([
    'src/server/services/__tests__/model.service.test.ts',
    // the component project, not unit
    'src/components/__tests__/no-overflow.browser.test.tsx',
    // apps are not in the unit project's include
    'apps/moderator/src/no-thing.test.ts',
    // `no-` must start the file name, not a directory
    'src/no-dir/__tests__/thing.test.ts',
  ])('%s is not', (f) => expect(isSmoke(f)).toBe(false));
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

  // Deleted files are forced (above), so only live source files reach `related`; app non-source
  // files reach `mentioned`, never `related`.
  it('hands source files to `related` and app keys to `mentioned`, separately', () => {
    const seen: { related?: string[]; mentioned?: string[] } = {};
    const p = planRun({
      changes: [
        { status: 'M', file: 'src/a.ts' },
        { status: 'M', file: 'apps/feed-go/x.go' },
        { status: 'A', file: 'apps/feed-go/y.json' },
      ],
      smoke: SMOKE,
      related: (files: string[]) => ((seen.related = files), ['src/__tests__/a.test.ts']),
      mentioned: (keys: string[]) => (
        (seen.mentioned = keys), ['scripts/__tests__/ports-touched.test.ts']
      ),
    });
    expect(seen).toEqual({ related: ['src/a.ts'], mentioned: ['apps/feed-go'] });
    expect(p.mode).toBe('related');
    expect(p.files).toEqual(
      [...SMOKE, 'src/__tests__/a.test.ts', 'scripts/__tests__/ports-touched.test.ts'].sort()
    );
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
