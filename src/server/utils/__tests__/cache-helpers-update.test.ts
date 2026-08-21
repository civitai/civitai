import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `update()` is the write-through path: rewrite ONE entry from a delta the caller
 * already knows instead of re-deriving it from the origin. It exists because
 * `refresh()` on a large per-user collection costs a full unbounded primary query
 * per mutation — 19,224 buffers and ~100 ms for the tail user of `userFollowsCache`,
 * measured on prod (868kurkd0).
 *
 * The two properties that make it safe are asserted here rather than at the call
 * site: it never invents an entry that was not already cached (a caller relies on
 * `false` to fall back to the refetch), and it does not extend the entry's life — an
 * entry maintained by deltas has to age out on its original schedule or a drifted
 * one never self-heals.
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));

import { createCachedObject } from '~/server/utils/cache-helpers';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mGetMock = redisMock.redis.packed.mGet;
const setMock = redisMock.redis.packed.set;
const setNxMock = redisMock.redis.setNxKeepTtlWithEx;
const delMock = redisMock.redis.del;

type Row = { id: number; members: number[] };

const KEY = 'packed:caches:test-update';
const TTL = 60;

const lookupFn = vi.fn(async () => ({} as Record<string, Row>));

const makeCache = (dontCacheFn?: (data: Row) => boolean) =>
  createCachedObject<Row>({
    key: KEY as never,
    idKey: 'id',
    ttl: TTL,
    staleWhileRevalidate: false,
    lookupFn,
    dontCacheFn,
  });

const addMember = (current: Row) => ({ ...current, members: [...current.members, 9] });

beforeEach(() => {
  vi.clearAllMocks();
  setMock.mockResolvedValue(undefined);
  setNxMock.mockResolvedValue(true);
  delMock.mockResolvedValue(undefined);
  mGetMock.mockResolvedValue([]);
});

describe('createCachedArray.update — the write-through path', () => {
  it('rewrites the entry from the delta and never reaches the origin', async () => {
    const cachedAt = new Date(Date.now() - 10_000);
    mGetMock.mockResolvedValue([{ id: 1, members: [7], cachedAt }]);

    await expect(makeCache().update(1, addMember)).resolves.toBe(true);

    expect(lookupFn).not.toHaveBeenCalled();
    const [key, value, options] = setMock.mock.calls[0];
    expect(key).toBe(`${KEY}:1`);
    // `cachedAt` carried over, not reset: the entry stays as fresh as it was and no
    // fresher, so its revalidation clock is unchanged.
    expect(value).toEqual({ id: 1, members: [7, 9], cachedAt });
    // The REMAINDER of the original expiry, not a full TTL. Resetting it here lets a
    // delta-maintained entry live indefinitely, and a drift in the delta logic then
    // never ages out.
    expect((options as { EX: number }).EX).toBe(TTL - 10);
  });

  it.each([
    ['absent', undefined],
    ['a notFound marker', { id: 1, notFound: true, cachedAt: new Date() }],
    ['a debounce marker', { id: 1, debounce: true, cachedAt: new Date() }],
    ['past its expiry', { id: 1, members: [7], cachedAt: new Date(Date.now() - TTL * 2000) }],
  ])('reports false and writes nothing when the entry is %s', async (_label, entry) => {
    mGetMock.mockResolvedValue([entry]);

    await expect(makeCache().update(1, addMember)).resolves.toBe(false);

    // Writing here would MATERIALISE an entry from a delta alone — a follow set
    // containing exactly the one id the caller happened to touch.
    expect(setMock).not.toHaveBeenCalled();
  });

  it('reports false without reading when another writer holds the entry', async () => {
    setNxMock.mockResolvedValue(false);

    await expect(makeCache().update(1, addMember)).resolves.toBe(false);

    // Two concurrent read-modify-writes lose one of the deltas for the rest of the
    // TTL. The loser takes the caller's fallback, which re-derives from the origin.
    expect(mGetMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });

  it('honours dontCacheFn against the UPDATED value', async () => {
    mGetMock.mockResolvedValue([{ id: 1, members: [7], cachedAt: new Date() }]);

    await expect(makeCache((data) => data.members.includes(9)).update(1, addMember)).resolves.toBe(
      false
    );

    expect(setMock).not.toHaveBeenCalled();
  });

  it('releases the lock on every exit, including a failure', async () => {
    const lockKey = `cache-lock:${KEY}:1:update`;

    mGetMock.mockResolvedValue([{ id: 1, members: [7], cachedAt: new Date() }]);
    await makeCache().update(1, addMember);
    expect(delMock).toHaveBeenCalledWith(lockKey);

    delMock.mockClear();
    mGetMock.mockRejectedValue(new Error('cluster down'));
    // Fail open: a committed mutation must not 500 because the cache write failed.
    await expect(makeCache().update(1, addMember)).resolves.toBe(false);
    // Without this a wedged read leaves the lock standing for its whole TTL, and
    // every following toggle for that user takes the slow fallback.
    expect(delMock).toHaveBeenCalledWith(lockKey);
  });
});
