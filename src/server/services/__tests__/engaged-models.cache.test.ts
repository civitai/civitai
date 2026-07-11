import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier B per-user Redis cache behind `user.getEngagedModels` /
 * `user.getEngagedModelsByIds` (the latter is ~1-in-7 of all API requests, previously
 * uncached). These tests pin the three properties the perf lever depends on being SAFE:
 *
 *   1. cache miss → builds from the DB AND writes the value back (populate);
 *   2. cache hit → serves from Redis and does NOT re-query the DB (the CPU win);
 *   3. a bust → a stale value does NOT survive (the correctness path); plus
 *   4. `filterEngagedModelsByIds` reproduces the byte-for-byte shape of the prior
 *      DB-direct `getUserEngagedModelsByIds` (transparent cache, no wire change).
 *
 * `~/server/db/client` and `~/server/redis/client` are mocked at the boundary with an
 * in-memory Redis (a Map) and mutable fixture tables, so the real module code runs.
 */

const { store, mockRedis, mockDb, engagementRows, reviewRows } = vi.hoisted(() => {
  type EngRow = { userId: number; modelId: number; type: string };
  type RevRow = { userId: number; modelId: number; recommended: boolean };

  const store = new Map<string, string>();
  const engagementRows: EngRow[] = [];
  const reviewRows: RevRow[] = [];

  return {
    store,
    engagementRows,
    reviewRows,
    mockRedis: {
      redis: {
        get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
        set: vi.fn(async (key: string, value: string) => {
          store.set(key, value);
        }),
        del: vi.fn(async (key: string) => {
          store.delete(key);
        }),
      },
      // Key parts — the exact literals are irrelevant to the test; consistency across
      // get/set/del is what matters (the module derives one key from these).
      REDIS_KEYS: { USER: { BASE: 'user' } },
      REDIS_SUB_KEYS: { USER: { MODEL_ENGAGEMENTS: 'model-engagements' } },
    },
    mockDb: {
      dbRead: {
        modelEngagement: {
          findMany: vi.fn(async ({ where }: any) =>
            engagementRows
              .filter((r) => r.userId === where.userId)
              .map((r) => ({ modelId: r.modelId, type: r.type }))
          ),
        },
        resourceReview: {
          findMany: vi.fn(async ({ where }: any) =>
            reviewRows
              .filter(
                (r) =>
                  r.userId === where.userId &&
                  (where.recommended === undefined || r.recommended === where.recommended)
              )
              .map((r) => ({ modelId: r.modelId }))
          ),
        },
      },
    },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb.dbRead, dbWrite: mockDb.dbRead }));
vi.mock('~/server/redis/client', () => mockRedis);

import {
  bustEngagedModelsCache,
  filterEngagedModelsByIds,
  getEngagedModelsCached,
  type EngagedModelType,
} from '~/server/services/engaged-models.cache';

const USER = 1;
const OTHER = 2;

function seed() {
  engagementRows.length = 0;
  reviewRows.length = 0;
  engagementRows.push(
    { userId: USER, modelId: 101, type: 'Favorite' },
    { userId: USER, modelId: 102, type: 'Hide' },
    { userId: USER, modelId: 102, type: 'Notify' },
    { userId: USER, modelId: 103, type: 'Favorite' },
    { userId: OTHER, modelId: 999, type: 'Favorite' } // isolation
  );
  reviewRows.push(
    { userId: USER, modelId: 101, recommended: true },
    { userId: USER, modelId: 104, recommended: true },
    { userId: USER, modelId: 105, recommended: false } // must never appear
  );
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  seed();
});

