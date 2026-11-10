import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as MeilisearchClient from '~/server/meilisearch/client';

// Which image reads the shared query cache keeps, and that a signed-in collection read is keyed per
// viewer. Mock recipe follows collection-review-image-read.test.ts.

const { cached } = vi.hoisted(() => ({
  cached: [] as { ttl: number; query: { text: string; values: unknown[] } }[],
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof MeilisearchClient>();
  return { ...actual, metricsSearchClient: {}, getMetricsSearchClient: () => ({}) };
});
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

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserCollectionPermissionsById: vi.fn().mockResolvedValue({ read: true }),
}));

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  queryCacheRaw:
    () =>
    async (query: { text: string; values: unknown[] }, { ttl }: { ttl: number }) => {
      cached.push({ ttl, query });
      throw new Error('stop here');
    },
}));

import { env } from '~/env/server';
import { getAllImages } from '../image.service';

const VIEWER = { id: 10, isModerator: false };
const OTHER_VIEWER = { id: 11, isModerator: false };

async function read(filters: object, user?: object) {
  cached.length = 0;
  await getAllImages({
    limit: 20,
    period: 'AllTime',
    periodMode: 'stats',
    sort: 'Newest',
    browsingLevel: 31,
    include: [],
    user,
    ...filters,
  } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(cached, 'the read no longer reaches the query cache').toHaveLength(1);
  return cached[0];
}

beforeAll(() => {
  (env as Record<string, unknown>).IMAGE_QUERY_CACHING = true;
});

describe("a collection image read's query cache", () => {
  it('keeps caching a model version gallery read inside a collection for a signed-in viewer', async () => {
    const filters = { collectionId: 7, modelVersionId: 3 };
    expect((await read(filters, VIEWER)).ttl).toBeGreaterThan(0);
    expect((await read(filters)).ttl).toBeGreaterThan(0);
  });

  it("keys a signed-in viewer's collection read apart from another viewer's", async () => {
    const filters = { collectionId: 7, modelVersionId: 3 };
    const mine = (await read(filters, VIEWER)).query;
    const theirs = (await read(filters, OTHER_VIEWER)).query;
    expect([mine.text, mine.values]).not.toEqual([theirs.text, theirs.values]);
  });
});
