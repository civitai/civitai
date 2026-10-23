import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as ImageService from '~/server/services/image.service';
import type * as MeilisearchClient from '~/server/meilisearch/client';
import type * as PromClient from '~/server/prom/client';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import type { SessionUser } from '~/types/session';

// Qdrant's payload lags Postgres: an image blocked, unpublished, made private or re-rated a moment
// ago can still be a candidate. These tests pin that the search only ever returns what the
// image fetch path returns, and that the fetch path keeps every visibility filter for an id list.

const h = vi.hoisted(() => ({
  queryWithTimeout: vi.fn(),
  fakeGetAllImages: undefined as undefined | ((input: { ids: number[] }) => unknown),
}));

vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  registerCounter: () => ({ inc: vi.fn() }),
}));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout: h.queryWithTimeout,
}));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeilisearchClient>()),
  metricsSearchClient: {},
  getMetricsSearchClient: () => ({}),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageService>();
  return {
    ...actual,
    getAllImages: (input: Parameters<typeof actual.getAllImages>[0]) =>
      h.fakeGetAllImages
        ? h.fakeGetAllImages(input as { ids: number[] })
        : actual.getAllImages(input),
  };
});
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getAllHiddenForUser: vi.fn().mockResolvedValue({
    hiddenUsers: [{ id: 901 }],
    blockedUsers: [{ id: 902 }],
    blockedByUsers: [{ id: 903 }],
    hiddenTags: [
      { id: 801, hidden: true },
      { id: 802, hidden: false },
    ],
    hiddenImages: [{ id: 109 }, { id: 110, tagId: 801 }, { id: 111, tagId: 802 }],
  }),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: vi.fn().mockResolvedValue([
    {
      type: 'some',
      nsfwLevels: [1],
      disablePoi: true,
      disableMinor: true,
      excludedTagIds: [701],
    },
  ]),
}));

import {
  collectPage,
  searchSemanticImages,
  type CandidateSource,
} from '~/server/services/semantic-image-search.service';

const VIEWER = { id: 500, isModerator: false } as SessionUser;
const PG = 1;

const input = (over: Partial<SemanticImageSearchInput> = {}) =>
  ({ imageId: 1, browsingLevel: PG, limit: 50, ...over } as SemanticImageSearchInput);

/** A Qdrant stand-in that serves a fixed ranking and records how often it was asked. */
function rankedSource(ranking: number[]) {
  const calls: { offset: number; limit: number }[] = [];
  const source: CandidateSource = async ({ offset, limit }) => {
    calls.push({ offset, limit });
    return ranking.slice(offset, offset + limit);
  };
  return { source, calls };
}

/** The image fetch path's verdict: rows for visible ids only, in its own (id) order. */
function visibleOnly(visible: Set<number>) {
  return async ({ ids }: { ids: number[] }) => ({
    items: ids
      .filter((id) => visible.has(id))
      .sort((a, b) => b - a)
      .map((id) => ({ id })),
    nextCursor: undefined,
  });
}

beforeEach(() => {
  h.fakeGetAllImages = undefined;
  h.queryWithTimeout.mockReset().mockRejectedValue(new Error('stop here'));
});

