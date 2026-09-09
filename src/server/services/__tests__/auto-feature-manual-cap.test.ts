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
const A_HUMAN = 43;
const CAPPED_CREATOR = 777;
const OTHER_CREATOR = 778;
const SOURCE_COLLECTION = 111;

const block = { id: 388990, metadata: {} as HomeBlockMetaSchema };

const metadata = (autoFeature: Record<string, unknown> = {}) =>
  ({
    featuredCollections: {
      collectionIds: [SOURCE_COLLECTION],
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
        capWindowDays: 30,
        maxPerCreatorInWindow: 2,
        ...autoFeature,
      },
    },
  } as unknown as HomeBlockMetaSchema);

const candidate = (imageId: number, userId: number, reactions: number) => ({
  imageId,
  userId,
  collectionId: SOURCE_COLLECTION,
  curatedAt: new Date(),
  reactions: BigInt(reactions),
});

/** One candidate per creator, so a missing pick can only mean a cap refused it. */
const candidateRows = () => [candidate(1, CAPPED_CREATOR, 500), candidate(2, OTHER_CREATOR, 400)];

const manualRow = (userId: number) => ({ userId, addedById: A_HUMAN, note: null });
const autoRow = (userId: number) => ({
  userId,
  addedById: AUTO_USER,
  note: `auto-featured:${SOURCE_COLLECTION}`,
});

/**
 * Routes the service's two queries to their fixtures, and honours the WHERE clause that the fix is
 * about — including the clause it is NOT keyed on.
 *
 * Without this the tests cannot fail: a fixture returned verbatim proves only that selection
 * consumes the counts it is handed, which was never broken. The first version simulated only
 * `addedById`, so reinstating the OTHER half of the original bug — the `note LIKE` filter alone —
 * left all six assertions green over a fully restored defect. Both clauses are now simulated, and
 * the check looks at the text AFTER the last FROM, so moving a filter into the JOIN or writing it
 * as `IN (…)` or without a space is caught too.
 */
const respondWith = (windowRows: ReturnType<typeof manualRow>[]) =>
  dbMock.dbRead.$queryRaw.mockImplementation(async (query: unknown) => {
    const sql = (query as { sql?: string })?.sql ?? '';
    if (sql.includes('ImageReaction')) return candidateRows();
    if (!sql.includes('"CollectionItem"')) throw new Error(`unexpected query: ${sql.slice(0, 80)}`);

    const filters = sql.slice(sql.lastIndexOf('FROM'));
    let rows = windowRows;
    if (/"addedById"/.test(filters)) rows = rows.filter((r) => r.addedById === AUTO_USER);
    if (/note\s+LIKE/i.test(filters))
      rows = rows.filter((r) => r.note?.startsWith('auto-featured:'));
    return rows;
  });

/** Narrowed once, loudly, so no assertion can pass against the `{ reason }` early-return shape. */
const pickedUserIds = (result: Awaited<ReturnType<typeof runAutoFeatureImages>>) => {
  if (!('picks' in result)) throw new Error(`run returned no picks: ${JSON.stringify(result)}`);
  return result.picks.map((p) => p.userId);
};

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
    // Mixed population on purpose: one auto row for the other creator, so a mutation that counted
    // ONLY manual rows — the mirror image of the bug — cannot pass this.
    respondWith([manualRow(CAPPED_CREATOR), manualRow(CAPPED_CREATOR), autoRow(OTHER_CREATOR)]);

    expect(pickedUserIds(await runAutoFeatureImages())).toEqual([OTHER_CREATOR]);
  });

  it('refuses a creator whose window is full of AUTOMATIC features', async () => {
    respondWith([autoRow(CAPPED_CREATOR), autoRow(CAPPED_CREATOR)]);

    expect(pickedUserIds(await runAutoFeatureImages())).toEqual([OTHER_CREATOR]);
  });

  // The control. Without it the assertions above pass for any change that stops picking the
  // higher-scoring creator at all — including one that breaks scoring outright.
  it('still picks that creator when the features belong to someone else', async () => {
    respondWith([manualRow(OTHER_CREATOR), manualRow(OTHER_CREATOR)]);

    expect(pickedUserIds(await runAutoFeatureImages())).toEqual([CAPPED_CREATOR]);
  });
});

