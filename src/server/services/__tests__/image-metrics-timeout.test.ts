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

const { fetch: fetchMock, counterIncMock } = vi.hoisted(() => ({
  fetch: vi.fn(),
  counterIncMock: vi.fn(),
}));

// Capture the soft-fallback Prometheus counter. image.service creates exactly one
// counter via `registerCounter` (imageMetricsClickhouseTimeoutCounter); override
// just that export with a shared spy so we can assert it increments on the timeout
// path, while keeping every other prom helper real (the import graph also uses
// registerGaugeWithLabels / registerCounterWithLabels at module load).
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/prom/client')>();
  return { ...actual, registerCounter: () => ({ inc: counterIncMock }) };
});

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

  it('leaves every id ABSENT when the metric read HANGS, so a timeout reads as unresolved', async () => {
    fetchMock.mockImplementation(never); // wedged ClickHouse read

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

  it('leaves every id ABSENT when the metric read THROWS, the other failure exit', async () => {
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
