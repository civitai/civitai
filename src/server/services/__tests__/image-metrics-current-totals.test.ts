import { describe, it, expect, vi, beforeEach } from 'vitest';

// getImageMetricsObject can read image metric counts from one of two sources,
// chosen by the Flipt flag `image-metrics-use-current-totals`:
//   - OFF / absent (default): the existing MetricService.fetch('Image', ids)
//     path over the aggregating view entityMetricDailyAgg_v2 — UNCHANGED.
//   - ON: a plain point-lookup `SELECT entityId, metricType, total FROM
//     entityMetricCurrentTotals_v2 ...` via the civitai clickhouse client.
// Both produce the same { [id]: { [metricType]: total } } map shape, fed through
// the same shaping loop + the same withTimeoutFallback / counter wrapping.
//
// This mirrors image-metrics-timeout.test.ts's mocking (the smallest seams) and
// adds the Flipt seam so we can drive both branches.

const { fetchMock, counterIncMock, isFliptMock, chQueryMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  counterIncMock: vi.fn(),
  isFliptMock: vi.fn(),
  chQueryMock: vi.fn(),
}));

// Soft-fallback counter spy (image.service creates exactly one via registerCounter).
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/prom/client')>();
  return { ...actual, registerCounter: () => ({ inc: counterIncMock }) };
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
// clickhouse client: expose the $query spy the ON path calls.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: chQueryMock } }));
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() } },
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
  });

  it('(a) flag OFF → uses the existing MetricService path with the unchanged mapping', async () => {
    isFliptMock.mockResolvedValue(false);
    fetchMock.mockResolvedValue({
      1: { Like: 5, Heart: 2, Laugh: 0, Cry: 1, commentCount: 3, Collection: 4, tippedAmount: 100 },
    });

    const result = await getImageMetricsObject([{ id: 1 }]);

    // MetricService leg used; point-table $query NOT touched.
    expect(fetchMock).toHaveBeenCalledWith('Image', [1]);
    expect(chQueryMock).not.toHaveBeenCalled();
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
    expect(counterIncMock).not.toHaveBeenCalled();
  });

  it('(b) flag ON → reads the point table and maps to the ImageMetricsObject shape', async () => {
    isFliptMock.mockResolvedValue(true);
    // Point-table rows: (entityId, metricType, total) — post-remap metric names.
    chQueryMock.mockResolvedValue([
      { entityId: 1, metricType: 'Like', total: 5 },
      { entityId: 1, metricType: 'Heart', total: 2 },
      { entityId: 1, metricType: 'Cry', total: 1 },
      { entityId: 1, metricType: 'commentCount', total: 3 },
      { entityId: 1, metricType: 'Collection', total: 4 },
      { entityId: 1, metricType: 'tippedAmount', total: 100 },
      { entityId: 2, metricType: 'Like', total: 7 },
    ]);

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);

    // Point-table read used; MetricService leg NOT touched.
    expect(chQueryMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(result[1]).toEqual({
      imageId: 1,
      reactionLike: 5,
      reactionHeart: 2,
      reactionLaugh: null, // absent in rows → null
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
    expect(counterIncMock).not.toHaveBeenCalled();
  });

  it('(c) flag ON + point-table read HANGS → fails soft to all-null within the timeout, increments the counter, no throw', async () => {
    isFliptMock.mockResolvedValue(true);
    chQueryMock.mockImplementation(never); // wedged point-table read

    const start = Date.now();
    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000); // resolved fast, did not park
    expect(result[1]).toEqual(nullMetrics(1));
    expect(result[2]).toEqual(nullMetrics(2));
    expect(counterIncMock).toHaveBeenCalledTimes(1);
  });

  it('(c2) flag ON + point-table read THROWS → fails soft to all-null (no throw, no counter — error path, not timeout)', async () => {
    isFliptMock.mockResolvedValue(true);
    chQueryMock.mockRejectedValue(new Error('ClickHouse query failed'));

    const result = await getImageMetricsObject([{ id: 1 }]);

    // The new path swallows its own error → empty map → all-null shape. The
    // timeout counter is NOT incremented (this is the error branch, not a timeout).
    expect(result[1]).toEqual(nullMetrics(1));
    expect(counterIncMock).not.toHaveBeenCalled();
  });
});