describe('getEngagedModelsCached — miss → build + populate', () => {
  it('builds the full per-user set from the DB and writes it to Redis', async () => {
    const res = await getEngagedModelsCached(USER);

    expect(res.Favorite).toEqual(expect.arrayContaining([101, 103]));
    expect(res.Hide).toEqual([102]);
    expect(res.Notify).toEqual([102]);
    expect(res.Recommended).toEqual(expect.arrayContaining([101, 104]));
    expect(res.Recommended).not.toContain(105); // recommended:false excluded

    // Populated Redis for next time.
    expect(mockRedis.redis.set).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
    // Built from the DB once each.
    expect(mockDb.dbRead.modelEngagement.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.dbRead.resourceReview.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not leak another user’s engagements', async () => {
    const res = await getEngagedModelsCached(USER);
    expect(Object.values(res).flat()).not.toContain(999);
  });
});

describe('getEngagedModelsCached — hit serves from Redis (the CPU win)', () => {
  it('a second read hits Redis and does NOT re-query the DB', async () => {
    const first = await getEngagedModelsCached(USER);
    vi.clearAllMocks();

    const second = await getEngagedModelsCached(USER);

    expect(second).toEqual(first); // identical result
    expect(mockRedis.redis.get).toHaveBeenCalledTimes(1);
    expect(mockDb.dbRead.modelEngagement.findMany).not.toHaveBeenCalled();
    expect(mockDb.dbRead.resourceReview.findMany).not.toHaveBeenCalled();
    expect(mockRedis.redis.set).not.toHaveBeenCalled();
  });
});

describe('bustEngagedModelsCache — stale value does not survive', () => {
  it('after a bust, the next read re-builds from the (now-changed) DB', async () => {
    // Warm the cache.
    const before = await getEngagedModelsCached(USER);
    expect(before.Favorite).toEqual(expect.arrayContaining([101, 103]));

    // Mutate the underlying data (simulate an engagement mutation) and bust.
    engagementRows.push({ userId: USER, modelId: 200, type: 'Favorite' });
    await bustEngagedModelsCache(USER);
    expect(store.size).toBe(0);

    const after = await getEngagedModelsCached(USER);
    expect(after.Favorite).toEqual(expect.arrayContaining([101, 103, 200]));
    // Proves it did NOT serve the stale pre-mutation value.
    expect(after.Favorite).toContain(200);
  });

  it('WITHOUT a bust, the stale value IS served (guards that the bust is load-bearing)', async () => {
    await getEngagedModelsCached(USER);
    engagementRows.push({ userId: USER, modelId: 200, type: 'Favorite' });

    const stale = await getEngagedModelsCached(USER);
    expect(stale.Favorite).not.toContain(200); // stale by design until busted
  });
});

describe('filterEngagedModelsByIds — transparent-cache shape parity', () => {
  const full: Record<EngagedModelType, number[]> = {
    Favorite: [101, 103],
    Hide: [102],
    Notify: [102],
    Mute: [104],
    Recommended: [101, 105],
  } as Record<EngagedModelType, number[]>;

  it('intersects each type with the requested ids', () => {
    const res = filterEngagedModelsByIds(full, [101, 102]);
    expect(res.Favorite).toEqual([101]);
    expect(res.Hide).toEqual([102]);
    expect(res.Notify).toEqual([102]);
    expect(res.Recommended).toEqual([101]);
  });

  it('omits a type key entirely when nothing intersects (matches the prior reduce shape)', () => {
    const res = filterEngagedModelsByIds(full, [101]);
    // 101 is Favorite + Recommended only → Hide/Notify/Mute keys must be ABSENT.
    expect(res.Favorite).toEqual([101]);
    expect(res.Recommended).toEqual([101]);
    expect(res).not.toHaveProperty('Hide');
    expect(res).not.toHaveProperty('Notify');
    expect(res).not.toHaveProperty('Mute');
  });

  it('always includes Recommended, even when empty', () => {
    const res = filterEngagedModelsByIds(full, [999]);
    expect(res.Recommended).toEqual([]);
    expect(Object.values(res).flat()).toEqual([]); // no engagement-type keys for an absent id
  });

  it('an id in the request but engaged under no type appears nowhere', () => {
    const res = filterEngagedModelsByIds(full, [102, 999]);
    const all = Object.values(res).flat();
    expect(all).toContain(102);
    expect(all).not.toContain(999);
  });

  it('end-to-end: filtering the cached full set equals the intersection of (engagements ∩ ids)', async () => {
    const cached = await getEngagedModelsCached(USER);
    const res = filterEngagedModelsByIds(cached, [101, 102, 104]);
    // 101 Favorite+Recommended, 102 Hide+Notify, 104 Recommended only.
    expect(res.Favorite).toEqual([101]);
    expect(res.Hide).toEqual([102]);
    expect(res.Notify).toEqual([102]);
    expect(res.Recommended).toEqual(expect.arrayContaining([101, 104]));
    expect(res.Recommended).toHaveLength(2);
    expect(res.Favorite).not.toContain(103); // engaged but not requested
  });
});