describe('run diagnostics', () => {
  it('attributes a refusal to the window cap', async () => {
    respondWith([manualRow(CAPPED_CREATOR), manualRow(CAPPED_CREATOR)]);

    const result = await runAutoFeatureImages();

    expect(result).toMatchObject({
      target: 5,
      picked: 1,
      scored: 2,
      blocked: { creatorRun: 0, creatorWindow: 1, collectionWindow: 0 },
    });
  });

  // The commonest shortfall in production: `maxPerCreatorPerRun` is 1, so a pool short on distinct
  // creators comes up short with every window cap still slack. The first version of this feature
  // had no bucket for it and logged `blocked: 0` beside `picked < target`.
  it('attributes a refusal to the per-run cap, not the window cap', async () => {
    dbMock.dbRead.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = (query as { sql?: string })?.sql ?? '';
      if (sql.includes('ImageReaction'))
        return [
          candidate(1, CAPPED_CREATOR, 500),
          candidate(2, CAPPED_CREATOR, 400),
          candidate(3, CAPPED_CREATOR, 300),
        ];
      return [];
    });

    const result = await runAutoFeatureImages();

    expect(result).toMatchObject({
      picked: 1,
      scored: 3,
      blocked: { creatorRun: 2, creatorWindow: 0, collectionWindow: 0 },
    });
  });

  // Production leaves `maxPerCollectionInWindow` unset, which makes this bucket a constant 0 —
  // so without a test that sets it, no mutation to the per-collection cap can ever be caught.
  it('attributes a refusal to the per-collection cap when one is configured', async () => {
    // Both candidates come from one source collection and the per-run creator cap is lifted, so
    // the second refusal can only be the per-collection cap.
    block.metadata = metadata({ maxPerCollectionInWindow: 1, maxPerCreatorPerRun: 5 });
    respondWith([]);

    const result = await runAutoFeatureImages();

    expect(result).toMatchObject({
      picked: 1,
      scored: 2,
      blocked: { creatorRun: 0, creatorWindow: 0, collectionWindow: 1 },
    });
  });
});

describe('buildWindowCountsQuery', () => {
  const sql = (capWindowDays = 30) =>
    (buildWindowCountsQuery({ targetCollectionId: 107, capWindowDays }) as { sql: string }).sql;

  /** Everything from the last FROM onward — the join and the filters, not the select list. */
  const filters = () => sql().slice(sql().lastIndexOf('FROM'));

  it('counts every row, whoever added it', () => {
    // Both halves of the original bug are pinned. Keying only on `addedById` left the note filter
    // free to reinstate the whole defect with every test green.
    expect(filters()).toContain('"CollectionItem"');
    expect(filters()).not.toMatch(/"addedById"/);
    expect(filters()).not.toMatch(/note\s+LIKE/i);
  });

  it('hands the provenance columns back for the shared helper to classify', () => {
    const selectList = sql().slice(0, sql().indexOf('FROM'));
    expect(selectList).toContain('"addedById"');
    expect(selectList).toContain('note');
  });

  it('counts only what is actually on the page', () => {
    // `<> 'REJECTED'` was equivalent while every counted row was job-written and therefore
    // ACCEPTED. With manual rows counted it would let an unreviewed submission hold a cap slot.
    expect(filters()).toContain(`status = 'ACCEPTED'`);
  });

  it('measures the window from when a row went live, not when it was submitted', () => {
    // A moderator accepting a month-old submission sets `reviewedAt`; `createdAt` stays at
    // submission time, which would put a feature that is live today outside the window.
    expect(filters()).toMatch(/COALESCE\(ci\."reviewedAt", ci\."createdAt"\)\s*>=/);
  });

  it('measures the cap window, not the candidate-freshness window', () => {
    expect(sql(30)).toContain('days => 30');
    expect(sql(30)).not.toContain('days => 7');
  });
});

describe('aggregateWindowCounts', () => {
  it('counts a manual row toward its creator but toward no collection', () => {
    const { creatorCounts, collectionCounts } = aggregateWindowCounts(
      [manualRow(1), autoRow(1)],
      AUTO_USER
    );

    expect(creatorCounts.get(1)).toBe(2);
    expect(collectionCounts.get(SOURCE_COLLECTION)).toBe(1);
    expect(collectionCounts.size).toBe(1);
  });

  it('files a malformed note under no collection at all', () => {
    // `Number('')` is 0, not NaN, so a note of exactly `auto-featured:` would be filed under a
    // collection that does not exist and quietly cap it. This is the row the `> 0` guard exists
    // for — with only the null check, this test goes red.
    const { creatorCounts, collectionCounts } = aggregateWindowCounts(
      [
        { userId: 1, addedById: AUTO_USER, note: 'auto-featured:' },
        { userId: 1, addedById: AUTO_USER, note: 'auto-featured:not-a-number' },
      ],
      AUTO_USER
    );

    expect(creatorCounts.get(1)).toBe(2);
    expect(collectionCounts.get(0)).toBeUndefined();
    expect(collectionCounts.size).toBe(0);
  });

  it('treats a row as manual when the attribution account is unknown', () => {
    // `getAutoFeatureUserId` returns null when the account is missing. Every row is then manual,
    // which is the safe direction: caps stay tight rather than silently loosening.
    const { creatorCounts, collectionCounts } = aggregateWindowCounts([autoRow(1)], null);

    expect(creatorCounts.get(1)).toBe(1);
    expect(collectionCounts.size).toBe(0);
  });
});
