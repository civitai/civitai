import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ImageMetricsSwrModule from '../image-metrics-swr';

// The seam between getImageMetricsObject and the image-metrics-swr arm: the flag decides which
// read runs, and with it ON a cached id must not reach MetricService.fetch (where a cold miss
// queries ClickHouse inline). The arm's own logic is covered in image-metrics-swr.test.ts; this
// file covers the wiring in image.service, which that file never loads.
//
// Same mock seams as image-metrics-timeout.test.ts (read its header for why each exists).

const { fetchMock, refreshInBackgroundMock, swrGateMock, envValues } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  refreshInBackgroundMock: vi.fn(),
  swrGateMock: vi.fn(),
  // Mutable per case: the latency cases need a ClickHouse budget above the 500ms cache deadline.
  envValues: { CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: 200, LOGGING: [] as string[] } as Record<
    string,
    unknown
  >,
}));

vi.mock('../image-metrics-swr', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageMetricsSwrModule>();
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
  env: new Proxy(envValues, {
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

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
import { getImageMetricsObject, getImageMetricsObjectDirect } from '../image.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const never = () => new Promise<never>(() => undefined);

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
    refreshInBackgroundMock.mockImplementation(never);
    envValues.CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS = 200;
  });

  afterEach(() => {
    vi.useRealTimers();
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

  // The flag-OFF worst case is the ClickHouse budget plus the 500ms stale-cache deadline. These
  // cases use a 3000ms budget so the cache read's own 500ms deadline sits inside it.
  const BUDGET_MS = 3000;
  const OFF_WORST_MS = BUDGET_MS + 500;

  // Settles `promise` under fake timers, reporting whether it had settled after `ms`.
  const settledWithin = async <T>(promise: Promise<T>, ms: number) => {
    let settled = false;
    void promise.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  };

  it('flag ON: a HANGING hash read is classified unanswered at the deadline and read the OFF way', async () => {
    vi.useFakeTimers();
    envValues.CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS = BUDGET_MS;
    swrGateMock.mockReturnValue(true);
    redisMock.redis.hGetAll.mockImplementation(async (key: string) =>
      key === 'metrics:Image:3' ? never() : hashes()[key] ?? {}
    );

    const pending = getImageMetricsObject([{ id: 1 }, { id: 3 }]);
    // Not before the 500ms cache deadline: the hung key holds the read until then...
    expect(await settledWithin(pending, 499)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // ...and at it, the hung id alone goes to MetricService, which answers.
    expect(await settledWithin(pending, 1)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('Image', [3]);
    const result = await pending;
    expect(result[1]?.reactionLike).toBe(62);
    expect(result[3]?.reactionLike).toBe(903);
  });

  it('flag ON: Redis AND ClickHouse hanging costs no more than flag OFF does', async () => {
    vi.useFakeTimers();
    envValues.CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS = BUDGET_MS;
    redisMock.redis.hGetAll.mockImplementation(never);
    fetchMock.mockImplementation(never);

    // OFF's own worst case, measured the same way, so the bound below is not a guess.
    swrGateMock.mockReturnValue(false);
    const off = getImageMetricsObject([{ id: 1 }, { id: 2 }]);
    expect(await settledWithin(off, OFF_WORST_MS - 1)).toBe(false);
    expect(await settledWithin(off, 1)).toBe(true);
    expect(await off).toEqual({});

    // ON: 500ms cache read, then only the REST of the budget for MetricService, then the same
    // 500ms cache deadline. Without the shared budget this was 500ms later than OFF.
    swrGateMock.mockReturnValue(true);
    const on = getImageMetricsObject([{ id: 1 }, { id: 2 }]);
    expect(await settledWithin(on, OFF_WORST_MS)).toBe(true);
    // Unknown, not zero: both ids stay absent, as on OFF.
    expect(await on).toEqual({});
  });

  // A budget no larger than the 500ms cache-read deadline is all spent by that read, so the ids it
  // could not answer reach getImageMetricsObjectDirect with 0ms left. `withTimeoutFallback` reads a
  // non-positive deadline as NO deadline, so without the exhausted-budget guard there they would
  // wait on MetricService (here: forever). Two budgets: under the deadline, and exactly on it.
  it.each([300, 500])(
    'flag ON: a %ims budget spent by the cache read answers from the cache, never MetricService',
    async (budgetMs) => {
      vi.useFakeTimers();
      envValues.CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS = budgetMs;
      swrGateMock.mockReturnValue(true);
      fetchMock.mockImplementation(never);
      // Each key's FIRST read (the SWR arm's) hangs; the cache path's read after it answers, so a
      // value in the result can only have come from the cache path.
      const readOnce = new Set<string>();
      redisMock.redis.hGetAll.mockImplementation(async (key: string) => {
        if (!readOnce.has(key)) {
          readOnce.add(key);
          return never();
        }
        return hashes()[key] ?? {};
      });

      const pending = getImageMetricsObject([{ id: 1 }, { id: 2 }]);
      // Bounded by flag OFF's worst case (budget + the cache path's own 500ms deadline).
      expect(await settledWithin(pending, budgetMs + 500)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      const result = await pending;
      expect(result[1]?.reactionLike).toBe(62);
      expect(result[2]?.reactionLike).toBe(8);
    }
  );

  it.each([0, -1])(
    'getImageMetricsObjectDirect with a %ims budget skips MetricService and serves the cache',
    async (timeoutMs) => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(never);

      const pending = getImageMetricsObjectDirect([{ id: 1 }, { id: 3 }], timeoutMs);
      expect(await settledWithin(pending, 500)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      const result = await pending;
      expect(result[1]?.reactionLike).toBe(62);
      // Nothing cached for id 3: absent (unknown), not zero.
      expect(result).not.toHaveProperty('3');
    }
  );

  it('flag ON: when the SWR arm THROWS, every id is read the OFF way and the failure is logged', async () => {
    swrGateMock.mockReturnValue(true);
    // A hash whose field read throws makes the shaping step throw, the one leg that is not
    // fail-soft by construction.
    const poisoned = {
      _populatedAt: String(nowSeconds() - 60),
      get Like(): string {
        throw new Error('poisoned hash');
      },
    };
    redisMock.redis.hGetAll.mockImplementation(async (key: string) =>
      key === 'metrics:Image:5' ? poisoned : hashes()[key] ?? {}
    );

    const result = await getImageMetricsObject([{ id: 5 }, { id: 1 }]);

    // All ids, not just the cold ones: the OFF read replaces the arm's answer whole.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('Image', [5, 1]);
    expect(result[5]?.reactionLike).toBe(905);
    expect(result[1]?.reactionLike).toBe(901);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Failed to getImageMetrics swr', message: 'poisoned hash' }),
      'clickhouse'
    );
  });

  it('flag ON: the throw fallback gets only what is left of the budget', async () => {
    vi.useFakeTimers();
    envValues.CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS = BUDGET_MS;
    swrGateMock.mockReturnValue(true);
    fetchMock.mockImplementation(never);
    const poisoned = {
      _populatedAt: String(nowSeconds() - 60),
      get Like(): string {
        throw new Error('poisoned hash');
      },
    };
    // Id 2 hangs, so the throw lands only after the full 500ms cache deadline has been spent.
    redisMock.redis.hGetAll.mockImplementation(async (key: string) =>
      key === 'metrics:Image:2' ? never() : poisoned
    );

    const pending = getImageMetricsObject([{ id: 1 }, { id: 2 }]);
    expect(await settledWithin(pending, OFF_WORST_MS)).toBe(true);
    expect(await pending).toEqual({});
  });
});
