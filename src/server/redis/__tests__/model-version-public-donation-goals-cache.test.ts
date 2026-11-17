import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';

/**
 * Mechanism + lookup contract for `modelVersionPublicDonationGoalsCache` — the DB-load-reduction
 * lever behind `model-version.donationGoals` on the public path.
 *
 * This exercises the REAL lookupFn (`publicDonationGoalsLookupFn` from the light
 * `donation-goals-cache` module — the exact function `caches.ts` wires into the cache) against
 * an in-memory packed-redis double + mocked db doubles: the replica's version and goal reads are
 * Kysely statements (stubbed here), the primary's (fromWrite, and the replica-miss fallback) and
 * the totals are Prisma. No hand-copied mirror: if someone drops the security-relevant
 * `active: true` public filter (the single guard keeping inactive/draft goals out of the shared
 * public key) from the Prisma read, the `active: true` assertion below fails; the Kysely
 * statement's `active = true` is pinned by the hot-reads-6 parity suite's inactive-goal fixture.
 *
 * Pins:
 *   - the PUBLIC `active: true` goal filter is present on the real Prisma query (security
 *     invariant), and the replica goal read is the Kysely statement that carries it;
 *   - dedup/TTL: a second fetch of the same id within the TTL does NOT re-issue the DB lookup;
 *   - existence: an existing version with zero public goals yields an EMPTY entry (caller → []),
 *     while a genuinely-missing version yields NO entry (caller → 404) and is NOT negatively
 *     cached (re-looked-up next time, per `cacheNotFound: false`);
 *   - the summed totals shape.
 *
 * The early-access-window + creator opt-out DISPLAY filters are applied at READ time in
 * `getDonationGoals` (donation-goals-accessor.test.ts), NOT here.
 */

const store = new Map<string, unknown>();
const mGetMock = vi.fn(async (keys: string[]) => keys.map((k) => store.get(k)));
const setMock = vi.fn(async (key: string, value: unknown) => {
  store.set(key, value);
});
const delMock = vi.fn(async () => undefined);
const setNxMock = vi.fn().mockResolvedValue(true);

// 🔴 Spreads the real package for the key CONSTANTS; only the client stubs are overridden.
// `REDIS_KEYS.CACHE_LOCKS` used to be hand-typed here as 'caches:lock' — the real value is
// 'cache-lock'. Both the lock writer and the lock reader read that one fake, so the suite
// passed while exercising a key Redis never sees. See no-hand-typed-redis-key-constants.test.ts.
vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  redis: {
    packed: {
      mGet: (...args: unknown[]) => mGetMock(...(args as [string[]])),
      set: (...args: unknown[]) => setMock(...(args as [string, unknown])),
    },
    setNxKeepTtlWithEx: (...args: unknown[]) => setNxMock(...args),
    del: (...args: unknown[]) => delMock(...args),
  },
  sysRedis: {},
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
    $queryRaw: vi.fn(),
  });
  return { mockDbRead: mk(), mockDbWrite: mk() };
});
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

// The replica's Kysely client (a sentinel: no pool is built) and its two statements.
const { kyselyReplica, listExistingModelVersionIds, listActiveModelVersionDonationGoals } =
  vi.hoisted(() => ({
    kyselyReplica: { client: 'kysely-replica' },
    listExistingModelVersionIds: vi.fn(),
    listActiveModelVersionDonationGoals: vi.fn(),
  }));
vi.mock('~/server/db/kyselyDb.lazy', () => ({
  loadKyselyDb: async () => ({ kyselyRead: kyselyReplica }),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  listExistingModelVersionIds,
  listActiveModelVersionDonationGoals,
}));

import { createCachedObject } from '~/server/utils/cache-helpers';
import {
  publicDonationGoalsLookupFn,
  type ModelVersionPublicDonationGoalCacheItem,
} from '~/server/redis/donation-goals-cache';

// The REAL lookupFn, wired into createCachedObject exactly as caches.ts does.
function buildCache() {
  return createCachedObject<ModelVersionPublicDonationGoalCacheItem>({
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
  userId: 7,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  description: 'desc',
  entityId: 5,
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
  listExistingModelVersionIds.mockReset();
  listActiveModelVersionDonationGoals.mockReset();
  mockDbRead.$queryRaw.mockReset();
  mockDbWrite.modelVersion.findMany.mockReset();
  mockDbWrite.donationGoal.findMany.mockReset();
  mockDbWrite.$queryRaw.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('publicDonationGoalsLookupFn — security invariant', () => {
  it('queries donation goals with the PUBLIC active:true filter on the primary (keeps drafts out)', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 5 }]);
    mockDbWrite.donationGoal.findMany.mockResolvedValue([row()]);
    mockDbWrite.$queryRaw.mockResolvedValue([{ donationGoalId: 10, total: 250 }]);

    await publicDonationGoalsLookupFn([5], true);

    const call = mockDbWrite.donationGoal.findMany.mock.calls[0][0];
    // The one guard that keeps inactive/draft goals out of the shared public key.
    expect(call.where.active).toBe(true);
    expect(call.where.entityType).toBe('ModelVersion');
    expect(call.where.entityId).toEqual({ in: [5] });
  });

  it('reads the replica goals through the Kysely active-goals statement', async () => {
    listExistingModelVersionIds.mockResolvedValue([{ id: 5 }]);
    listActiveModelVersionDonationGoals.mockResolvedValue([row()]);
    mockDbRead.$queryRaw.mockResolvedValue([{ donationGoalId: 10, total: 250 }]);

    await publicDonationGoalsLookupFn([5]);

    expect(listActiveModelVersionDonationGoals.mock.calls).toEqual([[kyselyReplica, [5]]]);
    expect(listActiveModelVersionDonationGoals.mock.calls[0][0]).toBe(kyselyReplica);
    expect(mockDbRead.donationGoal.findMany).not.toHaveBeenCalled();
  });
});

