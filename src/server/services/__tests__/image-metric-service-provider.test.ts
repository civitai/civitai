import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AggSource } from '../../../../event-engine-common/services/metrics';

// Regression guard for the 2026-06-24 incident (PR #2666). The image-metric read
// path must construct `MetricService` WITH an aggSourceProvider that resolves to
// the FINAL `entityMetricDailyAgg_v2` view. #2666 dropped that provider arg →
// MetricService fell back to the submodule DEFAULT_AGG_SOURCE (the legacy
// `entityMetricDailyAgg_new` table, since dropped from ClickHouse) → UNKNOWN_TABLE
// → 500s on /api/v1/images + on-site image feeds.
//
// We replace MetricService with a capturing class that records the 3rd
// constructor arg, drive getImageMetricsObject (which lazily constructs the
// shared singleton via getImageMetricService), and assert the captured provider
// resolves to v2 — NOT undefined, NOT `entityMetricDailyAgg_new`. A future edit
// that re-drops the provider arg (the exact #2666 regression) FAILS this test.

const { fetchMock, capturedProviders } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  capturedProviders: [] as Array<(() => Promise<AggSource> | AggSource) | undefined>,
}));

// image.service's import graph (selectors/caches) calls `Prisma.validator(...)`
// at module load. Under vitest's SSR transform the generated @prisma/client
// re-export resolves to a stub without `.validator`, so stub the Prisma helpers
// it touches at import time (established pattern, e.g. model3d-visible-id-for-post).
vi.mock('@prisma/client', () => ({
  Prisma: {
    validator: () => (x: unknown) => x,
    sql: () => ({}),
    join: () => ({}),
    raw: () => ({}),
  },
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/prom/client')>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});

// Capture the aggSourceProvider passed to every MetricService construction.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = fetchMock;
    constructor(_ch: unknown, _redis: unknown, aggSourceProvider?: () => unknown) {
      capturedProviders.push(aggSourceProvider as never);
    }
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Fully replace env (real `~/env/server` validates ALL prod env and throws in
// test). A Proxy returns undefined for any var, and a safe value for *_URL /
// numeric-looking config the import graph builds at module load. Mirrors the
// established pattern in image-metrics-timeout.test.ts.
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

import { getImageMetricsObject } from '../image.service';

describe('image-metric read path constructs MetricService with the v2 agg-source provider', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('passes a provider resolving to entityMetricDailyAgg_v2 (guards the #2666 no-provider regression)', async () => {
    fetchMock.mockResolvedValue({});

    // Drives getImageMetricService() → constructs the shared MetricService singleton.
    await getImageMetricsObject([{ id: 1 }]);

    // At least one MetricService was constructed on this path.
    expect(capturedProviders.length).toBeGreaterThan(0);

    for (const provider of capturedProviders) {
      // The #2666 regression was a construction with NO provider (undefined) →
      // submodule DEFAULT_AGG_SOURCE = entityMetricDailyAgg_new. Reject that.
      expect(provider, 'MetricService must be constructed WITH an aggSourceProvider').toBeDefined();

      const source = await provider!();
      expect(source).toEqual({ table: 'entityMetricDailyAgg_v2', needsArgMaxDedup: false });
      expect(source.table).not.toBe('entityMetricDailyAgg_new');
    }
  });
});
