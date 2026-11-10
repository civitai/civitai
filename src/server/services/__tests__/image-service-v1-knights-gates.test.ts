import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import type * as NewOrderService from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';

// The v1 Knights of New Order paths inside image.service run only while the v1 game is live.
// The v2 owner-rating hook next to them is not gated.

const { v1Live, addImageToQueue, queueOwnerRating, poolReset } = vi.hoisted(() => ({
  v1Live: vi.fn(async () => true),
  addImageToQueue: vi.fn(() => Promise.resolve()),
  queueOwnerRating: vi.fn(() => Promise.resolve()),
  poolReset: vi.fn(() => Promise.resolve()),
}));

vi.mock('~/server/games/new-order/v1-gate', () => ({ isV1KnightsLive: v1Live }));
vi.mock('~/server/services/games/new-order.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NewOrderService>()),
  addImageToQueue,
}));
vi.mock('~/server/services/knights/sources', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queueOwnerRatingForKnights: queueOwnerRating,
}));

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    refreshThumbnailCache: vi.fn(() => Promise.resolve()),
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
  const reset = { reset: poolReset };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    poolCounters: {
      Knight: { a: [reset], b: [reset] },
      Templar: { a: [reset], b: [reset] },
    },
  };
});

const { updateImageNsfwLevel, queueImageSearchIndexUpdate } = await import('../image.service');

const IMAGE_ID = 7301;
const OWNER = 4242;

beforeEach(() => {
  vi.clearAllMocks();
  v1Live.mockResolvedValue(true);
  dbMock.dbWrite.image.findFirst.mockResolvedValue({
    nsfwLevel: NsfwLevel.PG,
    userId: OWNER,
    nsfwLevelLocked: false,
  } as never);
  dbMock.dbWrite.imageRatingRequest.upsert.mockResolvedValue({} as never);
});

const ownerVote = () =>
  updateImageNsfwLevel({
    id: IMAGE_ID,
    nsfwLevel: NsfwLevel.R,
    userId: OWNER,
    isModerator: false,
  } as never);

describe('owner rating vote', () => {
  it('queues the image for v1 and v2 while the v1 game is live', async () => {
    await ownerVote();

    expect(addImageToQueue).toHaveBeenCalledTimes(1);
    expect(queueOwnerRating).toHaveBeenCalledWith(IMAGE_ID);
  });

  it('skips the v1 queue but still feeds v2 once the v1 game is retired', async () => {
    v1Live.mockResolvedValue(false);

    await ownerVote();

    expect(addImageToQueue).not.toHaveBeenCalled();
    expect(queueOwnerRating).toHaveBeenCalledWith(IMAGE_ID);
  });
});

describe('search-index delete and the v1 pool counters', () => {
  it('resets the pool counters while the v1 game is live', async () => {
    await queueImageSearchIndexUpdate({
      ids: [IMAGE_ID],
      action: SearchIndexUpdateQueueAction.Delete,
    });

    expect(poolReset).toHaveBeenCalledWith({ id: [IMAGE_ID] });
  });

  it('leaves the pool counters alone once the v1 game is retired', async () => {
    v1Live.mockResolvedValue(false);

    await queueImageSearchIndexUpdate({
      ids: [IMAGE_ID],
      action: SearchIndexUpdateQueueAction.Delete,
    });

    expect(poolReset).not.toHaveBeenCalled();
  });
});
