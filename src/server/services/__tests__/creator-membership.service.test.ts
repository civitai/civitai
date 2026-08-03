import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheTTL } from '~/server/common/constants';

/**
 * `getValidCreatorMembershipMap` is the read-time gate every metric-privacy surface
 * (model feed / v1 API / search index) and the donation-goal hide check trusts: a
 * user is a valid Creator Program member only while they hold a paid, non-founder
 * tier. A regression here either leaks a lapsed creator's hidden metrics (false→true)
 * or wrongly hides an active member's stats (true→false).
 *
 * It is now a read-through Redis cache over the near-static per-user validity boolean:
 * cached ids are served from Redis (no DB), only misses hit `customerSubscription`
 * + the per-sub Zod parse, and the result is byte-identical to the uncached path.
 */

const { mockDbRead, mockRedis } = vi.hoisted(() => ({
  mockDbRead: {
    customerSubscription: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  mockRedis: {
    packed: { mGet: vi.fn(), set: vi.fn() },
    del: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  REDIS_KEYS: {
    CACHES: {
      CREATOR_MEMBERSHIP_VALID: 'packed:caches:creator-membership-valid',
      USER_METRIC_PRIVACY_DEFAULTS: 'packed:caches:user-metric-privacy-defaults',
    },
  },
}));

// Stubbed by the global setup (src/__tests__/setup.ts) — `.inc` is a vi.fn(), so these
// are the assertion handles for the cache hit/miss instrumentation.
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';
import {
  bustCreatorMembershipValidCache,
  bustUserMetricPrivacyDefaultsCache,
  getUserMetricPrivacyDefaultsMap,
  getValidCreatorMembershipMap,
  hasValidCreatorMembershipCached,
} from '~/server/services/creator-membership.service';

const keyFor = (id: number) => `packed:caches:creator-membership-valid:${id}`;
const defaultsKeyFor = (id: number) => `packed:caches:user-metric-privacy-defaults:${id}`;
const ALL_FALSE = { hideModelBuzz: false, hideModelDownloads: false, hideModelGenerations: false };

// LITERAL expected TTLs, in seconds. Deliberately NOT `CacheTTL.*` — the point of these
// pins is to fail if the two caches are ever re-merged onto one constant, and a
// `CacheTTL`-derived expectation would silently follow such a change.
const MEMBERSHIP_TTL_SECONDS = 600; // 10 minutes — membership validity, unchanged
const METRIC_PRIVACY_TTL_SECONDS = 3600; // 1 hour — metric-privacy defaults
const PRIVACY_CACHE_LABELS = {
  cache_name: 'user-metric-privacy-defaults',
  cache_type: 'redisPacked',
};

type SubRow = {
  userId: number;
  metadata?: Record<string, unknown> | null;
  product: { metadata: Record<string, unknown> };
};

const sub = (userId: number, tier: string, over: Partial<SubRow> = {}): SubRow => ({
  userId,
  metadata: null,
  product: { metadata: { tier } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every key is a cache MISS, so tests exercising the origin query fall
  // through to the DB. Cache-hit tests override this per case.
  mockRedis.packed.mGet.mockImplementation((keys: string[]) =>
    Promise.resolve(keys.map(() => null))
  );
  mockRedis.packed.set.mockResolvedValue(undefined);
  mockRedis.del.mockResolvedValue(undefined);
});

describe('getValidCreatorMembershipMap — origin computation (cache miss)', () => {
  it('returns an empty map (and touches neither redis nor the db) for empty input', async () => {
    const result = await getValidCreatorMembershipMap([]);
    expect(result.size).toBe(0);
    expect(mockRedis.packed.mGet).not.toHaveBeenCalled();
    expect(mockDbRead.customerSubscription.findMany).not.toHaveBeenCalled();
  });

  it('treats a founder-tier sub as an invalid membership', async () => {
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'founder')]);
    const result = await getValidCreatorMembershipMap([1]);
    expect(result.get(1)).toBe(false);
  });

  it('skips a sub flagged with metadata.renewalEmailSent', async () => {
    mockDbRead.customerSubscription.findMany.mockResolvedValue([
      sub(1, 'gold', { metadata: { renewalEmailSent: true } }),
    ]);
    const result = await getValidCreatorMembershipMap([1]);
    // The only sub is skipped, so the user has no effective tier -> invalid.
    expect(result.get(1)).toBe(false);
  });

  it('selects the highest tier among multiple subs', async () => {
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'free'), sub(1, 'silver')]);
    const result = await getValidCreatorMembershipMap([1]);
    // Picks silver over free -> valid (a free-only pick would be invalid).
    expect(result.get(1)).toBe(true);
  });

  it('dedupes ids and returns a definite boolean for a user with no subscription', async () => {
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'gold')]);
    const result = await getValidCreatorMembershipMap([1, 1, 2]);
    expect(result.get(1)).toBe(true);
    expect(result.get(2)).toBe(false); // total function: no sub -> false, not undefined
    // deduped: the origin query is asked for the two distinct ids only
    const whereIn = mockDbRead.customerSubscription.findMany.mock.calls[0][0].where.userId.in;
    expect([...whereIn].sort()).toEqual([1, 2]);
  });
});

