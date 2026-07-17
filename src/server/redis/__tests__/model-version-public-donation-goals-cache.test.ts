import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mechanism contract for `modelVersionPublicDonationGoalsCache` — the DB-load-reduction lever
 * behind `model-version.donationGoals` on the public path.
 *
 * The cache is a `createCachedObject` keyed by modelVersionId with a 60s TTL and
 * `cacheNotFound: false`. This test exercises the REAL cache mechanism against an in-memory
 * packed-redis double + mocked db doubles and pins:
 *   - dedup/TTL: a second fetch of the same id within the TTL does NOT re-issue the DB lookup;
 *   - existence: an existing version with zero public goals yields an EMPTY entry (caller
 *     returns []), while a genuinely-missing version yields NO entry (caller 404s) and is NOT
 *     negatively cached (re-looked-up next time, per `cacheNotFound: false`);
 *   - the public early-access filter and the summed totals shape.
 *
 * DIVERGENCE RISK: importing the real `modelVersionPublicDonationGoalsCache` from caches.ts
 * would drag in its env/clickhouse/orchestrator import graph, so this replicates its lookupFn.
 * Keep this a FAITHFUL mirror of caches.ts `modelVersionPublicDonationGoalsCache.lookupFn` —
 * same existence + primary-fallback, same `active: true` public filter, same early-access
 * filter, same totals map, same "seed an empty entry per existing version". Change one, change
 * both.
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
}));

import { createCachedObject } from '~/server/utils/cache-helpers';

type GoalRow = {
  id: number;
  goalAmount: number;
  title: string;
  active: boolean;
  isEarlyAccess: boolean;
  userId: number;
  createdAt: Date;
  description: string | null;
  modelVersionId: number | null;
};
type Item = { modelVersionId: number; goals: Array<Omit<GoalRow, 'modelVersionId'> & { total: number }> };

// db doubles.
const mvReadFindMany = vi.fn(); // dbRead.modelVersion.findMany
const mvWriteFindMany = vi.fn(); // dbWrite.modelVersion.findMany (primary fallback)
const dgFindMany = vi.fn(); // db.donationGoal.findMany
const donationTotals = vi.fn(); // $queryRaw totals
const fallbackInc = vi.fn();

// FAITHFUL mirror of caches.ts `modelVersionPublicDonationGoalsCache.lookupFn`.
function buildCache() {
  return createCachedObject<Item>({
    key: 'test:mv-public-donation-goals' as never,
    idKey: 'modelVersionId',
    ttl: 60,
    staleWhileRevalidate: false,
    cacheNotFound: false,
    lookupFn: async (ids, fromWrite) => {
      let versions: { id: number; earlyAccessEndsAt: Date | null }[] = await mvReadFindMany({
        where: { id: { in: ids } },
        select: { id: true, earlyAccessEndsAt: true },
      });
      if (!fromWrite && versions.length < ids.length) {
        const found = new Set(versions.map((v) => v.id));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length > 0) {
          fallbackInc();
          const fromPrimary = await mvWriteFindMany({
            where: { id: { in: missing } },
            select: { id: true, earlyAccessEndsAt: true },
          });
          versions = versions.concat(fromPrimary);
        }
      }
      if (versions.length === 0) return {};

      const earlyAccessById = new Map(versions.map((v) => [v.id, v.earlyAccessEndsAt]));
      const goals: GoalRow[] = await dgFindMany({
        where: { modelVersionId: { in: versions.map((v) => v.id) }, active: true },
      });

      const totalByGoalId = new Map<number, number>();
      const goalIds = goals.map((g) => g.id);
      if (goalIds.length > 0) {
        const totals: { donationGoalId: number; total: number }[] = await donationTotals(goalIds);
        for (const t of totals) totalByGoalId.set(t.donationGoalId, t.total);
      }

      const result: Record<number, Item> = {};
      for (const v of versions) result[v.id] = { modelVersionId: v.id, goals: [] };
      for (const goal of goals) {
        const { modelVersionId, ...rest } = goal;
        if (modelVersionId == null) continue;
        if (goal.isEarlyAccess && !earlyAccessById.get(modelVersionId)) continue;
        result[modelVersionId].goals.push({ ...rest, total: totalByGoalId.get(goal.id) ?? 0 });
      }
      return result;
    },
  });
}

