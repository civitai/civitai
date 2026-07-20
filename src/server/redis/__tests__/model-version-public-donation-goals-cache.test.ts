import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mechanism + lookup contract for `modelVersionPublicDonationGoalsCache` — the DB-load-reduction
 * lever behind `model-version.donationGoals` on the public path.
 *
 * This exercises the REAL lookupFn (`publicDonationGoalsLookupFn` from the light
 * `donation-goals-cache` module — the exact function `caches.ts` wires into the cache) against
 * an in-memory packed-redis double + mocked db doubles. No hand-copied mirror: if someone drops
 * the security-relevant `active: true` public filter (the single guard keeping inactive/draft
 * goals out of the shared public key), the `active: true` assertion below fails.
 *
 * Pins:
 *   - the PUBLIC `active: true` goal filter is present on the real query (security invariant);
 *   - dedup/TTL: a second fetch of the same id within the TTL does NOT re-issue the DB lookup;
 *   - existence: an existing version with zero public goals yields an EMPTY entry (caller → []),
 *     while a genuinely-missing version yields NO entry (caller → 404) and is NOT negatively
 *     cached (re-looked-up next time, per `cacheNotFound: false`);
 *   - the per-version early-access filter and the summed totals shape.
 */

const store = new Map<string, unknown>();
const mGetMock = vi.fn(async (keys: string[]) => keys.map((k) => store.get(k)));
const setMock = vi.fn(async (key: string, value: unknown) => {
  store.set(key, value);
});
const delMock = vi.fn(async () => undefined);
const setNxMock = vi.fn().mockResolvedValue(true);

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: {
      mGet: (...args: unknown[]) => mGetMock(...(args as [string[]])),
      set: (...args: unknown[]) => setMock(...(args as [string, unknown])),
    },
    setNxKeepTtlWithEx: (...args: unknown[]) => setNxMock(...args),
    del: (...args: unknown[]) => delMock(...args),
  },
  sysRedis: {},
  REDIS_KEYS: { CACHE_LOCKS: 'caches:lock' },
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
  dbReadFallbackCounter: { inc: vi.fn() },
}));

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    modelVersion: { findMany: vi.fn() },
    donationGoal: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  });
  return { mockDbRead: mk(), mockDbWrite: mk() };
});
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

import { createCachedObject } from '~/server/utils/cache-helpers';
import {
  publicDonationGoalsLookupFn,
  type ModelVersionPublicDonationGoalsCacheItem,
} from '~/server/redis/donation-goals-cache';

// The REAL lookupFn, wired into createCachedObject exactly as caches.ts does.
function buildCache() {
  return createCachedObject<ModelVersionPublicDonationGoalsCacheItem>({
    key: 'test:mv-public-donation-goals' as never,
    idKey: 'modelVersionId',
    ttl: 60,
    staleWhileRevalidate: false,
    cacheNotFound: false,
    lookupFn: publicDonationGoalsLookupFn,
  });
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 10,
  goalAmount: 1000,
  title: 'Goal',
  active: true,
  isEarlyAccess: false,
  userId: 7,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  description: 'desc',
  modelVersionId: 5,
  ...over,
});

