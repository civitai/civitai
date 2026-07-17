import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CacheTTL } from '~/server/common/constants';
import { hashifyObject } from '~/utils/string-helpers';

// Faithful in-test mirror of the real `queryCache` read-through (cache-helpers.ts):
// a MISS runs `db.$queryRaw(query)` and stores the result keyed by the query hash; a
// HIT returns the stored value WITHOUT touching the DB. This lets us assert both the
// "cache hit skips DB" contract and the bounded-key routing purely from DB call counts.
const {
  dbReadQueryRaw,
  dbWriteExecuteRaw,
  dbWriteQueryRaw,
  bustCacheTag,
  cacheableStore,
  cacheableOptions,
  modelVotableTagsBust,
  imageTagsBust,
  upsertTagsOnImageNew,
  getSystemTags,
  getReplacedTagIds,
  getCategoryTags,
  redisDel,
} = vi.hoisted(() => ({
  dbReadQueryRaw: vi.fn(),
  dbWriteExecuteRaw: vi.fn().mockResolvedValue(undefined),
  dbWriteQueryRaw: vi.fn().mockResolvedValue([]),
  bustCacheTag: vi.fn().mockResolvedValue(undefined),
  cacheableStore: new Map<string, unknown>(),
  cacheableOptions: [] as unknown[],
  modelVotableTagsBust: vi.fn().mockResolvedValue(undefined),
  imageTagsBust: vi.fn().mockResolvedValue(undefined),
  upsertTagsOnImageNew: vi.fn().mockResolvedValue(undefined),
  getSystemTags: vi.fn().mockResolvedValue([]),
  getReplacedTagIds: vi.fn().mockResolvedValue([]),
  getCategoryTags: vi.fn().mockResolvedValue([]),
  redisDel: vi.fn().mockResolvedValue(1),
}));

vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustCacheTag,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryCache: (db: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (query: any, options: any) => {
      cacheableOptions.push(options);
      const key = hashifyObject(query).toString();
      if (cacheableStore.has(key)) return cacheableStore.get(key);
      const result = await db.$queryRaw(query);
      cacheableStore.set(key, result);
      return result;
    },
}));

vi.mock('~/server/services/system-cache', () => ({
  getSystemTags,
  getReplacedTagIds,
  getCategoryTags,
}));

vi.mock('~/server/redis/caches', () => ({
  imageTagsCache: { fetch: vi.fn(), bust: imageTagsBust },
  modelVotableTagsCache: { fetch: vi.fn(), bust: modelVotableTagsBust },
  tagCache: { fetch: vi.fn(), bust: vi.fn() },
}));

vi.mock('~/server/redis/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/redis/client')>();
  return {
    ...actual,
    // Keep the real REDIS_KEYS; stub only the client so mutations never hit a connection.
    redis: { del: redisDel, packed: { get: vi.fn(), set: vi.fn() } },
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: dbReadQueryRaw },
  dbWrite: { $executeRaw: dbWriteExecuteRaw, $queryRaw: dbWriteQueryRaw },
}));

vi.mock('~/server/services/tagsOnImageNew.service', () => ({
  upsertTagsOnImageNew,
}));

vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenImages: { refreshCache: vi.fn() },
  HiddenModels: { refreshCache: vi.fn() },
  ImplicitHiddenImages: { refreshCache: vi.fn() },
}));

import { addTags, deleteTags, disableTags, getTags } from '~/server/services/tag.service';

const ROWS = [
  { id: 1, name: 'anime' },
  { id: 2, name: 'nude' },
];

beforeEach(() => {
  vi.clearAllMocks();
  cacheableStore.clear();
  cacheableOptions.length = 0;
  dbReadQueryRaw.mockResolvedValue(ROWS);
  dbWriteQueryRaw.mockResolvedValue([]);
});

describe('getTags — listing cache (bounded key space)', () => {
  it('a no-query listing is served from cache on the second identical call (DB hit once)', async () => {
    const first = await getTags({});
    const second = await getTags({});

    // The static hierarchy read hit the DB exactly once across two identical calls.
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    // Cached output is byte-identical to the origin read.
    expect(second).toEqual(first);
  });

  it('reads through the cache with the 1h TTL and the getTags bust tag', async () => {
    await getTags({});
    expect(cacheableOptions).toHaveLength(1);
    expect(cacheableOptions[0]).toEqual({ ttl: CacheTTL.hour, tag: 'getTags' });
  });

  it('output shape matches the raw rows (models/isCategory/nsfwLevel stripped when absent)', async () => {
    const { items } = await getTags({});
    expect(items).toEqual([
      { id: 1, name: 'anime' },
      { id: 2, name: 'nude' },
    ]);
  });

  it('BYPASSES the cache for a free-text query (unbounded key space) — DB hit every call', async () => {
    await getTags({ query: 'anim' });
    await getTags({ query: 'anim' });
    // No memoization: each identical query call re-hits the DB directly.
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(2);
    // The cache read-through was never invoked for a query call.
    expect(cacheableOptions).toHaveLength(0);
  });

  it('BYPASSES the cache when a modelId filter is present', async () => {
    await getTags({ modelId: 5 });
    await getTags({ modelId: 5 });
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(2);
    expect(cacheableOptions).toHaveLength(0);
  });

  it('BYPASSES the cache when excludedTagIds is present', async () => {
    await getTags({ excludedTagIds: [7, 8] });
    await getTags({ excludedTagIds: [7, 8] });
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(2);
    expect(cacheableOptions).toHaveLength(0);
  });

  it('the cached (no-query) path produces the same items as the equivalent uncached read', async () => {
    const cached = await getTags({});
    // A query-param call takes the bypass branch but reads the same underlying rows.
    const uncached = await getTags({ query: 'anime' });
    expect(cached.items).toEqual(uncached.items);
  });
});

describe('getTags — cache invalidation contract', () => {
  it('addTags(entityType:tag) busts the getTags listing cache (TagsOnTags INSERT)', async () => {
    await addTags({ tags: [1], entityIds: [2], entityType: 'tag', relationship: 'Parent' });
    expect(bustCacheTag).toHaveBeenCalledWith('getTags');
  });

  it('disableTags(entityType:tag) busts the getTags listing cache (TagsOnTags DELETE)', async () => {
    await disableTags({ tags: [1], entityIds: [2], entityType: 'tag' });
    expect(bustCacheTag).toHaveBeenCalledWith('getTags');
  });

  it('deleteTags busts the getTags listing cache (Tag entity DELETE)', async () => {
    dbWriteQueryRaw
      .mockResolvedValueOnce([]) // affected images
      .mockResolvedValueOnce([]) // affected models
      .mockResolvedValueOnce([]); // affected tag names
    await deleteTags({ tags: [1] });
    expect(bustCacheTag).toHaveBeenCalledWith('getTags');
  });

  it('addTags(entityType:model) does NOT bust the getTags listing cache (TagsOnModels only)', async () => {
    await addTags({ tags: [1], entityIds: [2], entityType: 'model' });
    expect(modelVotableTagsBust).toHaveBeenCalledWith([2]);
    expect(bustCacheTag).not.toHaveBeenCalledWith('getTags');
  });

  it('disableTags(entityType:image) does NOT bust the getTags listing cache (TagsOnImages only)', async () => {
    dbWriteQueryRaw.mockResolvedValue([]); // TagsOnImageDetails select
    await disableTags({ tags: [1], entityIds: [2], entityType: 'image' });
    expect(bustCacheTag).not.toHaveBeenCalledWith('getTags');
  });
});
