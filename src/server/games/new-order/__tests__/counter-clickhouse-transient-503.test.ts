import { TRPCError } from '@trpc/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression: /api/trpc/games.newOrder.addRating returned a 500 (~10/12h) on a
// TRANSIENT ClickHouse connection blip. On a Redis cache miss, createCounter's
// getCount/getCountBatch call fetchCount → clickhouse.$query, which the
// @civitai/clickhouse client flattens to `Error('ClickHouse query failed: socket
// hang up')`. That un-try-caught throw bubbled through addImageRating →
// processImageRating and tRPC wrapped the non-TRPCError as INTERNAL_SERVER_ERROR
// (500). A transient dependency outage should be a retryable SERVICE_UNAVAILABLE
// (503), not a 500. A REAL query/schema fault (non-connection CH error) must
// still surface raw.

const { mockSysRedis, mockClickhouse } = vi.hoisted(() => ({
  mockSysRedis: {
    // Cache miss on every read → forces the fetchCount path.
    zScore: vi.fn().mockResolvedValue(null),
    zAdd: vi.fn().mockResolvedValue(1),
    zRangeWithScores: vi.fn(),
    zRem: vi.fn().mockResolvedValue(1),
    hDel: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
  },
  // $query is a tagged template on the client; the counter's fetchCount awaits it.
  mockClickhouse: { $query: vi.fn() },
}));

vi.mock('~/server/redis/client', () => ({
  redis: {},
  sysRedis: mockSysRedis,
  REDIS_KEYS: {},
  REDIS_SYS_KEYS: {
    NEW_ORDER: {
      FERVOR: 'new-order:fervor',
      SANITY_CHECKS: { FAILURES: 'new-order:sanity-check-failures' },
      JUDGEMENTS: { ACOLYTE_FAILED: 'new-order:acolyte-failed' },
      EXP: 'new-order:exp',
      BUZZ: 'new-order:blessed-buzz',
      PENDING_BUZZ: 'new-order:pending-buzz',
      RECENTLY_GRANTED_BUZZ: 'new-order:recently-granted-buzz',
      SMITE: 'new-order:smite-progress',
      QUEUES: 'new-order:queues',
      RATINGS: 'new-order:ratings',
    },
  },
}));

vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(), zAddWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockClickhouse }));
vi.mock('~/server/db/client', () => ({ dbRead: {} }));

// NOTE: errorHandling is intentionally NOT mocked — we exercise the REAL
// isClickHouseConnectionError (message-shape match) + throwServiceUnavailableError
// (the 503 mapping) end to end.

import { getImageRatingsCounter } from '~/server/games/new-order/utils';

beforeEach(() => {
  vi.clearAllMocks();
  mockSysRedis.zScore.mockResolvedValue(null); // re-arm cache miss after clearAllMocks
});

describe('createCounter — transient ClickHouse error → 503 (SERVICE_UNAVAILABLE)', () => {
  it('getCount: `socket hang up` in fetchCount maps to a TRPCError SERVICE_UNAVAILABLE', async () => {
    mockClickhouse.$query.mockRejectedValue(
      new Error('ClickHouse query failed: socket hang up')
    );

    const counter = getImageRatingsCounter(123);
    await expect(counter.getCount('Knight-3')).rejects.toSatisfy(
      (e: unknown) => e instanceof TRPCError && e.code === 'SERVICE_UNAVAILABLE'
    );
  });

  it('getCountBatch: `socket hang up` in fetchCount maps to a TRPCError SERVICE_UNAVAILABLE', async () => {
    mockClickhouse.$query.mockRejectedValue(
      new Error('ClickHouse query failed: socket hang up')
    );

    const counter = getImageRatingsCounter(123);
    await expect(counter.getCountBatch(['Knight-3', 'Templar-2'])).rejects.toSatisfy(
      (e: unknown) => e instanceof TRPCError && e.code === 'SERVICE_UNAVAILABLE'
    );
  });

  it('preserves the original error as the TRPCError cause for diagnosability', async () => {
    const original = new Error('ClickHouse query failed: socket hang up');
    mockClickhouse.$query.mockRejectedValue(original);

    const counter = getImageRatingsCounter(123);
    const err = await counter.getCount('Knight-3').catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).cause).toBe(original);
  });

  it('does NOT convert a real (non-connection) CH error — a syntax fault surfaces raw', async () => {
    // Code: 62 = syntax error — a genuine query/schema bug, NOT a transient blip.
    mockClickhouse.$query.mockRejectedValue(
      new Error('ClickHouse query failed: Code: 62. DB::Exception: Syntax error')
    );

    const counter = getImageRatingsCounter(123);
    const err = await counter.getCount('Knight-3').catch((e) => e);
    // Not a 503 — must NOT be masked as SERVICE_UNAVAILABLE.
    expect(
      err instanceof TRPCError && (err as TRPCError).code === 'SERVICE_UNAVAILABLE'
    ).toBe(false);
    expect((err as Error).message).toContain('Code: 62');
  });
});