beforeEach(() => {
  store.clear();
  mGetMock.mockClear();
  setMock.mockClear();
  delMock.mockClear();
  setNxMock.mockClear().mockResolvedValue(true);
  mockDbRead.modelVersion.findMany.mockReset();
  mockDbRead.donationGoal.findMany.mockReset();
  mockDbRead.user.findMany.mockReset().mockResolvedValue([]);
  mockDbRead.$queryRaw.mockReset();
  mockDbWrite.modelVersion.findMany.mockReset();
  mockDbWrite.donationGoal.findMany.mockReset();
  mockDbWrite.user.findMany.mockReset().mockResolvedValue([]);
  mockDbWrite.$queryRaw.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('publicDonationGoalsLookupFn — security invariant', () => {
  it('queries donation goals with the PUBLIC active:true filter (keeps drafts out)', async () => {
    mockDbRead.modelVersion.findMany.mockResolvedValue([{ id: 5, earlyAccessEndsAt: null }]);
    mockDbRead.donationGoal.findMany.mockResolvedValue([row()]);
    mockDbRead.$queryRaw.mockResolvedValue([{ donationGoalId: 10, total: 250 }]);

    await publicDonationGoalsLookupFn([5]);

    const call = mockDbRead.donationGoal.findMany.mock.calls[0][0];
    // The one guard that keeps inactive/draft goals out of the shared public key.
    expect(call.where.active).toBe(true);
    expect(call.where.modelVersionId).toEqual({ in: [5] });
  });
});

describe('modelVersionPublicDonationGoalsCache', () => {
  it('hits the DB once, then serves the second fetch of the same version from cache', async () => {
    mockDbRead.modelVersion.findMany.mockResolvedValue([{ id: 5, earlyAccessEndsAt: null }]);
    mockDbRead.donationGoal.findMany.mockResolvedValue([row()]);
    mockDbRead.$queryRaw.mockResolvedValue([{ donationGoalId: 10, total: 250 }]);
    const cache = buildCache();

    const first = await cache.fetch([5]);
    const second = await cache.fetch([5]);

    expect(mockDbRead.modelVersion.findMany).toHaveBeenCalledTimes(1);
    expect(mockDbRead.donationGoal.findMany).toHaveBeenCalledTimes(1);
    expect(first[5].goals).toEqual([
      {
        id: 10,
        goalAmount: 1000,
        title: 'Goal',
        active: true,
        isEarlyAccess: false,
        userId: 7,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        description: 'desc',
        total: 250,
      },
    ]);
    expect(second[5].goals).toEqual(first[5].goals);
  });

  it('caches an EMPTY entry for an existing version with no public goals (returns [], not 404)', async () => {
    mockDbRead.modelVersion.findMany.mockResolvedValue([{ id: 8, earlyAccessEndsAt: null }]);
    mockDbRead.donationGoal.findMany.mockResolvedValue([]);
    const cache = buildCache();

    const first = await cache.fetch([8]);
    const second = await cache.fetch([8]);

    expect(first[8]).toEqual({ modelVersionId: 8, goals: [] });
    expect(mockDbRead.modelVersion.findMany).toHaveBeenCalledTimes(1); // positive entry cached
    expect(second[8].goals).toEqual([]);
  });

  it('yields NO entry for a missing version and does not negatively cache it (cacheNotFound: false)', async () => {
    mockDbRead.modelVersion.findMany.mockResolvedValue([]); // replica miss
    mockDbWrite.modelVersion.findMany.mockResolvedValue([]); // primary miss too → genuinely gone
    const cache = buildCache();

    const first = await cache.fetch([999]);
    const second = await cache.fetch([999]);

    expect(first[999]).toBeUndefined(); // caller maps absent entry → NOT_FOUND
    // Not negatively cached → the lookup (incl. primary fallback) re-runs each time.
    expect(mockDbRead.modelVersion.findMany).toHaveBeenCalledTimes(2);
    expect(mockDbWrite.modelVersion.findMany).toHaveBeenCalledTimes(2);
    expect(second[999]).toBeUndefined();
  });

  it('applies the public early-access filter per version', async () => {
    mockDbRead.modelVersion.findMany.mockResolvedValue([
      { id: 5, earlyAccessEndsAt: null }, // EA goals hidden
      { id: 9, earlyAccessEndsAt: new Date('2099-01-01T00:00:00.000Z') }, // EA goals shown
    ]);
    mockDbRead.donationGoal.findMany.mockResolvedValue([
      row({ id: 10, isEarlyAccess: false, modelVersionId: 5 }),
      row({ id: 11, isEarlyAccess: true, modelVersionId: 5 }),
      row({ id: 20, isEarlyAccess: false, modelVersionId: 9 }),
      row({ id: 21, isEarlyAccess: true, modelVersionId: 9 }),
    ]);
    mockDbRead.$queryRaw.mockResolvedValue([]); // all totals default to 0
    const cache = buildCache();

    const res = await cache.fetch([5, 9]);

    expect(res[5].goals.map((g) => g.id)).toEqual([10]); // EA goal 11 excluded
    expect(res[9].goals.map((g) => g.id).sort((a, b) => a - b)).toEqual([20, 21]); // both shown
    expect(res[5].goals[0].total).toBe(0); // no donation → 0
  });

  it('hides an early-access goal once the early-access window has ended (past date)', async () => {
    mockDbRead.modelVersion.findMany.mockResolvedValue([
      { id: 9, earlyAccessEndsAt: new Date('2000-01-01T00:00:00.000Z') }, // EA already ended
    ]);
    mockDbRead.donationGoal.findMany.mockResolvedValue([
      row({ id: 20, isEarlyAccess: false, modelVersionId: 9 }),
      row({ id: 21, isEarlyAccess: true, modelVersionId: 9 }),
    ]);
    mockDbRead.$queryRaw.mockResolvedValue([]);
    const cache = buildCache();

    const res = await cache.fetch([9]);

    expect(res[9].goals.map((g) => g.id)).toEqual([20]); // ended EA goal 21 excluded
  });

  it('hides all goals whose owner opted out via hideDonationGoals', async () => {
    mockDbRead.modelVersion.findMany.mockResolvedValue([{ id: 5, earlyAccessEndsAt: null }]);
    mockDbRead.donationGoal.findMany.mockResolvedValue([
      row({ id: 10, userId: 7, modelVersionId: 5 }),
    ]);
    mockDbRead.user.findMany.mockResolvedValue([{ id: 7, settings: { hideDonationGoals: true } }]);
    mockDbRead.$queryRaw.mockResolvedValue([]);
    const cache = buildCache();

    const res = await cache.fetch([5]);

    expect(res[5]).toEqual({ modelVersionId: 5, goals: [] }); // owner opted out → nothing public
  });
});
