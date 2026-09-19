import { describe, it, expect, vi, beforeEach } from 'vitest';

// getImageMetricsObject is the metric leg of the getAllImages 12-way Promise.all
// fan-out on the image feed / SSR hot path. It reads counts from ClickHouse via
// MetricService.fetch, which has NO request-level timeout beyond the shared
// client's `request_timeout` of 300s — and a try/catch CANNOT catch a hang. We
// bound it with withTimeoutFallback so a wedged read fails SOFT to empty metrics
// instead of parking for minutes and blowing the SSR deadline.
//
// We mock the smallest seams: the event-engine-common MetricService class (so
// only its `.fetch` is controlled) plus the db/redis/clickhouse clients and env
// so importing image.service doesn't boot real infra (the established pattern in
// the other service tests, e.g. block-registry.subscriptions.test.ts).

const {
  fetch: fetchMock,
  counterIncMock,
  staleCounterIncMock,
  logToAxiomMock,
} = vi.hoisted(() => ({
  fetch: vi.fn(),
  counterIncMock: vi.fn(),
  staleCounterIncMock: vi.fn(),
  logToAxiomMock: vi.fn(() => Promise.resolve()),
}));

// Capture the soft-fallback Prometheus counters. image.service registers two on this
// path; override just `registerCounter` with name-keyed spies, keeping every other
// prom helper real (the import graph also uses registerGaugeWithLabels /
// registerCounterWithLabels at module load). Keyed by NAME: a shared spy makes
// "which arm incremented" unanswerable.
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/prom/client')>();
  return {
    ...actual,
    registerCounter: ({ name }: { name: string }) => ({
      inc:
        name === 'image_metrics_stale_cache_timeout_total' ? staleCounterIncMock : counterIncMock,
    }),
  };
});

// The rejection path's only signal is a log line, so the sink has to be visible to
// pin it. Spread the real module: image.service logs from several other paths.
vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/logging/client')>()),
  logToAxiom: logToAxiomMock,
}));

// event-engine-common is a git submodule, not checked out by default — stub the
// value imports image.service pulls from it. MetricService
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
    { CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: 20, LOGGING: [] as string[] } as Record<string, unknown>,
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

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
import { getImageMetricsObject } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

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
    // happy path must NOT count a soft-fallback
    expect(counterIncMock).not.toHaveBeenCalled();
  });

  it('leaves every id ABSENT when the metric read HANGS and the cache is COLD', async () => {
    fetchMock.mockImplementation(never); // wedged ClickHouse read
    redisMock.redis.hGetAll.mockResolvedValue({}); // cold cache, stated not inherited

    const start = Date.now();
    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);
    const elapsed = Date.now() - start;

    // Still the original contract: it RESOLVES fast rather than parking for minutes.
    expect(elapsed).toBeLessThan(1000);

    // And the shape this case used to pin -- an entry per id with all-null counts --
    // is now the thing it must NOT produce. Callers read a MISSING id as "we do not
    // know" and a present one as an answer, so all-null-but-present made a timeout
    // indistinguishable from an image nobody reacted to. Both failure exits (this one
    // and the outer catch) now leave the id absent.
    expect(result).toEqual({});
    expect(result[1]).toBeUndefined();

    // the timeout path must increment the soft-fallback counter exactly once
    expect(counterIncMock).toHaveBeenCalledTimes(1);
  });

  it('leaves every id ABSENT when the metric read THROWS and the cache is COLD', async () => {
    redisMock.redis.hGetAll.mockResolvedValue({}); // cold cache, stated not inherited
    // The timeout case above is one of two ways this read fails. A ClickHouse error
    // reaches the outer catch instead, and must produce the same shape; an entry per id
    // there would read every non-timeout failure as a real zero.
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);

    expect(result).toEqual({});
    expect(counterIncMock).not.toHaveBeenCalled();
  });

  it('CONTROL: a read that ANSWERS with no rows keeps every id present, so a real zero stays known', async () => {
    fetchMock.mockResolvedValue({}); // ClickHouse answered; it simply has no rows

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);

    // The negative arm of the case above: same empty metric map, opposite meaning.
    // Without this, "timeout leaves ids absent" would also pass on an implementation
    // that dropped every id unconditionally -- which would turn every real zero on
    // the site into an unknown.
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
    expect(counterIncMock).not.toHaveBeenCalled();
  });
});

