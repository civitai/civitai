import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app's wiring of the slot-bucketed layout: a cache built with `slotBuckets` asks the
 * FEED_HYDRATION_SLOT_BUCKETS flag, per cache (the cache key as entity id AND as the `cache` context
 * property), and reads the layout it answers; a cache without it never asks. The layout itself is
 * covered in packages/civitai-redis (cached-array-slot-buckets.test.ts).
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
  cacheMissWouldJoinCounter: { inc: vi.fn() },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/flipt/client')>()),
  isFlipt: vi.fn(),
}));

import { isFlipt } from '~/server/flipt/client';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mGetMock = redisMock.redis.packed.mGet;
const isFliptMock = vi.mocked(isFlipt);

type Row = { id: number; v: string };
const KEY = 'packed:caches:test-slot-buckets';
const lookupFn = vi.fn(async (ids: number[]) =>
  Object.fromEntries(ids.map((id) => [id, { id, v: `db-${id * 11}` }]))
);

beforeEach(() => {
  vi.clearAllMocks();
  mGetMock.mockImplementation(async (keys: string[]) => keys.map(() => null));
  redisMock.redis.packed.set.mockResolvedValue('OK');
});

describe('cache-helpers: the slot-bucketed layout flag', () => {
  it('asks the flag per cache and, when on, reads bucketed keys with one MGET per slot', async () => {
    isFliptMock.mockResolvedValue(true);
    const cache = createCachedObject<Row>({
      key: KEY as never,
      idKey: 'id',
      lookupFn,
      slotBuckets: 4,
    });
    const got = await cache.fetch([5, 6]);
    expect(got).toEqual({ 5: { id: 5, v: 'db-55' }, 6: { id: 6, v: 'db-66' } });
    expect(isFliptMock).toHaveBeenCalledWith('feed-hydration-slot-buckets', KEY, { cache: KEY });
    const [keys, options] = mGetMock.mock.calls[0];
    expect(keys).toHaveLength(2);
    expect(keys.every((k: string) => k.startsWith(`${KEY}:{`))).toBe(true);
    expect(options).toMatchObject({ coalesceSlots: true, cacheName: KEY });
  });

  it('when off, reads the legacy keys exactly as before', async () => {
    isFliptMock.mockResolvedValue(false);
    const cache = createCachedObject<Row>({
      key: KEY as never,
      idKey: 'id',
      lookupFn,
      slotBuckets: 4,
    });
    await cache.fetch([5, 6]);
    expect(mGetMock).toHaveBeenCalledWith([`${KEY}:5`, `${KEY}:6`], {
      compress: false,
      cacheName: KEY,
    });
  });

  it('a cache without slotBuckets never asks the flag', async () => {
    isFliptMock.mockResolvedValue(true);
    const cache = createCachedObject<Row>({ key: KEY as never, idKey: 'id', lookupFn });
    await cache.fetch([5, 6]);
    expect(isFliptMock).not.toHaveBeenCalled();
    expect(mGetMock).toHaveBeenCalledWith([`${KEY}:5`, `${KEY}:6`], {
      compress: false,
      cacheName: KEY,
    });
  });
});
