import { describe, it, expect, vi, beforeEach } from 'vitest';

// getImageMetricsObject can read image metric counts from one of two sources,
// chosen by the Flipt flag `image-metrics-use-current-totals`:
//   - OFF / absent (default): the existing MetricService.fetch('Image', ids)
//     path over the aggregating view entityMetricDailyAgg_v2 — UNCHANGED.
//   - ON: a Redis read-through (the SAME `metrics:Image:<id>` cache MetricService
//     uses) whose cold-MISS backend is the cheap point-lookup
//     `SELECT entityId, metricType, total FROM entityMetricCurrentTotals_v2 ...`
//     via the civitai clickhouse client. Misses are written back to the cache in
//     MetricService's exact format so the flag flip does NOT cold-start the cache.
// Both produce the same { [id]: { [metricType]: total } } map shape, fed through
// the same shaping loop + the same withTimeoutFallback / counter wrapping.
//
// This mirrors image-metrics-timeout.test.ts's mocking (the smallest seams) and
// adds the Flipt + Redis + clickhouse seams so we can drive both branches and
// assert the read-through (cache hit → ZERO CH calls) and write-back.

const {
  fetchMock,
  timeoutCounterIncMock,
  readFailedCounterIncMock,
  isFliptMock,
  chQueryMock,
  hGetAllMock,
  hSetMock,
  expireMock,
} = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  timeoutCounterIncMock: vi.fn(),
  readFailedCounterIncMock: vi.fn(),
  isFliptMock: vi.fn(),
  chQueryMock: vi.fn(),
  hGetAllMock: vi.fn(),
  hSetMock: vi.fn(),
  expireMock: vi.fn(),
}));

// image.service registers TWO counters via registerCounter:
//   image_metrics_clickhouse_timeout_total          → the soft-fallback timeout
//   image_metrics_current_totals_read_failed_total  → the flag-ON read error
// Route each name to its own spy so (c) [timeout] and (d) [read-failed] are
// distinguishable.
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/prom/client')>();
  return {
    ...actual,
    registerCounter: (opts: { name: string }) =>
      opts.name === 'image_metrics_current_totals_read_failed_total'
        ? { inc: readFailedCounterIncMock }
        : { inc: timeoutCounterIncMock },
  };
});

// event-engine-common is a private submodule not checked out here — stub the
// value imports image.service pulls from it. MetricService.fetch is the OFF-path
// seam.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = fetchMock;
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Flipt seam — drives which read path getImageMetricsObject takes.
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: isFliptMock };
});

