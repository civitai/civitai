import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dedup contract for the model votable-tags cache (the DB-load-reduction lever behind
 * `tag.getVotableTags` on the model path).
 *
 * modelVotableTagsCache is a createCachedObject keyed by modelId. This test exercises the
 * REAL cache mechanism against an in-memory packed-redis double + a mocked db, and pins
 * the property the lever depends on: the static ModelTag-view read is cached, so a second
 * fetch of the same modelId within the TTL does NOT re-issue the DB lookup. The lookupFn
 * here is a byte-copy of modelVotableTagsCache's (caches.ts) — importing the real cache
 * singleton would drag in caches.ts's whole env/clickhouse/orchestrator graph, so we assert
 * the same reduce/keying logic against the same createCachedObject helper.
 */

// In-memory packed store so a cached value survives to the next fetch (real dedup).
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

type ModelTagComposite = {
  tagId: number;
  tagName: string;
  tagType: string;
  score: number;
  upVotes: number;
  downVotes: number;
};
type ModelVotableTagsCacheItem = { modelId: number; tags: ModelTagComposite[] };

// db double: mirrors dbRead.modelTag.findMany({ where: { modelId: { in }, score: { gt: 0 } } }).
const modelTagFindMany = vi.fn();

// DIVERGENCE RISK: importing the real `modelVotableTagsCache` from caches.ts would drag in
// its env/clickhouse/orchestrator import graph, so this replicates its lookupFn. Keep this a
// FAITHFUL mirror of caches.ts `modelVotableTagsCache.lookupFn` — same select fields
// (modelId + modelTagCompositeSelect: tagId/tagName/tagType/score/upVotes/downVotes), same
// `orderBy: { score: 'desc' }`, same reduce/keying. If you change one, change both.
function buildCache() {
  return createCachedObject<ModelVotableTagsCacheItem>({
    key: 'test:model-votable-tags' as never,
    idKey: 'modelId',
    ttl: 3600,
    staleWhileRevalidate: false,
    lookupFn: async (ids) => {
      const modelTags = await modelTagFindMany({
        where: { modelId: { in: ids }, score: { gt: 0 } },
        select: {
          modelId: true,
          tagId: true,
          tagName: true,
          tagType: true,
          score: true,
          upVotes: true,
          downVotes: true,
        },
        orderBy: { score: 'desc' },
      });
      return (modelTags as (ModelTagComposite & { modelId: number })[]).reduce((acc, tag) => {
        const { modelId, ...tagData } = tag;
        acc[modelId] ??= { modelId, tags: [] };
        acc[modelId].tags.push(tagData);
        return acc;
      }, {} as Record<number, ModelVotableTagsCacheItem>);
    },
  });
}

beforeEach(() => {
  store.clear();
  mGetMock.mockClear();
  setMock.mockClear();
  delMock.mockClear();
  setNxMock.mockClear().mockResolvedValue(true);
  modelTagFindMany.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('modelVotableTagsCache dedup', () => {
  const row = (modelId: number, tagId: number, tagName: string, score: number) => ({
    modelId,
    tagId,
    tagName,
    tagType: 'UserGenerated',
    score,
    upVotes: score,
    downVotes: 0,
  });

  it('hits the DB once, then serves the second fetch of the same model from cache', async () => {
    modelTagFindMany.mockResolvedValue([row(7, 304, 'nude', 5)]);
    const cache = buildCache();

    const first = await cache.fetch([7]);
    const second = await cache.fetch([7]);

    // The expensive static read is issued exactly once across two fetches.
    expect(modelTagFindMany).toHaveBeenCalledTimes(1);
    expect(first[7].tags).toEqual([
      { tagId: 304, tagName: 'nude', tagType: 'UserGenerated', score: 5, upVotes: 5, downVotes: 0 },
    ]);
    expect(second[7].tags).toEqual(first[7].tags);
  });

  it('dedups duplicate ids within a single fetch and groups rows by modelId', async () => {
    modelTagFindMany.mockResolvedValue([
      row(7, 304, 'nude', 9),
      row(7, 5, 'anime', 3),
      row(8, 6, 'realistic', 1),
    ]);
    const cache = buildCache();

    const res = await cache.fetch([7, 7, 8]);

    expect(modelTagFindMany).toHaveBeenCalledTimes(1);
    // Distinct ids only reach the DB lookup, with the full composite select + score-desc order.
    expect(modelTagFindMany).toHaveBeenCalledWith({
      where: { modelId: { in: [7, 8] }, score: { gt: 0 } },
      select: {
        modelId: true,
        tagId: true,
        tagName: true,
        tagType: true,
        score: true,
        upVotes: true,
        downVotes: true,
      },
      orderBy: { score: 'desc' },
    });
    expect(res[7].tags.map((t) => t.tagId).sort((a, b) => a - b)).toEqual([5, 304]);
    expect(res[8].tags.map((t) => t.tagId)).toEqual([6]);
  });
});
