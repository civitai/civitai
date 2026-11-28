import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * The per-process copy of the HomeBlock row (`readHomeBlockRowThrough`) and the L1's on-time purge
 * of expired entries, both behind `home-block-server-cache`. The real caches, a fake Redis, and the
 * flag set directly.
 */

const { getHomeBlockData } = vi.hoisted(() => ({ getHomeBlockData: vi.fn() }));
vi.mock('~/server/services/home-block.service', () => ({
  getHomeBlockData,
  resolveHomeBlockMetadata: vi.fn(async () => ({})),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  bustFetchThroughCache: vi.fn(async () => undefined),
}));

import { cacheHitCounter, cacheMissCounter } from '@civitai/telemetry/client';
import { homeBlockL1EvictionCounter } from '~/server/prom/home-block-l1.metrics';
import { L1_CACHE_BYTE_BUDGETS } from '~/server/redis/l1-cache-budget';
import {
  bustSystemHomeBlockCaches,
  forgetHomeBlockRows,
  getHomeBlockCached,
  HOME_BLOCK_L1_TTL_MS,
  HOME_BLOCK_ROW_TTL_MS,
  readHomeBlockRowThrough,
  resetHomeBlockL1ForTests,
} from '~/server/services/home-block-cache.service';
import * as homeBlockSource from '~/server/services/home-block.service';

type Readable = {
  get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }>;
};
/** The sum of a real counter's series for one cache name (0 before its first increment). */
async function counted(counter: unknown, cacheName: string) {
  const { values } = await (counter as Readable).get();
  return values
    .filter((v) => v.labels.cache_name === cacheName)
    .reduce((sum, v) => sum + v.value, 0);
}

const ROW = { id: 41, type: 'Leaderboard', userId: -1, sourceId: null, metadata: { title: 'A' } };
let reads = 0;
const read = (row: typeof ROW | null = ROW) =>
  vi.fn(async () => {
    reads++;
    return row && { ...row };
  });

const store = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  reads = 0;
  store.clear();
  redisMock.redis.packed.get.mockImplementation(async (key: string) =>
    store.has(key) ? JSON.parse(store.get(key) as string) : null
  );
  redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  });
  resetHomeBlockL1ForTests(() => false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readHomeBlockRowThrough', () => {
  it('flag off: every call reads the row (the old path)', async () => {
    const fn = read();
    for (let i = 0; i < 3; i++) expect(await readHomeBlockRowThrough(41, fn)).toEqual(ROW);
    expect(reads).toBe(3);
  });

  it('flag on: one read serves the next calls, each with its own top-level object', async () => {
    resetHomeBlockL1ForTests(() => true);
    const fn = read();
    const a = await readHomeBlockRowThrough(41, fn);
    const b = await readHomeBlockRowThrough(41, fn);
    expect(reads).toBe(1);
    expect(a).toEqual(ROW);
    expect(b).toEqual(ROW);
    expect(a).not.toBe(b);
    (a as Record<string, unknown>).type = 'Collection';
    expect(await readHomeBlockRowThrough(41, fn)).toEqual(ROW);
  });

  it('flag on: each id is its own entry', async () => {
    resetHomeBlockL1ForTests(() => true);
    await readHomeBlockRowThrough(41, read());
    const other = { ...ROW, id: 42, metadata: { title: 'B' } };
    expect(await readHomeBlockRowThrough(42, read(other))).toEqual(other);
    expect(reads).toBe(2);
  });

  it('flag on: a copy is served for 10s and no longer', async () => {
    expect(HOME_BLOCK_ROW_TTL_MS).toBe(10_000);
    vi.useFakeTimers();
    resetHomeBlockL1ForTests(() => true);
    const fn = read();
    await readHomeBlockRowThrough(41, fn);
    vi.advanceTimersByTime(9_999);
    await readHomeBlockRowThrough(41, fn);
    expect(reads).toBe(1);
    vi.advanceTimersByTime(2);
    await readHomeBlockRowThrough(41, fn);
    expect(reads).toBe(2);
  });

  it('flag on: a missing row is never kept', async () => {
    resetHomeBlockL1ForTests(() => true);
    const fn = read(null);
    expect(await readHomeBlockRowThrough(41, fn)).toBeNull();
    expect(await readHomeBlockRowThrough(41, fn)).toBeNull();
    expect(reads).toBe(2);
  });

  it('forgetHomeBlockRows drops the copy, so the next call reads', async () => {
    resetHomeBlockL1ForTests(() => true);
    const fn = read();
    await readHomeBlockRowThrough(41, fn);
    forgetHomeBlockRows([41]);
    await readHomeBlockRowThrough(41, fn);
    expect(reads).toBe(2);
  });

  it('a system block bust drops that row too', async () => {
    resetHomeBlockL1ForTests(() => true);
    const fn = read();
    await readHomeBlockRowThrough(41, fn);
    await bustSystemHomeBlockCaches({ id: 41, type: HomeBlockType.Leaderboard, metadata: {} });
    await readHomeBlockRowThrough(41, fn);
    expect(reads).toBe(2);
  });

  it('counts hits and misses on the shared series as home-block-row; off counts nothing', async () => {
    const before = {
      hit: await counted(cacheHitCounter, 'home-block-row'),
      miss: await counted(cacheMissCounter, 'home-block-row'),
    };
    await readHomeBlockRowThrough(41, read());
    expect(await counted(cacheMissCounter, 'home-block-row')).toBe(before.miss);

    resetHomeBlockL1ForTests(() => true);
    for (let i = 0; i < 3; i++) await readHomeBlockRowThrough(41, read());
    expect(await counted(cacheHitCounter, 'home-block-row')).toBe(before.hit + 2);
    expect(await counted(cacheMissCounter, 'home-block-row')).toBe(before.miss + 1);
  });

  it('is budgeted at 2MB', () => {
    expect(L1_CACHE_BYTE_BUDGETS.homeBlockRows).toBe(2 * 1024 * 1024);
  });
});

describe('the L1 purges expired entries on time', () => {
  // 1,000 items each: ~3.9MB by the estimate, so three overflow the 10MB budget but two do not.
  beforeEach(() => {
    let builds = 0;
    getHomeBlockData.mockImplementation(async () => {
      builds++;
      return { leaderboards: Array.from({ length: 1000 }, (_, i) => ({ id: `b${builds}-${i}` })) };
    });
  });
  const fill = (sourceId: number) =>
    getHomeBlockCached(
      { id: 11, userId: 1, sourceId, type: HomeBlockType.Leaderboard, metadata: {} } as never,
      undefined,
      {},
      homeBlockSource
    );
  const evictions = () => counted(homeBlockL1EvictionCounter, 'home-block-l1');

  it('control: three live entries do not fit, so one is evicted', async () => {
    vi.useFakeTimers();
    resetHomeBlockL1ForTests(() => true);
    const before = await evictions();
    for (const sourceId of [1, 2, 3]) await fill(sourceId);
    expect((await evictions()) - before).toBe(1);
  });

  it('two entries past their 10s hold no budget: a third fits with no eviction', async () => {
    expect(HOME_BLOCK_L1_TTL_MS).toBe(10_000);
    vi.useFakeTimers();
    resetHomeBlockL1ForTests(() => true);
    const before = await evictions();
    await fill(1);
    await fill(2);
    vi.advanceTimersByTime(10_001);
    await fill(3);
    expect((await evictions()) - before).toBe(0);
  });
});