describe('getValidCreatorMembershipMap — read-through cache', () => {
  it('serves a cached TRUE from redis without querying the db', async () => {
    mockRedis.packed.mGet.mockResolvedValue([true]);
    const result = await getValidCreatorMembershipMap([1]);
    expect(result.get(1)).toBe(true);
    expect(mockDbRead.customerSubscription.findMany).not.toHaveBeenCalled();
    expect(mockRedis.packed.set).not.toHaveBeenCalled();
  });

  it('serves a cached FALSE from redis (negatives are cached, not re-queried)', async () => {
    mockRedis.packed.mGet.mockResolvedValue([false]);
    const result = await getValidCreatorMembershipMap([1]);
    expect(result.get(1)).toBe(false);
    expect(mockDbRead.customerSubscription.findMany).not.toHaveBeenCalled();
  });

  it('batch miss-fill: queries ONLY the missing ids and backfills them', async () => {
    // id 1 cached true, ids 2 & 3 miss.
    mockRedis.packed.mGet.mockResolvedValue([true, null, null]);
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(2, 'gold')]); // 3 has no sub
    const result = await getValidCreatorMembershipMap([1, 2, 3]);

    expect(result.get(1)).toBe(true); // from cache
    expect(result.get(2)).toBe(true); // from db
    expect(result.get(3)).toBe(false); // db miss -> false

    // The DB was asked for the misses only, never the cache hit.
    const whereIn = mockDbRead.customerSubscription.findMany.mock.calls[0][0].where.userId.in;
    expect([...whereIn].sort()).toEqual([2, 3]);

    // Both misses were backfilled with the resolved boolean + the TTL; the hit was not.
    expect(mockRedis.packed.set).toHaveBeenCalledTimes(2);
    expect(mockRedis.packed.set).toHaveBeenCalledWith(keyFor(2), true, { EX: CacheTTL.md });
    expect(mockRedis.packed.set).toHaveBeenCalledWith(keyFor(3), false, { EX: CacheTTL.md });
    expect(mockRedis.packed.set).not.toHaveBeenCalledWith(
      keyFor(1),
      expect.anything(),
      expect.anything()
    );
  });

  it('fails open to the db when the cache read throws (redis down never 500s)', async () => {
    mockRedis.packed.mGet.mockRejectedValue(new Error('redis down'));
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'silver')]);
    const result = await getValidCreatorMembershipMap([1]);
    expect(result.get(1)).toBe(true); // correct result despite the cache error
    expect(mockDbRead.customerSubscription.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not fail the request when the backfill write throws', async () => {
    mockRedis.packed.mGet.mockResolvedValue([null]);
    mockRedis.packed.set.mockRejectedValue(new Error('redis write down'));
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'gold')]);
    const result = await getValidCreatorMembershipMap([1]);
    expect(result.get(1)).toBe(true);
  });

  it('cache-served result is byte-identical to the uncached db result for a mixed batch', async () => {
    const rows = [sub(1, 'gold'), sub(2, 'founder'), sub(3, 'free'), sub(4, 'bronze')];

    // Uncached pass (all miss -> db).
    mockRedis.packed.mGet.mockResolvedValueOnce([null, null, null, null]);
    mockDbRead.customerSubscription.findMany.mockResolvedValue(rows);
    const uncached = await getValidCreatorMembershipMap([1, 2, 3, 4]);

    // Fully-cached pass (redis returns exactly what the first pass backfilled).
    mockDbRead.customerSubscription.findMany.mockClear();
    mockRedis.packed.mGet.mockResolvedValueOnce([
      uncached.get(1)!,
      uncached.get(2)!,
      uncached.get(3)!,
      uncached.get(4)!,
    ]);
    const cached = await getValidCreatorMembershipMap([1, 2, 3, 4]);

    expect([...cached.entries()].sort()).toEqual([...uncached.entries()].sort());
    expect(cached.get(1)).toBe(true); // gold -> valid
    expect(cached.get(2)).toBe(false); // founder -> invalid
    expect(cached.get(3)).toBe(false); // free -> invalid
    expect(cached.get(4)).toBe(true); // bronze -> valid
    expect(mockDbRead.customerSubscription.findMany).not.toHaveBeenCalled(); // fully served from cache
  });
});

