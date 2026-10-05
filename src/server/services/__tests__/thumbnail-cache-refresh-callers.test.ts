import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

// `thumbnailCache` is keyed by the VIDEO id. Every write that changes a thumbnail image's rating
// must go through `refreshThumbnailCache`, which also refreshes the parent video; a bare
// `thumbnailCache.refresh(thumbnailId)` leaves the public API serving the old rating for a day.

const refreshThumbnailCache = vi.fn<(ids: number | number[]) => Promise<void>>(() =>
  Promise.resolve()
);
const thumbnailRefresh = vi.fn(() => Promise.resolve());

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    refreshThumbnailCache: (ids: number | number[]) => refreshThumbnailCache(ids),
    thumbnailCache: { ...actual.thumbnailCache, refresh: thumbnailRefresh },
    imageMetadataCache: { ...actual.imageMetadataCache, refresh: vi.fn(() => Promise.resolve()) },
  };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

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

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/games/new-order/utils', async (importOriginal) => {
  const reset = { reset: vi.fn(() => Promise.resolve()) };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    poolCounters: {
      Knight: { a: [reset], b: [reset] },
      Templar: { a: [reset], b: [reset] },
    },
  };
});

const {
  queueImageSearchIndexUpdate,
  raiseOwnImageNsfwLevel,
  updateImageNsfwLevel,
  updateNsfwLevel,
} = await import('../image.service');

describe('thumbnail-cache refresh call sites', () => {
  beforeEach(() => {
    refreshThumbnailCache.mockClear();
    thumbnailRefresh.mockClear();
    dbMock.dbWrite.$executeRawUnsafe.mockResolvedValue(0);
  });

  it('updateNsfwLevel refreshes through the parent-aware helper', async () => {
    await updateNsfwLevel([7, 8]);

    expect(refreshThumbnailCache).toHaveBeenCalledTimes(1);
    expect(refreshThumbnailCache).toHaveBeenCalledWith([7, 8]);
    expect(thumbnailRefresh).not.toHaveBeenCalled();
  });

  it('a moderator re-rating refreshes through the parent-aware helper', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ metadata: { parentId: 500 }, postId: null });
    dbMock.dbWrite.image.update.mockResolvedValue({});

    await updateImageNsfwLevel({ id: 77, nsfwLevel: 4, userId: 1, isModerator: true } as never);

    expect(refreshThumbnailCache).toHaveBeenCalledWith(77);
    expect(thumbnailRefresh).not.toHaveBeenCalled();
  });

  it('an owner raising their own rating refreshes through the parent-aware helper', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ postId: null }]);

    const raised = await raiseOwnImageNsfwLevel({ id: 77, nsfwLevel: 4, userId: 1 });

    expect(raised).toBe(true);
    expect(refreshThumbnailCache).toHaveBeenCalledWith(77);
    expect(thumbnailRefresh).not.toHaveBeenCalled();
  });

  it('a search-index delete refreshes through the parent-aware helper', async () => {
    await queueImageSearchIndexUpdate({ ids: [77], action: SearchIndexUpdateQueueAction.Delete });

    expect(refreshThumbnailCache).toHaveBeenCalledWith([77]);
    expect(thumbnailRefresh).not.toHaveBeenCalled();
  });
});