describe('a stale index cannot surface a hidden image', () => {
  // The index still holds all of these; Postgres says only the first, third and last are visible.
  const BLOCKED = 102;
  const UNPUBLISHED_POST = 104;
  const PRIVATE_POST = 105;
  const ABOVE_BROWSING_LEVEL = 106;
  const BLOCKED_CREATOR = 107;
  const ranking = [
    101,
    BLOCKED,
    103,
    UNPUBLISHED_POST,
    PRIVATE_POST,
    ABOVE_BROWSING_LEVEL,
    BLOCKED_CREATOR,
    108,
  ];

  it('returns only what hydration returned, in the index order', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([101, 103, 108]));
    const { source } = rankedSource(ranking);

    const { items } = await searchSemanticImages({
      input: input({ imageId: 1 }),
      user: VIEWER,
      candidateSource: source,
    });

    expect(items.map((x) => x.id)).toEqual([101, 103, 108]);
  });

  it('fills a page from further candidates when hydration drops most of them', async () => {
    // Every fourth candidate is visible.
    const long = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const visible = new Set(long.filter((_, i) => i % 4 === 0));
    h.fakeGetAllImages = visibleOnly(visible);
    const { source, calls } = rankedSource(long);

    const first = await searchSemanticImages({
      input: input({ limit: 3 }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(first.items.map((x) => x.id)).toEqual([1000, 1004, 1008]);
    expect(calls.length).toBeLessThanOrEqual(3);

    const second = await searchSemanticImages({
      input: input({ limit: 3, cursor: first.nextCursor }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(second.items.map((x) => x.id)).toEqual([1012, 1016, 1020]);
  });

  it('ends paging when the index runs out', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([101, 103]));
    const { source } = rankedSource([101, 102, 103]);
    const page = await searchSemanticImages({
      input: input({ limit: 10 }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(page.items.map((x) => x.id)).toEqual([101, 103]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('never returns the source image of "more like this"', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([5, 6, 7]));
    const { source } = rankedSource([5, 6, 7]);
    const { items } = await searchSemanticImages({
      input: input({ imageId: 6 }),
      user: VIEWER,
      candidateSource: source,
    });
    expect(items.map((x) => x.id)).toEqual([5, 7]);
  });

  // The image query has no per-viewer hidden-image filter, so this one is the search's own job.
  it('drops images the viewer hid, and those hidden through a tag they still hide', async () => {
    h.fakeGetAllImages = visibleOnly(new Set([108, 109, 110, 111]));
    const { source } = rankedSource([108, 109, 110, 111]);
    const { items } = await searchSemanticImages({
      input: input(),
      user: VIEWER,
      candidateSource: source,
    });
    expect(items.map((x) => x.id)).toEqual([108, 111]);
  });
});

describe('the hydration query keeps every visibility filter for an id list', () => {
  async function hydrationSql() {
    const { source } = rankedSource([101, 102, 103]);
    await searchSemanticImages({ input: input(), user: VIEWER, candidateSource: source }).catch(
      () => undefined
    );
    expect(h.queryWithTimeout, 'hydration no longer reaches the image query').toHaveBeenCalled();
    const stmt = h.queryWithTimeout.mock.calls[0][2] as { text: string; values: unknown[] };
    return { text: stmt.text.replace(/\s+/g, ' '), values: stmt.values };
  }

  it.each([
    ['the candidate ids', /i\."id" = ANY\(\$\d+::int\[\]\)/],
    ['published posts only', /\(p\."publishedAt" < now\(\)\)/],
    [
      'no private posts or blocked ingestion',
      /p\."availability" != \$\d+ AND i\."ingestion" != 'Blocked'/,
    ],
    ['no blocked images', /i\."blockedFor" IS NULL/],
    ['no images awaiting review', /i\."needsReview" IS NULL/],
    ["the viewer's browsing level", /\(i\."nsfwLevel" & \$\d+\) != 0 AND i\."nsfwLevel" != 0/],
    ['the person-of-interest add-on', /i\."poi" != TRUE/],
    ['the minor add-on', /i\."minor" != TRUE/],
    ['hidden and blocked creators', /i\."userId" != ALL\(\$\d+::int\[\]\)/],
    ['hidden tags', /NOT EXISTS \( SELECT 1 FROM "TagsOnImageDetails" toi/],
  ])('%s', async (_name, clause) => {
    const { text } = await hydrationSql();
    expect(text).toMatch(clause);
  });

  it("binds the viewer's hidden users and tags, and the add-on's tags", async () => {
    const { values } = await hydrationSql();
    expect(values).toContainEqual(expect.arrayContaining([901, 902, 903]));
    expect(values).toEqual(expect.arrayContaining([801, 701]));
    expect(values).not.toContain(802);
  });
});

describe('collectPage', () => {
  it('stops after a bounded number of rounds when nothing hydrates', async () => {
    const { source, calls } = rankedSource(Array.from({ length: 5000 }, (_, i) => i + 1));
    const page = await collectPage({
      candidates: (offset, limit) =>
        source({ query: 1, filter: { must: [], must_not: [] }, offset, limit }),
      hydrate: async () => [],
      offset: 0,
      limit: 10,
    });
    expect(page.items).toEqual([]);
    expect(calls.length).toBe(3);
    expect(page.nextCursor).toBe(90);
  });
});
