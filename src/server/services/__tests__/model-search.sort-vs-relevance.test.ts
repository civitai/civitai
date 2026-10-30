import { describe, it, expect, vi, beforeEach } from 'vitest';

import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * Non-mocked test for the RELEVANCE-vs-SORT ordering inside `runModelSearch`.
 *
 * 🔴 WHY THIS FILE EXISTS: the endpoint tests mock this whole service, so they
 * can only prove `preserveRelevanceOrder` is FORWARDED — not that it does
 * anything. A mutant that made the service ignore the flag entirely
 * (`query && searchIds && preserveRelevanceOrder !== false` → `query &&
 * searchIds`) SURVIVED the endpoint suite with 89/89 green, which is the whole
 * fix reduced to an inert argument. This is the seam that catches it.
 *
 * The defect being pinned: `runModelSearch` restores Meilisearch's relevance
 * order whenever a `query` is present. `getModelsRaw` builds its `orderBy`
 * purely from `sort`, so the rows arrive correctly ordered and this restore
 * then overwrites it — silently. That made "the most popular ANIME models"
 * return relevance-ranked results while "the most popular models" ranked fine.
 */

const { mockGetModelsWithVersions } = vi.hoisted(() => ({
  mockGetModelsWithVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
}));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: undefined,
  withMeili: (_label: string, fn: () => unknown) => fn(),
  MeiliCallTimeoutError: class extends Error {},
  isTransientMeiliError: () => false,
}));
vi.mock('~/server/services/file.service', () => ({ getDownloadFilename: vi.fn() }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/common/model-helpers', () => ({ createModelFileDownloadUrl: vi.fn() }));

import { runModelSearch } from '~/server/services/model-search.service';

/** A row shaped enough to survive the response shaping. */
function row(id: number) {
  return { id, name: `m${id}`, mode: null, modelVersions: [], tagsOnModels: [], user: null };
}

/**
 * The database returns rows in `sort` order. Meilisearch returned the ids in a
 * DIFFERENT (relevance) order. The two orders are deliberately reversed so the
 * result can only match one of them — a fixture where they coincided could not
 * discriminate at all.
 */
const DB_SORTED_ORDER = [3, 2, 1];
const MEILI_RELEVANCE_ORDER = [1, 2, 3];

async function orderOut(extra: Record<string, unknown>) {
  mockGetModelsWithVersions.mockResolvedValue({
    items: DB_SORTED_ORDER.map(row),
    nextCursor: undefined,
  });

  const res = await runModelSearch(
    {
      limit: 10,
      query: 'anime',
      searchIds: MEILI_RELEVANCE_ORDER,
      sort: 'Most Downloaded' as never,
      ...extra,
    },
    {
      browsingLevel: allBrowsingLevelsFlag,
      nsfwImagePassthrough: false,
      user: undefined,
      baseUrlOrigin: 'https://civitai.com',
    } as Parameters<typeof runModelSearch>[1]
  );
  return (res.items as Array<{ id: number }>).map((m) => m.id);
}

describe('🔴 runModelSearch — an explicit sort must survive a text query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserveRelevanceOrder:false keeps the DATABASE order', async () => {
    expect(await orderOut({ preserveRelevanceOrder: false })).toEqual(DB_SORTED_ORDER);
  });

  // 🔴 POSITIVE CONTROL, and the reason the assertion above is not vacuous:
  // without the flag the SAME inputs must come back in relevance order. If both
  // arms returned the same list the test would be measuring nothing.
  it('🔴 POSITIVE CONTROL — the default still restores RELEVANCE order', async () => {
    expect(await orderOut({})).toEqual(MEILI_RELEVANCE_ORDER);
  });

  it('preserveRelevanceOrder:true is explicitly the historical behaviour', async () => {
    expect(await orderOut({ preserveRelevanceOrder: true })).toEqual(MEILI_RELEVANCE_ORDER);
  });

  // 🔴 The flag must not leak into the catalog query as an unknown column
  // filter — it is destructured out before `...data` is spread.
  it('🔴 the flag never reaches the catalog query', async () => {
    await orderOut({ preserveRelevanceOrder: false });
    const passed = mockGetModelsWithVersions.mock.calls[0][0].input;
    expect(passed).not.toHaveProperty('preserveRelevanceOrder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE REGRESSION THE OPT-OUT INTRODUCED, found by a delta audit of the fix.
// `getModelsRaw` adds its id predicate under `if (!!ids?.length)`, so an EMPTY
// searchIds adds NO filter and the query degrades to an unfiltered catalog page.
// The relevance restore had been guarding that BY ACCIDENT (mapping an empty
// array yields []); opting out of the restore removed the accident.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 runModelSearch — a text query with NO hits returns NOTHING', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function withNoHits(extra: Record<string, unknown>) {
    mockGetModelsWithVersions.mockResolvedValue({
      // What the DB hands back when no id filter was applied: the catalog.
      items: [1, 2, 3].map(row),
      nextCursor: undefined,
    });
    const res = await runModelSearch(
      { limit: 10, query: 'zzzqqq', searchIds: [], sort: 'Most Downloaded' as never, ...extra },
      {
        browsingLevel: allBrowsingLevelsFlag,
        nsfwImagePassthrough: false,
        user: undefined,
        baseUrlOrigin: 'https://civitai.com',
      } as Parameters<typeof runModelSearch>[1]
    );
    return (res.items as Array<{ id: number }>).map((m) => m.id);
  }

  it('🔴 empty searchIds yields [] even with the relevance restore OPTED OUT', async () => {
    expect(await withNoHits({ preserveRelevanceOrder: false })).toEqual([]);
  });

  // The historical arm, so the assertion above is a statement about the FLAG
  // rather than about empty arrays in general.
  it('empty searchIds yields [] on the default path too', async () => {
    expect(await withNoHits({})).toEqual([]);
  });

  // 🔴 POSITIVE CONTROL — the fixture DB rows are real and would surface if the
  // guard were absent. Without this, `[]` could just mean "the mock returned
  // nothing" and both assertions above would be vacuous.
  it('🔴 POSITIVE CONTROL — the same rows DO surface when there are hits', async () => {
    mockGetModelsWithVersions.mockResolvedValue({
      items: [3, 2, 1].map(row),
      nextCursor: undefined,
    });
    const res = await runModelSearch(
      {
        limit: 10,
        query: 'anime',
        searchIds: [1, 2, 3],
        sort: 'Most Downloaded' as never,
        preserveRelevanceOrder: false,
      },
      {
        browsingLevel: allBrowsingLevelsFlag,
        nsfwImagePassthrough: false,
        user: undefined,
        baseUrlOrigin: 'https://civitai.com',
      } as Parameters<typeof runModelSearch>[1]
    );
    expect((res.items as Array<{ id: number }>).map((m) => m.id)).toEqual([3, 2, 1]);
  });

  // A no-QUERY sorted read must be untouched by the new branch — that is the
  // whole point of the parity work, and gating on `Boolean(query)` is what
  // keeps it working.
  it('a no-query sorted read still returns rows', async () => {
    mockGetModelsWithVersions.mockResolvedValue({
      items: [3, 2, 1].map(row),
      nextCursor: undefined,
    });
    const res = await runModelSearch(
      { limit: 10, sort: 'Most Downloaded' as never, searchIds: [] },
      {
        browsingLevel: allBrowsingLevelsFlag,
        nsfwImagePassthrough: false,
        user: undefined,
        baseUrlOrigin: 'https://civitai.com',
      } as Parameters<typeof runModelSearch>[1]
    );
    expect((res.items as Array<{ id: number }>).map((m) => m.id)).toEqual([3, 2, 1]);
  });
});
