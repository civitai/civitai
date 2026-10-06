import { describe, it, expect, vi } from 'vitest';
import { createFeed } from '../../../../event-engine-common/feeds/base';
import type {
  IMeilisearch,
  IMeilisearchIndex,
} from '../../../../event-engine-common/types/meilisearch-interface';
import type {
  IClickhouseClient,
  IDbClient,
} from '../../../../event-engine-common/types/package-stubs';
import type { MetricService } from '../../../../event-engine-common/services/metrics';
import type { CacheService } from '../../../../event-engine-common/services/cache';

// getImagesFromFeedSearch constructs a Feed per request, so anything the Feed constructor sends
// to Meilisearch is paid on every feed request. The read path needs only a handle to search on,
// so these tests pin that constructing a Feed and running a query sends exactly one call to
// Meilisearch — the search — and never the GET /indexes/{uid} that getIndex() issues.

function fakeClient() {
  const search = vi.fn(async () => ({ hits: [{ id: 1 }, { id: 2 }] }));
  const index = { search } as unknown as IMeilisearchIndex;
  const client = {
    getIndex: vi.fn(async () => index),
    index: vi.fn(() => index),
    createIndex: vi.fn(),
    tasks: { waitForTask: vi.fn() },
  };
  return { client, search };
}

const TestFeed = createFeed({
  entityType: 'Image' as const,
  name: 'test_feed_index_handle',
  schema: { id: { type: 'number' as const } },
  createDocuments: async () => [],
  queryDocuments: async (ctx) => {
    const res = await ctx.index.search(null, { limit: ctx.pagination.limit + 1 });
    return res.hits;
  },
  populateDocuments: async (_ctx, docs) => docs,
});

function construct(client: ReturnType<typeof fakeClient>['client']) {
  return new TestFeed(
    () => client as unknown as IMeilisearch,
    {} as IClickhouseClient,
    {} as IDbClient,
    {} as MetricService,
    {} as CacheService
  );
}

describe('Feed read path — index handle', () => {
  it('serves a query with the search as its only Meilisearch call', async () => {
    const { client, search } = fakeClient();

    const feed = construct(client);
    // Asserted before the query so a constructor that fetches the index fails here, by name,
    // rather than later on whatever the fake's absent handle happens to throw.
    expect(client.getIndex).not.toHaveBeenCalled();
    // The fake hands back the same handle for any name, so only this pins that the feed
    // searches its own index.
    expect(client.index).toHaveBeenCalledWith('test_feed_index_handle');

    const result = await feed.query({ limit: 1 } as never);

    expect(result.items).toEqual([{ id: 1 }]);
    expect(result.nextCursor).toBe('1|1');
    expect(search).toHaveBeenCalledTimes(1);
    expect(client.getIndex).not.toHaveBeenCalled();
  });
});
