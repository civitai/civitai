import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// getImagesFromFeedSearch is the DEFAULT (non-bitdex, non-legacy) /api/v1/images +
// image-feed path. Its metric-enrichment leg runs INSIDE event-engine-common's
// `feed.populatedQuery()` (the MetricService ClickHouse read), so a CH connection
// error thrown there is NOT a Meili error and — before this fix — fell through the
// catch's `throw err` to the handler's generic 500.
//
// Contract pinned here:
//   - a TRANSIENT CH transport error from populatedQuery → re-mapped to a retryable
//     SERVICE_UNAVAILABLE (503), the failsoft counter increments, items don't 500.
//   - a CH QUERY/SCHEMA error (UNKNOWN_TABLE) → still rethrows (→ 500, visible).
//   - a non-CH error → still rethrows unchanged.
//
// Same minimal-seam mocking as image-metrics-timeout.test.ts: stub the private
// event-engine-common submodule + the infra clients + env so importing image.service
// doesn't boot real infra.

const { populatedQueryMock, chFailSoftIncMock, logToAxiomMock } = vi.hoisted(() => ({
  populatedQueryMock: vi.fn(),
  chFailSoftIncMock: vi.fn(),
  logToAxiomMock: vi.fn(async () => {}),
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/prom/client')>();
  return {
    ...actual,
    clickhouseFailSoftCounter: { inc: chFailSoftIncMock },
  };
});

vi.mock('~/server/logging/client', () => ({
  logToAxiom: logToAxiomMock,
  safeError: (e: unknown) => e,
}));

// event-engine-common is a private submodule not checked out here. ImagesFeed is the
// seam under test: its instance `.populatedQuery` is our spy.
vi.mock('../../../../event-engine-common/feeds', () => ({
  ImagesFeed: class {
    populatedQuery = populatedQueryMock;
  },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
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

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
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

// getFliptBoolean is called at the top of getImagesFromFeedSearch (existence-check
// flag). Stub the whole module (a Proxy returns a no-op fn for any export image.service
// reads at load) so the feed path proceeds to populatedQuery without booting real Flipt.
vi.mock('~/server/flipt/client', () => {
  const noop = vi.fn(async () => false);
  return new Proxy(
    {
      getFliptBoolean: noop,
      isFlipt: noop,
      getFliptVariant: vi.fn(async () => undefined),
      FLIPT_FEATURE_FLAGS: new Proxy({}, { get: (_t, p) => String(p) }),
    },
    { get: (t, p) => (p in t ? (t as any)[p] : vi.fn(async () => false)) }
  );
});

import { getImagesFromFeedSearch } from '../image.service';

const baseInput = {
  limit: 10,
  browsingLevel: 1,
  periodMode: 'published',
  include: [],
} as any;

describe('getImagesFromFeedSearch ClickHouse transport fail-soft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-maps a TRANSIENT CH transport error (socket hang up) to a retryable 503', async () => {
    populatedQueryMock.mockRejectedValue(new Error('socket hang up'));

    await expect(getImagesFromFeedSearch(baseInput)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(chFailSoftIncMock).toHaveBeenCalledWith({ path: 'image-feed' });
  });

  it('re-maps a Code 279 ALL_CONNECTION_TRIES_FAILED to a retryable 503', async () => {
    const err = Object.assign(
      new Error('Code: 279. DB::NetException: All connection tries failed. (ALL_CONNECTION_TRIES_FAILED)'),
      { code: '279' }
    );
    populatedQueryMock.mockRejectedValue(err);

    const rejection = await getImagesFromFeedSearch(baseInput).catch((e) => e);
    expect(rejection).toBeInstanceOf(TRPCError);
    expect(rejection.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('does NOT swallow a CH query/schema error (UNKNOWN_TABLE) — rethrows as a 500', async () => {
    const err = Object.assign(
      new Error('Code: 60. DB::Exception: Table x does not exist. (UNKNOWN_TABLE)'),
      { code: '60' }
    );
    populatedQueryMock.mockRejectedValue(err);

    await expect(getImagesFromFeedSearch(baseInput)).rejects.toThrow(/does not exist/);
    // Must NOT be re-mapped to a 503, and must NOT count a fail-soft.
    const rejection = await getImagesFromFeedSearch(baseInput).catch((e) => e);
    expect(rejection).not.toBeInstanceOf(TRPCError);
    expect(chFailSoftIncMock).not.toHaveBeenCalled();
  });

  it('rethrows a non-CH error unchanged', async () => {
    populatedQueryMock.mockRejectedValue(new TypeError("Cannot read properties of undefined"));
    await expect(getImagesFromFeedSearch(baseInput)).rejects.toThrow(/Cannot read properties/);
    expect(chFailSoftIncMock).not.toHaveBeenCalled();
  });

  it('happy path: returns transformed items, no fail-soft', async () => {
    populatedQueryMock.mockResolvedValue({ items: [], nextCursor: undefined });
    const result = await getImagesFromFeedSearch(baseInput);
    expect(result.items).toEqual([]);
    expect(chFailSoftIncMock).not.toHaveBeenCalled();
  });
});