describe('hasValidCreatorMembershipCached — single-user cache-backed check', () => {
  it('returns false for a falsy userId without touching redis or the db', async () => {
    expect(await hasValidCreatorMembershipCached(0)).toBe(false);
    expect(mockRedis.packed.mGet).not.toHaveBeenCalled();
    expect(mockDbRead.customerSubscription.findMany).not.toHaveBeenCalled();
  });

  it('serves a cache hit without the db', async () => {
    mockRedis.packed.mGet.mockResolvedValue([true]);
    expect(await hasValidCreatorMembershipCached(7)).toBe(true);
    expect(mockDbRead.customerSubscription.findMany).not.toHaveBeenCalled();
  });

  it('falls through to the db on a miss and returns the same boolean the map computes', async () => {
    mockRedis.packed.mGet.mockResolvedValue([null]);
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(7, 'gold')]);
    expect(await hasValidCreatorMembershipCached(7)).toBe(true);
  });
});

describe('bustCreatorMembershipValidCache', () => {
  it('deletes the key for a single user', async () => {
    await bustCreatorMembershipValidCache(5);
    expect(mockRedis.del).toHaveBeenCalledWith(keyFor(5));
  });

  it('deletes every key for an array of users', async () => {
    await bustCreatorMembershipValidCache([5, 6]);
    expect(mockRedis.del).toHaveBeenCalledWith(keyFor(5));
    expect(mockRedis.del).toHaveBeenCalledWith(keyFor(6));
  });

  it('is a no-op for empty / falsy ids', async () => {
    await bustCreatorMembershipValidCache([]);
    await bustCreatorMembershipValidCache(0);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('swallows a redis error (best-effort bust never throws)', async () => {
    mockRedis.del.mockRejectedValue(new Error('redis down'));
    await expect(bustCreatorMembershipValidCache(5)).resolves.toBeUndefined();
  });
});

/**
 * `getUserMetricPrivacyDefaultsMap` replaces the per-request full-`settings` findMany
 * the read-time paths (feed / v1 list / associated) ran over every owner just to read
 * three booleans — the measured api-primary longtask. It must return the SAME three
 * `hideModel*` booleans as reading them straight off `settings` (byte-identical), and
 * it must never over-hide: an unset flag is `false`.
 */
describe('getUserMetricPrivacyDefaultsMap — derived read-through cache', () => {
  it('returns an empty map (touching neither redis nor db) for empty input', async () => {
    const result = await getUserMetricPrivacyDefaultsMap([]);
    expect(result.size).toBe(0);
    expect(mockRedis.packed.mGet).not.toHaveBeenCalled();
    expect(mockDbRead.user.findMany).not.toHaveBeenCalled();
  });

  it('derives only the three hideModel* flags off settings (ignores unrelated keys)', async () => {
    mockDbRead.user.findMany.mockResolvedValue([
      {
        id: 1,
        settings: {
          hideModelBuzz: true,
          hideModelDownloads: false,
          hideModelGenerations: true,
          // Unrelated settings that must NOT bloat the cached value:
          dismissedAlerts: ['a', 'b', 'c'],
          hideDonationGoals: true,
          tourState: { seen: true },
        },
      },
    ]);
    const result = await getUserMetricPrivacyDefaultsMap([1]);
    expect(result.get(1)).toEqual({
      hideModelBuzz: true,
      hideModelDownloads: false,
      hideModelGenerations: true,
    });
    // Backfilled with exactly the tiny triple + this cache's own TTL (see the
    // "cache TTLs are decoupled per cache" block for the decoupling guard).
    expect(mockRedis.packed.set).toHaveBeenCalledWith(
      defaultsKeyFor(1),
      { hideModelBuzz: true, hideModelDownloads: false, hideModelGenerations: true },
      { EX: METRIC_PRIVACY_TTL_SECONDS }
    );
  });

  it('returns all-false for a user with no settings / no flags (never over-hides)', async () => {
    mockDbRead.user.findMany.mockResolvedValue([
      { id: 1, settings: null },
      { id: 2, settings: {} },
    ]);
    const result = await getUserMetricPrivacyDefaultsMap([1, 2, 3]); // 3 absent from db
    expect(result.get(1)).toEqual(ALL_FALSE);
    expect(result.get(2)).toEqual(ALL_FALSE);
    expect(result.get(3)).toEqual(ALL_FALSE); // total function: absent -> all false
  });

  it('serves a cached triple from redis without querying the db', async () => {
    mockRedis.packed.mGet.mockResolvedValue([
      { hideModelBuzz: true, hideModelDownloads: false, hideModelGenerations: false },
    ]);
    const result = await getUserMetricPrivacyDefaultsMap([1]);
    expect(result.get(1)).toEqual({
      hideModelBuzz: true,
      hideModelDownloads: false,
      hideModelGenerations: false,
    });
    expect(mockDbRead.user.findMany).not.toHaveBeenCalled();
    expect(mockRedis.packed.set).not.toHaveBeenCalled();
  });

  it('batch miss-fill: queries ONLY the missing ids and backfills them', async () => {
    mockRedis.packed.mGet.mockResolvedValue([
      { hideModelBuzz: true, hideModelDownloads: false, hideModelGenerations: false }, // id 1 cached
      null, // id 2 miss
      null, // id 3 miss
    ]);
    mockDbRead.user.findMany.mockResolvedValue([
      { id: 2, settings: { hideModelDownloads: true } },
      // id 3 has no row -> all false
    ]);
    const result = await getUserMetricPrivacyDefaultsMap([1, 2, 3]);
    expect(result.get(1)?.hideModelBuzz).toBe(true);
    expect(result.get(2)).toEqual({
      hideModelBuzz: false,
      hideModelDownloads: true,
      hideModelGenerations: false,
    });
    expect(result.get(3)).toEqual(ALL_FALSE);

    const whereIn = mockDbRead.user.findMany.mock.calls[0][0].where.id.in;
    expect([...whereIn].sort()).toEqual([2, 3]);
    // Only the two misses were backfilled.
    expect(mockRedis.packed.set).toHaveBeenCalledTimes(2);
    expect(mockRedis.packed.set).not.toHaveBeenCalledWith(
      defaultsKeyFor(1),
      expect.anything(),
      expect.anything()
    );
  });

  it('fails open to the db when the cache read throws (redis down never 500s)', async () => {
    mockRedis.packed.mGet.mockRejectedValue(new Error('redis down'));
    mockDbRead.user.findMany.mockResolvedValue([{ id: 1, settings: { hideModelBuzz: true } }]);
    const result = await getUserMetricPrivacyDefaultsMap([1]);
    expect(result.get(1)?.hideModelBuzz).toBe(true);
    expect(mockDbRead.user.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not fail the request when the backfill write throws', async () => {
    mockRedis.packed.mGet.mockResolvedValue([null]);
    mockRedis.packed.set.mockRejectedValue(new Error('redis write down'));
    mockDbRead.user.findMany.mockResolvedValue([{ id: 1, settings: { hideModelGenerations: true } }]);
    const result = await getUserMetricPrivacyDefaultsMap([1]);
    expect(result.get(1)?.hideModelGenerations).toBe(true);
  });

  it('cache-served result is byte-identical to the uncached db result for a mixed batch', async () => {
    const rows = [
      { id: 1, settings: { hideModelBuzz: true } },
      { id: 2, settings: {} },
      { id: 3, settings: { hideModelDownloads: true, hideModelGenerations: true } },
    ];
    mockRedis.packed.mGet.mockResolvedValueOnce([null, null, null]);
    mockDbRead.user.findMany.mockResolvedValue(rows);
    const uncached = await getUserMetricPrivacyDefaultsMap([1, 2, 3]);

    mockDbRead.user.findMany.mockClear();
    mockRedis.packed.mGet.mockResolvedValueOnce([
      uncached.get(1)!,
      uncached.get(2)!,
      uncached.get(3)!,
    ]);
    const cached = await getUserMetricPrivacyDefaultsMap([1, 2, 3]);

    expect([...cached.entries()].sort()).toEqual([...uncached.entries()].sort());
    expect(cached.get(3)).toEqual({
      hideModelBuzz: false,
      hideModelDownloads: true,
      hideModelGenerations: true,
    });
    expect(mockDbRead.user.findMany).not.toHaveBeenCalled(); // fully served from cache
  });

  it('dedupes ids before the db query', async () => {
    mockDbRead.user.findMany.mockResolvedValue([{ id: 1, settings: {} }]);
    await getUserMetricPrivacyDefaultsMap([1, 1, 1]);
    const whereIn = mockDbRead.user.findMany.mock.calls[0][0].where.id.in;
    expect([...whereIn]).toEqual([1]);
  });
});

describe('bustUserMetricPrivacyDefaultsCache', () => {
  it('deletes the defaults key for a single user and an array of users', async () => {
    await bustUserMetricPrivacyDefaultsCache(5);
    expect(mockRedis.del).toHaveBeenCalledWith(defaultsKeyFor(5));
    await bustUserMetricPrivacyDefaultsCache([6, 7]);
    expect(mockRedis.del).toHaveBeenCalledWith(defaultsKeyFor(6));
    expect(mockRedis.del).toHaveBeenCalledWith(defaultsKeyFor(7));
  });

  it('is a no-op for empty / falsy ids and swallows a redis error', async () => {
    await bustUserMetricPrivacyDefaultsCache([]);
    await bustUserMetricPrivacyDefaultsCache(0);
    expect(mockRedis.del).not.toHaveBeenCalled();
    mockRedis.del.mockRejectedValue(new Error('redis down'));
    await expect(bustUserMetricPrivacyDefaultsCache(5)).resolves.toBeUndefined();
  });
});

/**
 * The two caches in this module used to share ONE `MEMBERSHIP_CACHE_TTL`, so raising the
 * TTL of either silently raised the other — bumping the metric-privacy TTL would have
 * extended membership staleness with nothing to catch it.
 *
 * These pins are the regression guard for exactly that. They assert LITERAL second
 * values, not `CacheTTL.*`, so re-merging the constants (or repointing one at the
 * other's value) fails here instead of shipping. They are also the reason the two
 * expectations live in one describe: the guard is the RELATIONSHIP between them, not
 * either number alone.
 */
describe('cache TTLs are decoupled per cache', () => {
  it('writes the metric-privacy defaults with its own 1h TTL', async () => {
    mockRedis.packed.mGet.mockResolvedValue([null]);
    mockDbRead.user.findMany.mockResolvedValue([{ id: 1, settings: { hideModelBuzz: true } }]);

    await getUserMetricPrivacyDefaultsMap([1]);

    expect(mockRedis.packed.set).toHaveBeenCalledWith(defaultsKeyFor(1), expect.anything(), {
      EX: METRIC_PRIVACY_TTL_SECONDS,
    });
  });

  // INVARIANT GUARD, not regression coverage: this is green on pre-change code too,
  // because the membership TTL is exactly what this PR did NOT change. Its job is to go
  // red if a future edit raises `MEMBERSHIP_CACHE_TTL` in place — verified by mutation:
  // setting it to `CacheTTL.hour` fails this test.
  it('leaves the membership-validity cache on its unchanged 10m TTL', async () => {
    mockRedis.packed.mGet.mockResolvedValue([null]);
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'gold')]);

    await getValidCreatorMembershipMap([1]);

    expect(mockRedis.packed.set).toHaveBeenCalledWith(keyFor(1), true, {
      EX: MEMBERSHIP_TTL_SECONDS,
    });
  });

  it('uses two DIFFERENT TTLs for the two caches in one run', async () => {
    // Membership first, then privacy defaults — both miss, both backfill.
    mockDbRead.customerSubscription.findMany.mockResolvedValue([sub(1, 'gold')]);
    mockDbRead.user.findMany.mockResolvedValue([{ id: 1, settings: {} }]);
    await getValidCreatorMembershipMap([1]);
    await getUserMetricPrivacyDefaultsMap([1]);

    const ttlByKey = Object.fromEntries(
      mockRedis.packed.set.mock.calls.map((c: unknown[]) => [
        c[0] as string,
        (c[2] as { EX: number }).EX,
      ])
    );
    expect(ttlByKey[keyFor(1)]).toBe(MEMBERSHIP_TTL_SECONDS);
    expect(ttlByKey[defaultsKeyFor(1)]).toBe(METRIC_PRIVACY_TTL_SECONDS);
    // The whole point: they are not the same number.
    expect(ttlByKey[keyFor(1)]).not.toBe(ttlByKey[defaultsKeyFor(1)]);
  });
});