const row = (over: Partial<GoalRow> = {}): GoalRow => ({
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
  mvReadFindMany.mockReset();
  mvWriteFindMany.mockReset();
  dgFindMany.mockReset();
  donationTotals.mockReset();
  fallbackInc.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('modelVersionPublicDonationGoalsCache', () => {
  it('hits the DB once, then serves the second fetch of the same version from cache', async () => {
    mvReadFindMany.mockResolvedValue([{ id: 5, earlyAccessEndsAt: null }]);
    dgFindMany.mockResolvedValue([row()]);
    donationTotals.mockResolvedValue([{ donationGoalId: 10, total: 250 }]);
    const cache = buildCache();

    const first = await cache.fetch([5]);
    const second = await cache.fetch([5]);

    expect(mvReadFindMany).toHaveBeenCalledTimes(1);
    expect(dgFindMany).toHaveBeenCalledTimes(1);
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
    mvReadFindMany.mockResolvedValue([{ id: 8, earlyAccessEndsAt: null }]);
    dgFindMany.mockResolvedValue([]);
    const cache = buildCache();

    const first = await cache.fetch([8]);
    const second = await cache.fetch([8]);

    expect(first[8]).toEqual({ modelVersionId: 8, goals: [] });
    // Positive (empty) entry is cached — no re-lookup on the second fetch.
    expect(mvReadFindMany).toHaveBeenCalledTimes(1);
    expect(second[8].goals).toEqual([]);
  });

  it('yields NO entry for a missing version and does not negatively cache it (cacheNotFound: false)', async () => {
    mvReadFindMany.mockResolvedValue([]); // replica miss
    mvWriteFindMany.mockResolvedValue([]); // primary miss too → genuinely gone
    const cache = buildCache();

    const first = await cache.fetch([999]);
    const second = await cache.fetch([999]);

    expect(first[999]).toBeUndefined(); // caller maps absent entry → NOT_FOUND
    // Not negatively cached → the lookup (incl. primary fallback) re-runs each time.
    expect(mvReadFindMany).toHaveBeenCalledTimes(2);
    expect(mvWriteFindMany).toHaveBeenCalledTimes(2);
    expect(fallbackInc).toHaveBeenCalledTimes(2);
    expect(second[999]).toBeUndefined();
  });

  it('applies the public early-access filter per version', async () => {
    // Version 5: no earlyAccessEndsAt → early-access goals are hidden.
    // Version 9: earlyAccessEndsAt set → early-access goals are shown.
    mvReadFindMany.mockResolvedValue([
      { id: 5, earlyAccessEndsAt: null },
      { id: 9, earlyAccessEndsAt: new Date('2099-01-01T00:00:00.000Z') },
    ]);
    dgFindMany.mockResolvedValue([
      row({ id: 10, isEarlyAccess: false, modelVersionId: 5 }),
      row({ id: 11, isEarlyAccess: true, modelVersionId: 5 }),
      row({ id: 20, isEarlyAccess: false, modelVersionId: 9 }),
      row({ id: 21, isEarlyAccess: true, modelVersionId: 9 }),
    ]);
    donationTotals.mockResolvedValue([]); // all totals default to 0
    const cache = buildCache();

    const res = await cache.fetch([5, 9]);

    expect(res[5].goals.map((g) => g.id)).toEqual([10]); // EA goal 11 excluded
    expect(res[9].goals.map((g) => g.id).sort((a, b) => a - b)).toEqual([20, 21]); // both shown
    expect(res[5].goals[0].total).toBe(0); // no donation → 0
  });
});
