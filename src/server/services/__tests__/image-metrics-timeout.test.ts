import { describe, it, expect, vi, beforeEach } from 'vitest';

// getImageMetricsObject is the metric leg of the getAllImages 12-way Promise.all
// fan-out on the image feed / SSR hot path. It reads counts from ClickHouse via
// MetricService.fetch, which has NO request-level timeout beyond the
// @clickhouse/client 30s default — and a try/catch CANNOT catch a hang. We bound
// it with withTimeoutFallback so a wedged read fails SOFT to empty metrics
// instead of parking ~30s and blowing the SSR deadline.
//
// We mock the smallest seams: the event-engine-common MetricService class (so
// only its `.fetch` is controlled) plus the db/redis/clickhouse clients and env
// so importing image.service doesn't boot real infra (the established pattern in
// the other service tests, e.g. block-registry.subscriptions.test.ts).

const { fetch: fetchMock } = vi.hoisted(() => ({ fetch: vi.fn() }));

// event-engine-common is a private git submodule not checked out in this
// worktree — stub the value imports image.service pulls from it. MetricService
// is the seam under test: its `.fetch` is our spy.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = fetchMock;
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Fully replace env (importing the real `~/env/server` validates ALL prod env
// vars and throws in test). Only the short metrics timeout matters; a Proxy
// returns undefined for any other var image.service reads at import time. LOGGING
// must be an array (db/client filters it).
vi.mock('~/env/server', () => ({
  env: new Proxy(
    { CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: 20, LOGGING: [] as string[] } as Record<
      string,
      unknown
    >,
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        // Several db/redis modules build `new URL(env.*_URL)` at module load; hand
        // any *_URL a valid connection string so import doesn't throw (nothing in
        // this test ever connects).
        if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
          return 'https://test:test@localhost:5432/test';
        // Numeric-looking config (e.g. *_CONCURRENCY) is fed into helpers like
        // pLimit at module load; hand it a safe positive number.
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

// Stub the infra clients so no real DB/Redis connection is opened on import.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
// REDIS_KEYS / REDIS_SYS_KEYS are deeply path-accessed at module load; a Proxy
// returns a string for any key without enumerating the whole namespace tree.
// Built inside the factory (vi.mock is hoisted — no outer-scope refs allowed).
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

describe('getImageMetricsObject ClickHouse timeout fail-soft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: maps metrics when the metric service resolves quickly', async () => {
    fetchMock.mockResolvedValue({
      1: { Like: 5, Heart: 2, Laugh: 0, Cry: 1, commentCount: 3, Collection: 4, tippedAmount: 100 },
    });

    const result = await getImageMetricsObject([{ id: 1 }]);

    expect(result[1]).toEqual({
      imageId: 1,
      reactionLike: 5,
      reactionHeart: 2,
      reactionLaugh: null, // 0 → null per the `|| null` shaping
      reactionCry: 1,
      comment: 3,
      collection: 4,
      buzz: 100,
    });
  });

  it('fails soft to all-null metrics within the timeout when the metric read HANGS (no parking)', async () => {
    fetchMock.mockImplementation(never); // wedged ClickHouse read

    const start = Date.now();
    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);
    const elapsed = Date.now() - start;

    // The contract: it RESOLVES (does not park ~30s) with the fail-soft shape —
    // an empty `{}` metrics map maps to all-null counts per id (callers treat
    // null fields as "no metrics"). The key assertion is that it returns fast and
    // never throws.
    expect(elapsed).toBeLessThan(1000);
    for (const id of [1, 2]) {
      expect(result[id]).toEqual({
        imageId: id,
        reactionLike: null,
        reactionHeart: null,
        reactionLaugh: null,
        reactionCry: null,
        comment: null,
        collection: null,
        buzz: null,
      });
    }
  });
});
