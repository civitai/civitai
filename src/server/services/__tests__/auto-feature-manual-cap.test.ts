import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Eligibility from '~/server/jobs/refresh-featured-collections-eligibility';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';

vi.mock('~/server/jobs/refresh-featured-collections-eligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof Eligibility>()),
  getFeaturedCollectionsState: vi.fn(async () => ({ eligibleIds: [111], checkedAt: new Date() })),
}));

const { aggregateWindowCounts, buildWindowCountsQuery, runAutoFeatureImages } = await import(
  '~/server/services/auto-feature-images.service'
);

const AUTO_USER = 42;
const CAPPED_CREATOR = 777;
const OTHER_CREATOR = 778;

const block = { id: 388990, metadata: {} as HomeBlockMetaSchema };

const metadata = () =>
  ({
    featuredCollections: {
      collectionIds: [111],
      limit: 40,
      rows: 2,
      renderCount: 3,
      nameSnapshots: {},
      writeSnapshots: {},
      autoFeature: {
        collectionId: 107,
        dryRun: true,
        perRun: 5,
        windowDays: 7,
        capWindowDays: 7,
        maxPerCreatorInWindow: 2,
      },
    },
  } as unknown as HomeBlockMetaSchema);

/** One candidate per creator, so a missing pick can only mean the cap refused it. */
const candidateRows = () => [
  { imageId: 1, userId: CAPPED_CREATOR, collectionId: 111, curatedAt: new Date(), reactions: 500n },
  { imageId: 2, userId: OTHER_CREATOR, collectionId: 111, curatedAt: new Date(), reactions: 400n },
];

/**
 * Two prior features for one creator, neither carrying a source — the shape a manual feature has,
 * since only the job writes the `auto-featured:<id>` note.
 */
const manualWindowRows = (userId: number) => [
  { userId, source: null },
  { userId, source: null },
];

/**
 * Routes each of the service's two queries to its own fixture by matching the built SQL — and
 * honours the one WHERE clause this change is about.
 *
 * Without that last part these tests cannot fail: a fixture handed back verbatim proves only that
 * selection consumes the counts it is given, which was never broken. Restoring the old
 * `AND ci."addedById" = ...` filter left every behavioural assertion here green until the fake
 * started applying it. It deliberately simulates exactly one predicate, not SQL in general — if
 * the query filters rows to the job's own, so does the fake.
 */
const respondWith = (windowRows: { userId: number; source: string | null }[]) =>
  dbMock.dbRead.$queryRaw.mockImplementation(async (query: unknown) => {
    const sql = (query as { sql?: string })?.sql ?? '';
    if (sql.includes('ImageReaction')) return candidateRows();
    if (sql.includes('split_part')) {
      const countsAutoRowsOnly = /WHERE[\s\S]*"addedById" =/.test(sql);
      return countsAutoRowsOnly ? windowRows.filter((row) => row.source !== null) : windowRows;
    }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockClear();
  dbMock.dbRead.homeBlock.findFirst.mockImplementation(async () => block);
  dbMock.dbRead.user.findFirst.mockImplementation(async () => ({ id: AUTO_USER }));
  block.metadata = metadata();
});

// The cap counted only rows the job itself had added, so a creator featured by hand held slots the
// cap could not see. Measured on production before this change: `maxPerCreatorInWindow: 2` allowed
// 4 features in one week, and 8 of 279 automatic picks over 18 days went to a creator who already
// held a manual feature.
describe('per-creator cap counts manual features', () => {
  it('refuses a creator whose window is full of MANUAL features', async () => {
    respondWith(manualWindowRows(CAPPED_CREATOR));

    const result = await runAutoFeatureImages();

    expect(result).toMatchObject({ picked: 1 });
    expect('picks' in result && result.picks.map((p) => p.userId)).toEqual([OTHER_CREATOR]);
  });

  // The control. Without it the assertion above passes for any change that stops picking the
  // higher-scoring creator at all — including one that breaks scoring outright.
  it('still picks that creator when the manual features belong to someone else', async () => {
    respondWith(manualWindowRows(OTHER_CREATOR));

    const result = await runAutoFeatureImages();

    expect(result).toMatchObject({ picked: 1 });
    expect('picks' in result && result.picks.map((p) => p.userId)).toEqual([CAPPED_CREATOR]);
  });

  it('reports what the caps refused, so a short run is not silent', async () => {
    respondWith(manualWindowRows(CAPPED_CREATOR));

    const result = await runAutoFeatureImages();

    expect(result).toMatchObject({
      target: 5,
      picked: 1,
      scored: 2,
      blocked: { creatorWindow: 1, collectionWindow: 0 },
    });
  });
});

describe('buildWindowCountsQuery', () => {
  const sql = () =>
    (
      buildWindowCountsQuery({
        targetCollectionId: 107,
        capWindowDays: 7,
        autoFeatureUserId: AUTO_USER,
      }) as { sql: string }
    ).sql;

  it('does not filter the rows it counts by who added them', () => {
    // Pinned as a negative because the bug was a WHERE clause: with the filter present the query
    // returns only the job's own rows, and every assertion about creator counts above still passes
    // against a fixture that hands them back directly.
    expect(sql()).toContain('FROM "CollectionItem"');
    expect(sql()).not.toMatch(/WHERE[\s\S]*"addedById" =/);
  });

  it('attributes a source collection only to the job’s own rows', () => {
    expect(sql()).toContain('CASE');
    expect(sql()).toContain('split_part');
  });
});

describe('aggregateWindowCounts', () => {
  it('counts a manual row toward its creator but toward no collection', () => {
    const { creatorCounts, collectionCounts } = aggregateWindowCounts([
      { userId: 1, source: null },
      { userId: 1, source: '999' },
    ]);

    expect(creatorCounts.get(1)).toBe(2);
    expect(collectionCounts.get(999)).toBe(1);
    // `Number(null)` is 0, so a lost guard files every manual feature under a collection that does
    // not exist and quietly caps it. This is the assertion that catches that.
    expect(collectionCounts.get(0)).toBeUndefined();
    expect(collectionCounts.size).toBe(1);
  });
});
