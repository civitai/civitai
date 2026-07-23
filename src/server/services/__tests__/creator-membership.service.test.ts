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
  mockDbRead: { customerSubscription: { findMany: vi.fn() } },
  mockRedis: {
    packed: { mGet: vi.fn(), set: vi.fn() },
    del: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  REDIS_KEYS: { CACHES: { CREATOR_MEMBERSHIP_VALID: 'packed:caches:creator-membership-valid' } },
}));

import {
  bustCreatorMembershipValidCache,
  getValidCreatorMembershipMap,
  hasValidCreatorMembershipCached,
} from '~/server/services/creator-membership.service';

const keyFor = (id: number) => `packed:caches:creator-membership-valid:${id}`;

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
