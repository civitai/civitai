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
  it('builds the index handle locally on construction instead of fetching it', async () => {
    const { client } = fakeClient();

    const feed = construct(client);
    await feed.ready();

    expect(client.getIndex).not.toHaveBeenCalled();
    expect(client.index).toHaveBeenCalledTimes(1);
    expect(client.index).toHaveBeenCalledWith('test_feed_index_handle');
  });

  it('serves a query with the search as its only Meilisearch call', async () => {
    const { client, search } = fakeClient();

    const result = await construct(client).query({ limit: 1 } as never);

    expect(result.items).toEqual([{ id: 1 }]);
    expect(result.nextCursor).toBe('1|1');
    expect(search).toHaveBeenCalledTimes(1);
    expect(client.getIndex).not.toHaveBeenCalled();
  });
});