/**
 * Hit/miss instrumentation for the metric-privacy defaults cache. Counted per USER ID,
 * not per call, so the exported ratio is a true per-entry hit rate over a batched
 * lookup. Without this the TTL change is unverifiable in production — the hit rate is
 * the only signal that says whether raising it actually removed re-fetches.
 */
describe('getUserMetricPrivacyDefaultsMap — hit/miss instrumentation', () => {
  it('counts a full cache hit and never touches the miss counter', async () => {
    mockRedis.packed.mGet.mockResolvedValue([
      { hideModelBuzz: true, hideModelDownloads: false, hideModelGenerations: false },
    ]);

    await getUserMetricPrivacyDefaultsMap([1]);

    expect(cacheHitCounter.inc).toHaveBeenCalledWith(PRIVACY_CACHE_LABELS, 1);
    expect(cacheMissCounter.inc).not.toHaveBeenCalled();
  });

  it('counts a full cache miss and never touches the hit counter', async () => {
    mockRedis.packed.mGet.mockResolvedValue([null]);
    mockDbRead.user.findMany.mockResolvedValue([{ id: 1, settings: {} }]);

    await getUserMetricPrivacyDefaultsMap([1]);

    expect(cacheMissCounter.inc).toHaveBeenCalledWith(PRIVACY_CACHE_LABELS, 1);
    expect(cacheHitCounter.inc).not.toHaveBeenCalled();
  });

  it('counts per id, not per call, on a mixed batch (2 hits / 3 misses)', async () => {
    // Distinct hit and miss counts, so a transposed or per-call implementation
    // cannot produce this pair by accident.
    mockRedis.packed.mGet.mockResolvedValue([
      { hideModelBuzz: true, hideModelDownloads: false, hideModelGenerations: false },
      null,
      { hideModelBuzz: false, hideModelDownloads: true, hideModelGenerations: false },
      null,
      null,
    ]);
    mockDbRead.user.findMany.mockResolvedValue([{ id: 2, settings: {} }]);

    await getUserMetricPrivacyDefaultsMap([1, 2, 3, 4, 5]);

    expect(cacheHitCounter.inc).toHaveBeenCalledWith(PRIVACY_CACHE_LABELS, 2);
    expect(cacheMissCounter.inc).toHaveBeenCalledWith(PRIVACY_CACHE_LABELS, 3);
    expect(cacheHitCounter.inc).toHaveBeenCalledTimes(1);
    expect(cacheMissCounter.inc).toHaveBeenCalledTimes(1);
  });

  it('counts a redis read failure as all-miss (the ids really do go to the db)', async () => {
    mockRedis.packed.mGet.mockRejectedValue(new Error('redis down'));
    mockDbRead.user.findMany.mockResolvedValue([{ id: 1, settings: {} }]);

    await getUserMetricPrivacyDefaultsMap([1, 2]);

    expect(cacheMissCounter.inc).toHaveBeenCalledWith(PRIVACY_CACHE_LABELS, 2);
    expect(cacheHitCounter.inc).not.toHaveBeenCalled();
  });

  // INVARIANT GUARD, not regression coverage: trivially green pre-change (nothing was
  // counted at all). It pins that the early-return for an empty batch stays ahead of the
  // counting, so a caller passing no ids can never inflate the hit rate with a 0-hit,
  // 0-miss sample.
  it('records nothing at all for an empty input', async () => {
    await getUserMetricPrivacyDefaultsMap([]);
    expect(cacheHitCounter.inc).not.toHaveBeenCalled();
    expect(cacheMissCounter.inc).not.toHaveBeenCalled();
  });
});