// Replace env (the real ~/env/server validates all prod vars and throws in test).
vi.mock('~/env/server', () => ({
  env: new Proxy(
    { CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: 20, LOGGING: [] as string[] } as Record<string, unknown>,
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

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
// clickhouse client: expose the $query spy the ON path calls for cache MISSES.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: chQueryMock } }));
// redis client: expose the raw plain-string hGetAll / hSet / expire the ON-path
// read-through uses (mirrors MetricService's cache contract). packed.* kept for
// the unrelated module-load callers.
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {
      packed: { get: vi.fn(), set: vi.fn() },
      hGetAll: hGetAllMock,
      hSet: hSetMock,
      expire: expireMock,
    },
    sysRedis: {},
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
  };
});

import { getImageMetricsObject } from '../image.service';

const never = () => new Promise<never>(() => {});
const nullMetrics = (id: number) => ({
  imageId: id,
  reactionLike: null,
  reactionHeart: null,
  reactionLaugh: null,
  reactionCry: null,
  comment: null,
  collection: null,
  buzz: null,
});

describe('getImageMetricsObject — flag-gated current-totals read path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default redis behaviour: every key a cache MISS (empty hash); writes succeed.
    hGetAllMock.mockResolvedValue({});
    hSetMock.mockResolvedValue(1);
    expireMock.mockResolvedValue(true);
  });

  it('(a) flag OFF → uses the existing MetricService path with the unchanged mapping', async () => {
    isFliptMock.mockResolvedValue(false);
    fetchMock.mockResolvedValue({
      1: { Like: 5, Heart: 2, Laugh: 0, Cry: 1, commentCount: 3, Collection: 4, tippedAmount: 100 },
    });

    const result = await getImageMetricsObject([{ id: 1 }]);

    // MetricService leg used; the flag-ON cache read-through + point view NOT touched.
    expect(fetchMock).toHaveBeenCalledWith('Image', [1]);
    expect(chQueryMock).not.toHaveBeenCalled();
    expect(hGetAllMock).not.toHaveBeenCalled();
    expect(result[1]).toEqual({
      imageId: 1,
      reactionLike: 5,
      reactionHeart: 2,
      reactionLaugh: null, // 0 → null per `|| null`
      reactionCry: 1,
      comment: 3,
      collection: 4,
      buzz: 100,
    });
    expect(timeoutCounterIncMock).not.toHaveBeenCalled();
    expect(readFailedCounterIncMock).not.toHaveBeenCalled();
  });

  it('(b) flag ON + ALL ids cache-HIT → returns mapped values and makes ZERO clickhouse calls', async () => {
    isFliptMock.mockResolvedValue(true);
    // Both ids served entirely from the shared `metrics:Image:<id>` cache. Values
    // are stored as STRINGS (MetricService format) and parsed back via parseInt.
    hGetAllMock.mockImplementation(async (key: string) => {
      if (key === 'metrics:Image:1')
        return {
          Like: '5',
          Heart: '2',
          Cry: '1',
          commentCount: '3',
          Collection: '4',
          tippedAmount: '100',
        };
      if (key === 'metrics:Image:2') return { Like: '7' };
      return {};
    });

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);

    // THE LOAD-FIX PROOF: all ids hit the cache → the point view was never queried.
    expect(chQueryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // No write-back when there are no misses.
    expect(hSetMock).not.toHaveBeenCalled();

    expect(result[1]).toEqual({
      imageId: 1,
      reactionLike: 5,
      reactionHeart: 2,
      reactionLaugh: null,
      reactionCry: 1,
      comment: 3,
      collection: 4,
      buzz: 100,
    });
    expect(result[2]).toEqual({
      imageId: 2,
      reactionLike: 7,
      reactionHeart: null,
      reactionLaugh: null,
      reactionCry: null,
      comment: null,
      collection: null,
      buzz: null,
    });
    expect(timeoutCounterIncMock).not.toHaveBeenCalled();
    expect(readFailedCounterIncMock).not.toHaveBeenCalled();
  });

  it('(c) flag ON + some misses → reads point view for misses ONLY and writes them back to Redis in MetricService format', async () => {
    isFliptMock.mockResolvedValue(true);
    // id 1 = cache HIT (served from Redis), id 2 = cache MISS (falls to point view),
    // id 3 = cache MISS that the point view returns NO rows for (→ notFound write-back).
    hGetAllMock.mockImplementation(async (key: string) => {
      if (key === 'metrics:Image:1') return { Like: '5', commentCount: '3' };
      return {}; // ids 2 and 3 miss
    });
    chQueryMock.mockResolvedValue([
      { entityId: 2, metricType: 'Heart', total: 9 },
      { entityId: 2, metricType: 'tippedAmount', total: 50 },
    ]);

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }, { id: 3 }]);

    // Point view queried exactly once, for the MISSES only (ids 2 & 3, not the hit id 1).
    expect(chQueryMock).toHaveBeenCalledTimes(1);
    const queryArgs = chQueryMock.mock.calls[0];
    // $query is a tagged template: (strings, ...values). The interpolated values
    // are, in order: the table name, the miss-id array, the metric-type list. The
    // miss-id array (index 2) must be [2, 3] — the MISSES only, NOT the hit id 1.
    expect(queryArgs[2]).toEqual([2, 3]);

    // Write-back: id 2 found → string fields + CACHE_TTL (12h=43200);
    //             id 3 no rows → { notFound: '1' } + MISS_CACHE_TTL (5m=300).
    // id 1 (a hit) must NOT be written back.
    expect(hSetMock).toHaveBeenCalledWith('metrics:Image:2', { Heart: '9', tippedAmount: '50' });
    expect(expireMock).toHaveBeenCalledWith('metrics:Image:2', 12 * 60 * 60);
    expect(hSetMock).toHaveBeenCalledWith('metrics:Image:3', { notFound: '1' });
    expect(expireMock).toHaveBeenCalledWith('metrics:Image:3', 5 * 60);
    expect(hSetMock).not.toHaveBeenCalledWith('metrics:Image:1', expect.anything());

    expect(result[1]).toEqual({ ...nullMetrics(1), reactionLike: 5, comment: 3 });
    expect(result[2]).toEqual({ ...nullMetrics(2), reactionHeart: 9, buzz: 50 });
    expect(result[3]).toEqual(nullMetrics(3));
    expect(readFailedCounterIncMock).not.toHaveBeenCalled();
  });

  it('(d) flag ON + point-view read THROWS → fails soft + increments the read-failed counter (no throw)', async () => {
    isFliptMock.mockResolvedValue(true);
    hGetAllMock.mockResolvedValue({}); // all miss → must hit the point view
    chQueryMock.mockRejectedValue(new Error('entityMetricCurrentTotals_v2 does not exist'));

    const result = await getImageMetricsObject([{ id: 1 }]);

    // Distinct error signal so a broken/premature flag flip PAGES.
    expect(readFailedCounterIncMock).toHaveBeenCalledTimes(1);
    // Fail soft to all-null; no notFound write-back on our own failure.
    expect(result[1]).toEqual(nullMetrics(1));
    expect(hSetMock).not.toHaveBeenCalled();
    // Not the timeout branch.
    expect(timeoutCounterIncMock).not.toHaveBeenCalled();
  });

  it('(e) flag ON + notFound-marked cache entry → treated as no-metrics (null), no point-view call', async () => {
    isFliptMock.mockResolvedValue(true);
    hGetAllMock.mockImplementation(async (key: string) =>
      key === 'metrics:Image:1' ? { notFound: '1' } : {}
    );

    const result = await getImageMetricsObject([{ id: 1 }]);

    // notFound:'1' = known-absent → null metrics; it is NOT a cache miss, so the
    // point view is never queried for it.
    expect(chQueryMock).not.toHaveBeenCalled();
    expect(result[1]).toEqual(nullMetrics(1));
    expect(readFailedCounterIncMock).not.toHaveBeenCalled();
  });

  it('(c-hang) flag ON + point-view read HANGS → fails soft to all-null within the timeout, increments the TIMEOUT counter', async () => {
    isFliptMock.mockResolvedValue(true);
    hGetAllMock.mockResolvedValue({}); // all miss
    chQueryMock.mockImplementation(never); // wedged point-table read

    const start = Date.now();
    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000); // resolved fast, did not park
    expect(result[1]).toEqual(nullMetrics(1));
    expect(result[2]).toEqual(nullMetrics(2));
    expect(timeoutCounterIncMock).toHaveBeenCalledTimes(1);
    expect(readFailedCounterIncMock).not.toHaveBeenCalled();
  });
});
