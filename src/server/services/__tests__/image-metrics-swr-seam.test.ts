import { describe, it, expect, vi, beforeEach } from 'vitest';

// The seam between getImageMetricsObject and the image-metrics-swr arm: the flag decides which
// read runs, and with it ON a cached id must not reach MetricService.fetch (where a cold miss
// queries ClickHouse inline). The arm's own logic is covered in image-metrics-swr.test.ts; this
// file covers the wiring in image.service, which that file never loads.
//
// Same mock seams as image-metrics-timeout.test.ts (read its header for why each exists).

const { fetchMock, refreshInBackgroundMock, swrGateMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  refreshInBackgroundMock: vi.fn(),
  swrGateMock: vi.fn(),
}));

vi.mock('../image-metrics-swr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image-metrics-swr')>();
  return { ...actual, imageMetricsSwrEnabled: swrGateMock };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = fetchMock;
    refreshInBackground = refreshInBackgroundMock;
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy(
    { CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: 200, LOGGING: [] as string[] } as Record<
      string,
      unknown
    >,
    {
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
    }
  ),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
import { getImageMetricsObject } from '../image.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Distinct values per id and per field, so an id handed another id's hash reads as a wrong number.
const hashes = (): Record<string, Record<string, string>> => ({
  'metrics:Image:1': {
    Like: '62',
    Heart: '4',
    Laugh: '9',
    Cry: '0',
    commentCount: '7',
    Collection: '11',
    tippedAmount: '500',
    _populatedAt: String(nowSeconds() - 60),
  },
  // Past the refresh age (1h), inside the max-staleness bound.
  'metrics:Image:2': { Like: '8', _populatedAt: String(nowSeconds() - 2 * 60 * 60) },
  // Same, read only by the refresh case: the refresher is a per-process singleton, so an id the
  // earlier cases already queued is de-duplicated there and cannot prove anything.
  'metrics:Image:4': { Like: '5', _populatedAt: String(nowSeconds() - 2 * 60 * 60) },
});

describe('getImageMetricsObject with image-metrics-swr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.redis.hGetAll.mockImplementation(async (key: string) => hashes()[key] ?? {});
    fetchMock.mockImplementation(async (_type: string, ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { Like: 900 + id }]))
    );
    refreshInBackgroundMock.mockImplementation(() => new Promise(() => {}));
  });

  it('flag OFF: every id is read through MetricService.fetch, and the cache is not read here', async () => {
    swrGateMock.mockReturnValue(false);

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('Image', [1, 2, 3]);
    // MetricService's answer, not the hash's: 901 is not 62.
    expect(result[1]?.reactionLike).toBe(901);
    expect(result[3]?.reactionLike).toBe(903);
    expect(redisMock.redis.hGetAll).not.toHaveBeenCalled();
    expect(refreshInBackgroundMock).not.toHaveBeenCalled();
  });

  it('flag ON: cached ids are served from their hash and only the cold id reaches MetricService', async () => {
    swrGateMock.mockReturnValue(true);

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(result[1]).toEqual({
      imageId: 1,
      reactionLike: 62,
      reactionHeart: 4,
      reactionLaugh: 9,
      reactionCry: null,
      comment: 7,
      collection: 11,
      buzz: 500,
    });
    // Stale, still served from the cache rather than waiting on a refresh.
    expect(result[2]?.reactionLike).toBe(8);
    // Cold: the flag-OFF read, for that id alone.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('Image', [3]);
    expect(result[3]?.reactionLike).toBe(903);
    expect(redisMock.redis.hGetAll).toHaveBeenCalledWith('metrics:Image:1');
  });

  it('flag ON: a page with every id cached never calls MetricService.fetch', async () => {
    swrGateMock.mockReturnValue(true);

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result[1]?.reactionLike).toBe(62);
    expect(result[2]?.reactionLike).toBe(8);
  });

  it("flag ON: the stale id is refreshed through MetricService's own repopulate, off the request", async () => {
    swrGateMock.mockReturnValue(true);

    // refreshInBackground never settles (beforeEach), so a request that awaited it would hang.
    const result = await getImageMetricsObject([{ id: 4 }]);
    expect(result[4]?.reactionLike).toBe(5);
    expect(fetchMock).not.toHaveBeenCalled();

    // The refresher flushes on a timer, after the request has returned. `arrayContaining`: ids the
    // earlier cases queued in the same flush window share the batch.
    await vi.waitFor(
      () =>
        expect(refreshInBackgroundMock).toHaveBeenCalledWith('Image', expect.arrayContaining([4])),
      { timeout: 3000 }
    );
  });
});