// Pins the decision, not the mechanism: when ClickHouse cannot be read, a
// cache-warm id serves its LAST KNOWN value rather than going unknown. Delete
// these cases and the old defect returns - one blip discarded the cache hits for
// the whole batch, and every reaction badge on a post vanished until reload.
describe('getImageMetricsObject serves STALE cached counts when ClickHouse is unavailable', () => {
  // Every field the shaper reads carries a DISTINCT value, so a mis-keyed field
  // reads as null instead of as another field's number. Image 3 carries the
  // missing-field case so no real field loses its coverage.
  const CACHED = {
    'metrics:Image:1': {
      Like: '62',
      Heart: '4',
      Laugh: '9',
      Cry: '0',
      commentCount: '7',
      Collection: '11',
      tippedAmount: '500',
    },
    'metrics:Image:3': { Like: '8' },
  } as Record<string, Record<string, string>>;

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.redis.hGetAll.mockImplementation(async (key: string) => CACHED[key] ?? {});
  });

  it('serves the cached count for a warm id when the ClickHouse read THROWS', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(result[1]).toEqual({
      imageId: 1,
      reactionLike: 62,
      reactionHeart: 4,
      reactionLaugh: 9,
      reactionCry: null, // cached 0 shapes to null exactly as a fresh 0 does
      comment: 7,
      collection: 11,
      buzz: 500,
    });
    expect(result[3]).toEqual({
      imageId: 3,
      reactionLike: 8,
      reactionHeart: null,
      reactionLaugh: null,
      reactionCry: null,
      comment: null,
      collection: null,
      buzz: null,
    });
    expect(result[2]).toBeUndefined();
    // The THROW arm takes the same fallback and increments neither counter.
    expect(counterIncMock).not.toHaveBeenCalled();
    expect(staleCounterIncMock).not.toHaveBeenCalled();
  });

  it('serves the cached count for a warm id when the ClickHouse read HANGS', async () => {
    fetchMock.mockImplementation(never);

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);

    expect(result[1]?.reactionLike).toBe(62);
    expect(result[2]).toBeUndefined();
    expect(counterIncMock).toHaveBeenCalledTimes(1);
  });

  it('reads the cache key event-engine-common owns', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));

    await getImageMetricsObject([{ id: 1 }]);

    // Spelled out, NOT imported from `cacheKeys`: importing it would make this
    // agree with any future key change, which is the drift it exists to catch.
    expect(redisMock.redis.hGetAll).toHaveBeenCalledWith('metrics:Image:1');
    expect(redisMock.redis.hGetAll).toHaveBeenCalledTimes(1);
  });

  it('treats a cached notFound sentinel as a KNOWN zero, not as unknown', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));
    redisMock.redis.hGetAll.mockImplementation(async () => ({ notFound: '1' }));

    const result = await getImageMetricsObject([{ id: 9 }]);

    expect(result[9]).toEqual({
      imageId: 9,
      reactionLike: null,
      reactionHeart: null,
      reactionLaugh: null,
      reactionCry: null,
      comment: null,
      collection: null,
      buzz: null,
    });
  });

  it('keeps the other ids when ONE key rejects, and says so', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));
    redisMock.redis.hGetAll.mockImplementation(async (key: string) => {
      if (key === 'metrics:Image:2') throw new Error('MOVED 1234 10.0.0.1:6379');
      return CACHED[key] ?? {};
    });

    const result = await getImageMetricsObject([{ id: 1 }, { id: 2 }]);

    expect(result[1]?.reactionLike).toBe(62);
    expect(result[2]).toBeUndefined();

    // The rejection's only signal. Counted per KEY, not per call, and the
    // denominator is the de-duplicated id set.
    const rejectionLogs = logToAxiomMock.mock.calls.filter(
      ([payload]) => (payload as { name?: string })?.name === 'getCachedImageMetrics rejected'
    );
    expect(rejectionLogs).toHaveLength(1);
    expect(rejectionLogs[0][0]).toMatchObject({
      message: 'Metric cache read rejected for 1 of 2 ids',
    });
  });

  it('says NOTHING about rejections when every read succeeds', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));

    await getImageMetricsObject([{ id: 1 }]);

    // Without this, logging unconditionally passes the case above.
    expect(
      logToAxiomMock.mock.calls.filter(
        ([payload]) => (payload as { name?: string })?.name === 'getCachedImageMetrics rejected'
      )
    ).toHaveLength(0);
  });

  it('serves the keys that LANDED when one key is still outstanding at the deadline', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));
    redisMock.redis.hGetAll.mockImplementation((key: string) => {
      // Late, not never: removing the deadline then fails on a value instead of
      // hanging the runner.
      if (key === 'metrics:Image:3')
        return new Promise((resolve) => setTimeout(() => resolve(CACHED[key]), 3000));
      return Promise.resolve(CACHED[key] ?? {});
    });

    const result = await getImageMetricsObject([{ id: 1 }, { id: 3 }]);

    // Racing the AGGREGATE would discard image 1 as well, which on a cluster is
    // one slow shard zeroing a whole page - the defect this arm exists to stop.
    expect(result[1]?.reactionLike).toBe(62);
    expect(result[3]).toBeUndefined();
    expect(staleCounterIncMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on a WEDGED cache read instead of waiting out the redis backstop', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));
    redisMock.redis.hGetAll.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(CACHED['metrics:Image:1']), 1500))
    );

    const start = Date.now();
    const result = await getImageMetricsObject([{ id: 1 }]);
    const elapsed = Date.now() - start;

    expect(result).toEqual({});
    // Excludes a widening past ~800ms. The FLOOR is pinned separately below - this
    // bound alone passes at 700ms and at 1ms.
    expect(elapsed).toBeLessThan(800);
    expect(staleCounterIncMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the deadline wide enough to admit a real round trip', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));
    // 400ms, not 100: with a 100ms read every deadline above ~100 passed, so
    // tightening 500 to 150 for SSR safety - under a real p99 round trip - was
    // green. With the `elapsed < 800` ceiling this pins the constant to (400, 800).
    redisMock.redis.hGetAll.mockImplementation(
      (key: string) => new Promise((resolve) => setTimeout(() => resolve(CACHED[key] ?? {}), 400))
    );

    const result = await getImageMetricsObject([{ id: 1 }]);

    expect(result[1]?.reactionLike).toBe(62);
    expect(staleCounterIncMock).not.toHaveBeenCalled();
  });

  it('reads each id once when the caller repeats one, and keeps the ids aligned', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));

    // Duplicate FIRST and both ids warm, so the de-duplicated array is a different
    // length AND a different order from the caller's. Keying the result by the
    // caller's array instead then hands image 3's counts to image 1.
    const result = await getImageMetricsObject([{ id: 3 }, { id: 3 }, { id: 1 }]);

    expect(result[3]?.reactionLike).toBe(8);
    expect(result[1]?.reactionLike).toBe(62);
    expect(redisMock.redis.hGetAll).toHaveBeenCalledTimes(2);
  });

  it('writes NOTHING to the cache on the fallback path', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));

    await getImageMetricsObject([{ id: 1 }, { id: 2 }]);

    expect(redisMock.redis.hSet).not.toHaveBeenCalled();
    expect(redisMock.redis.hSetEx).not.toHaveBeenCalled();
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  it('returns no metrics rather than throwing when the cache read ALSO fails', async () => {
    fetchMock.mockRejectedValue(new Error('Socket hang up after 3 retries'));
    redisMock.redis.hGetAll.mockRejectedValue(new Error('redis down'));

    await expect(getImageMetricsObject([{ id: 1 }])).resolves.toEqual({});
  });
});
