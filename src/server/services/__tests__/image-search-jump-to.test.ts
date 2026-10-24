import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeilisearchClient from '~/server/meilisearch/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as FeedPrimary from '~/server/services/feed-primary.service';

// The bound is asserted on the filter handed to Meili, because that string is the whole
// behaviour: rows would come from the fake and could not tell a bounded query from the top of
// the creator's feed.

const { fetchDocumentsAbortableMock, fetchFeedPrimary, primaryOn } = vi.hoisted(() => ({
  fetchDocumentsAbortableMock: vi.fn(),
  fetchFeedPrimary: vi.fn(),
  primaryOn: vi.fn(() => false),
}));

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeilisearchClient>()),
  metricsSearchClient: {},
  getMetricsSearchClient: () => ({}),
  fetchDocumentsAbortable: fetchDocumentsAbortableMock,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    getFliptBoolean: vi.fn(async (flag: string) =>
      flag === actual.FLIPT_FEATURE_FLAGS.FEED_SERVICE_PRIMARY ? primaryOn() : false
    ),
  };
});
vi.mock('~/server/services/feed-primary.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedPrimary>()),
  fetchFeedPrimary: (...args: unknown[]) => fetchFeedPrimary(...args),
}));
vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

import {
  getAllImagesIndex,
  getImagesFromSearchPostFilter,
  getImagesFromSearchPreFilter,
} from '../image.service';

const MARCH_2025 = { start: Date.UTC(2025, 2, 1), end: Date.UTC(2025, 3, 1) };
const creatorFeed = {
  userId: 7,
  jumpTo: '2025-03',
  limit: 20,
  period: 'AllTime',
  browsingLevel: 1,
  include: [] as string[],
  headers: { src: 'test' },
};

const sentFilter = () => {
  expect(fetchDocumentsAbortableMock).toHaveBeenCalled();
  const [, request] = fetchDocumentsAbortableMock.mock.calls[0];
  return String((request as { filter: string }).filter);
};
const sortAtClauses = (filter: string) => filter.match(/sortAtUnix [<>]=? \d+/g) ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  fetchDocumentsAbortableMock.mockResolvedValue({ results: [], total: 0 });
});

describe.each([
  ['getImagesFromSearchPreFilter', getImagesFromSearchPreFilter],
  ['getImagesFromSearchPostFilter', getImagesFromSearchPostFilter],
])('%s jump to month', (_name, fn) => {
  type SearchArg = Parameters<typeof getImagesFromSearchPreFilter>[0];
  const search = (input: Record<string, unknown>) => fn(input as unknown as SearchArg);

  it('bounds Newest to before the month ends and Oldest to after it starts', async () => {
    await search({ ...creatorFeed, sort: 'Newest' });
    expect(sortAtClauses(sentFilter())).toEqual([`sortAtUnix < ${MARCH_2025.end}`]);

    vi.clearAllMocks();
    fetchDocumentsAbortableMock.mockResolvedValue({ results: [], total: 0 });
    await search({ ...creatorFeed, sort: 'Oldest' });
    expect(sortAtClauses(sentFilter())).toEqual([`sortAtUnix >= ${MARCH_2025.start}`]);
  });

  it('keeps the bound on a later page', async () => {
    await search({
      ...creatorFeed,
      sort: 'Newest',
      offset: 20,
      entry: MARCH_2025.end - 86_400_000,
    });
    expect(sortAtClauses(sentFilter())).toContain(`sortAtUnix < ${MARCH_2025.end}`);
  });

  it('applies no bound to a sort with no place in time', async () => {
    await search({ ...creatorFeed, sort: 'Most Reactions' });
    expect(sortAtClauses(sentFilter())).toEqual([]);
  });
});

describe('getAllImagesIndex jump to month when the feed cannot serve it', () => {
  const request = (over: Record<string, unknown>) =>
    ({
      ...creatorFeed,
      sort: 'Newest',
      user: { id: 42, isModerator: false },
      ...over,
    } as unknown as Parameters<typeof getAllImagesIndex>[0]);

  beforeEach(() => primaryOn.mockReturnValue(true));

  // The feed's cursor reads as offset 0 on the search index, so without its own bound the
  // fallback serves the newest images under a page the viewer asked to start in March.
  it('keeps the search index inside the month when the feed refuses the page', async () => {
    fetchFeedPrimary.mockResolvedValue({ status: 400, ms: 1, ids: [], error: 'id out of range' });
    await getAllImagesIndex(request({ cursor: 'feed:1741000000000:61000000' }));
    expect(fetchFeedPrimary).toHaveBeenCalledTimes(1);
    expect(sortAtClauses(sentFilter())).toEqual([`sortAtUnix < ${MARCH_2025.end}`]);
  });

  it('keeps the search index inside the month when the feed is down', async () => {
    fetchFeedPrimary.mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await getAllImagesIndex(request({ sort: 'Oldest' }));
    const feedQuery = new URLSearchParams(fetchFeedPrimary.mock.calls[0][0] as string);
    expect(feedQuery.get('cursor')).toBe(`${MARCH_2025.start}|0`);
    expect(sortAtClauses(sentFilter())).toEqual([`sortAtUnix >= ${MARCH_2025.start}`]);
  });
});
