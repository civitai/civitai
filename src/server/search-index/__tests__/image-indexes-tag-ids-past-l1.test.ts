import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisCaches from '~/server/redis/caches';

/**
 * The image-metrics search index writes each image's tag ids into a Meilisearch document that
 * keeps them until the next reindex. A read through this process's L1 could bake in a tag list from
 * before a tag edit, so the tag step must read past it (`{ bypassLocal: true }`). The step is driven
 * through the processor's own `pullData`.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

const tagIdsFetch = vi.fn(async (ids: number[]) =>
  Object.fromEntries(ids.map((imageId) => [imageId, { imageId, tags: [imageId + 5] }]))
);
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: tagIdsFetch },
  tagCache: { fetch: vi.fn(async () => ({})) },
}));

const { imagesMetricsDetailsSearchIndex } = await import(
  '~/server/search-index/metrics-images.search-index'
);

// Distinct ids, none equal to a step number or a batch size.
const IMAGES = [9137, 9241];
const ctx = { db: {}, logger: () => undefined, indexName: 'test-index' } as never;
const batch = { type: 'update', ids: IMAGES } as never;
const prevData = () => ({ images: IMAGES.map((id) => ({ id })) });

// A block body, not `() => tagIdsFetch.mockClear()`: mockClear returns the mock, and Vitest calls a
// function returned from beforeEach as that test's cleanup, i.e. tagIdsFetch() with no ids.
beforeEach(() => {
  tagIdsFetch.mockClear();
});

describe("the image-metrics search index reads tag ids past this process's L1", () => {
  it('image-metrics index, tag step', async () => {
    const result = (await imagesMetricsDetailsSearchIndex.pullData(ctx, batch, 2, prevData())) as {
      imageTags: Record<number, { tags: number[] }>;
    };
    expect(tagIdsFetch).toHaveBeenCalledTimes(1);
    expect(tagIdsFetch).toHaveBeenCalledWith(IMAGES, { bypassLocal: true });
    expect(result.imageTags[9241].tags).toEqual([9246]);
  });
});