describe('modelVersionPublicDonationGoalsCache', () => {
  it('hits the DB once, then serves the second fetch of the same version from cache', async () => {
    listExistingModelVersionIds.mockResolvedValue([{ id: 5, earlyAccessEndsAt: null }]);
    listActiveModelVersionDonationGoals.mockResolvedValue([row()]);
    mockDbRead.$queryRaw.mockResolvedValue([{ donationGoalId: 10, total: 250 }]);
    const cache = buildCache();

    const first = await cache.fetch([5]);
    const second = await cache.fetch([5]);

    expect(listExistingModelVersionIds).toHaveBeenCalledTimes(1);
    expect(listActiveModelVersionDonationGoals).toHaveBeenCalledTimes(1);
    expect(first[5].goal).toEqual({
      id: 10,
      goalAmount: 1000,
      title: 'Goal',
      active: true,
      userId: 7,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      description: 'desc',
      total: 250,
    });
    expect(second[5].goal).toEqual(first[5].goal);
  });

  it('caches an EMPTY entry for an existing version with no public goals (returns [], not 404)', async () => {
    listExistingModelVersionIds.mockResolvedValue([{ id: 8, earlyAccessEndsAt: null }]);
    listActiveModelVersionDonationGoals.mockResolvedValue([]);
    const cache = buildCache();

    const first = await cache.fetch([8]);
    const second = await cache.fetch([8]);

    expect(first[8]).toEqual({ modelVersionId: 8, goal: null });
    expect(listExistingModelVersionIds).toHaveBeenCalledTimes(1); // positive entry cached
    expect(second[8].goal).toBeNull();
  });

  it('yields NO entry for a missing version and does not negatively cache it (cacheNotFound: false)', async () => {
    listExistingModelVersionIds.mockResolvedValue([]); // replica miss
    mockDbWrite.modelVersion.findMany.mockResolvedValue([]); // primary miss too → genuinely gone
    const cache = buildCache();

    const first = await cache.fetch([999]);
    const second = await cache.fetch([999]);

    expect(first[999]).toBeUndefined(); // caller maps absent entry → NOT_FOUND
    // Not negatively cached → the lookup (incl. primary fallback) re-runs each time.
    expect(listExistingModelVersionIds).toHaveBeenCalledTimes(2);
    expect(mockDbWrite.modelVersion.findMany).toHaveBeenCalledTimes(2);
    expect(second[999]).toBeUndefined();
  });

  it('refresh() after a donation caches the PRIMARY total, even while the replica lags', async () => {
    // The donation path refreshes rather than busts, so what refresh() caches must include the
    // just-committed donation: the goal and its total come from the primary (fromWrite).
    listExistingModelVersionIds.mockResolvedValue([{ id: 5, earlyAccessEndsAt: null }]);
    listActiveModelVersionDonationGoals.mockResolvedValue([row()]);
    mockDbRead.$queryRaw.mockResolvedValue([{ donationGoalId: 10, total: 250 }]); // replica: pre-donation
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 5 }]);
    mockDbWrite.donationGoal.findMany.mockResolvedValue([row()]);
    mockDbWrite.$queryRaw.mockResolvedValue([{ donationGoalId: 10, total: 300 }]); // primary: post-donation
    const cache = buildCache();
    expect((await cache.fetch([5]))[5].goal?.total).toBe(250);

    await cache.refresh(5);
    const afterRefresh = await cache.fetch([5]);

    expect(afterRefresh[5].goal?.total).toBe(300);
    // Served from the refreshed entry: no further replica lookup.
    expect(listActiveModelVersionDonationGoals).toHaveBeenCalledTimes(1);
  });

  it('refresh() of a version not yet on the replica checks existence on the primary and caches it', async () => {
    // ensureDonationGoal refreshes right after a version and its goal are created. If existence were
    // read from the replica only, the lookup would return {} and refresh() would delete the entry.
    listExistingModelVersionIds.mockResolvedValue([]); // replica: version not there yet
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 5 }]);
    mockDbWrite.donationGoal.findMany.mockResolvedValue([row()]);
    mockDbWrite.$queryRaw.mockResolvedValue([]); // no donations yet
    const cache = buildCache();

    await cache.refresh(5);

    expect(delMock).not.toHaveBeenCalled();
    const fetched = await cache.fetch([5]);
    expect(fetched[5].goal?.id).toBe(10);
    expect(fetched[5].goal?.total).toBe(0);
    // Served from the refreshed entry, not a read-path lookup.
    expect(listExistingModelVersionIds).not.toHaveBeenCalled();
  });

  // The early-access-window + creator opt-out DISPLAY filters live at read time in getDonationGoals
  // (see donation-goals-accessor.test.ts) — the cache holds only the raw active goal + total.
});
