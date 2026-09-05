import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `update()` is the write-through path: rewrite ONE entry from a delta the caller
 * already knows instead of re-deriving it from the origin. It exists because
 * `refresh()` on a large per-user collection costs a full unbounded primary query
 * per mutation — 19,224 buffers and ~100 ms for the tail user of `userFollowsCache`,
 * measured on prod (868kurkd0).
 *
 * The properties that make it safe are asserted here rather than at the call site: it
 * never invents an entry that was not already cached (a caller relies on `false` to
 * fall back to the refetch), it does not extend the entry's life, and it takes a lock
 * whose key is the entry's own — a lock on the wrong key silently reverts the whole
 * perf claim, because the NX would fail against the live entry and every caller would
 * take the fallback with nothing red.
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
const ENTRY_KEY = `${KEY}:1`;
const LOCK_KEY = `cache-lock:${KEY}:1:update`;
const TTL = 60;

const lookupFn = vi.fn(async () => ({} as Record<string, Row>));

const makeCache = (opts: { dontCacheFn?: (data: Row) => boolean; localTtl?: number } = {}) =>
  createCachedObject<Row>({
    key: KEY as never,
    idKey: 'id',
    ttl: TTL,
    staleWhileRevalidate: false,
    lookupFn,
    ...opts,
  });

// Tolerant of a missing `members` ON PURPOSE. An updater that throws on a marker
// entry makes the marker guards look tested when what actually stops the write is the
// exception — verified by mutation: dropping the guards left this suite green until
// the updater stopped throwing.
const addMember = (current: Row) => ({ ...current, members: [...(current.members ?? []), 9] });

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
    // The entry's OWN key on both the read and the write. Reading `id + 1` while
    // writing `id` would apply one user's delta to another user's cached set, and
    // asserting only the write would not see it.
    // The 2nd arg is the packed codec options threaded from the cache's `compress` option
    // (#4588). This cache does not opt in, so it must be `false` here — asserted rather than
    // loosened to `expect.anything()`, since a read that silently flipped to compress:true
    // against uncompressed writes is exactly the asymmetry that flag has to avoid.
    expect(mGetMock).toHaveBeenCalledWith([ENTRY_KEY], { compress: false });
    const [key, value, options, packedOptions] = setMock.mock.calls[0];
    expect(key).toBe(ENTRY_KEY);
    expect(packedOptions).toEqual({ compress: false });
    // `cachedAt` carried over, not reset: the entry stays as fresh as it was and no
    // fresher, so its revalidation clock is unchanged.
    expect(value).toEqual({ id: 1, members: [7, 9], cachedAt });
    // The REMAINDER of the original expiry, and `XX`. Not `KEEPTTL`: on a key that
    // vanished between the GET and the SET, KEEPTTL CREATES it with no expiry at all,
    // and a cache whose readers ignore `cachedAt` then serves it forever with no
    // self-heal. `XX` makes the same case a no-op instead.
    expect(options).toEqual({ EX: TTL - 10, XX: true });
  });

  it('locks the ENTRY, briefly', async () => {
    mGetMock.mockResolvedValue([{ id: 1, members: [7], cachedAt: new Date() }]);

    await makeCache().update(1, addMember);

    // Lock the wrong key — the entry key, say — and the NX fails against the live
    // entry, `update` returns false on EVERY call, and every caller silently falls
    // back to the 19,224-buffer refetch this exists to replace. Nothing goes red.
    // The TTL bounds one GET and one SET; an hour would wedge a user's toggles for an
    // hour after a pod dies mid-update.
    expect(setNxMock).toHaveBeenCalledWith(LOCK_KEY, '1', 5);
  });

  it.each([
    ['absent', undefined],
    ['a notFound marker', { id: 1, notFound: true, cachedAt: new Date() }],
    ['a debounce marker', { id: 1, debounce: true, cachedAt: new Date() }],
    ['missing its cachedAt', { id: 1, members: [7] }],
  ])('reports false and writes nothing when the entry is %s', async (_label, entry) => {
    mGetMock.mockResolvedValue([entry]);

    await expect(makeCache().update(1, addMember)).resolves.toBe(false);

    // Writing here would MATERIALISE an entry from a delta alone — a follow set
    // containing exactly the one id the caller happened to touch.
    expect(setMock).not.toHaveBeenCalled();
  });

  it('reports false, and creates nothing, when the entry vanished mid-update', async () => {
    // Expired or evicted in the few ms since the GET. `XX` makes Redis refuse, the
    // reply is null, and the caller must re-derive — the alternative is a whole
    // collection materialised from one delta, or with KEEPTTL a key that never expires.
    mGetMock.mockResolvedValue([{ id: 1, members: [7], cachedAt: new Date() }]);
    setMock.mockResolvedValue(null);

    await expect(makeCache().update(1, addMember)).resolves.toBe(false);
  });

  it('reports false when the entry is already past its expiry', async () => {
    mGetMock.mockResolvedValue([
      { id: 1, members: [7], cachedAt: new Date(Date.now() - TTL * 2000) },
    ]);

    await expect(makeCache().update(1, addMember)).resolves.toBe(false);
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

    await expect(
      makeCache({ dontCacheFn: (data) => data.members.includes(9) }).update(1, addMember)
    ).resolves.toBe(false);

    expect(setMock).not.toHaveBeenCalled();
  });

  it('drops the per-pod L1 copy AFTER the write, so a later read sees the delta', async () => {
    const cache = makeCache({ localTtl: 30 });
    const cachedAt = new Date();
    // A FRESH object per call. `fetch` strips `cachedAt` from the record it is
    // handed, in place — so a shared `mockResolvedValue` reference would leave the
    // next reader looking at an entry with no `cachedAt`, which `update` correctly
    // refuses. That is a fixture artifact, and it would read as the guard misfiring.
    mGetMock.mockImplementation(async () => [{ id: 1, members: [7], cachedAt }]);

    await cache.fetch(1); // populates L1 with members [7]
    await expect(cache.update(1, addMember)).resolves.toBe(true);

    mGetMock.mockImplementation(async () => [{ id: 1, members: [7, 9], cachedAt }]);
    await expect(cache.fetch(1)).resolves.toEqual({ '1': { id: 1, members: [7, 9] } });
    // Without the drop this pod keeps serving its pre-update copy for localTtl, on
    // the very pod that just processed the mutation. Dropping BEFORE the write is the
    // other half: a concurrent fetch in that window refills L1 from the stale value
    // and pins it — which this cannot see, so the ordering is stated in the source.
  });

  it('releases the lock on every exit, including a failure', async () => {
    mGetMock.mockResolvedValue([{ id: 1, members: [7], cachedAt: new Date() }]);
    await makeCache().update(1, addMember);
    expect(delMock).toHaveBeenCalledWith(LOCK_KEY);

    delMock.mockClear();
    mGetMock.mockRejectedValue(new Error('cluster down'));
    // Fail open: a committed mutation must not 500 because the cache write failed.
    await expect(makeCache().update(1, addMember)).resolves.toBe(false);
    // Without this a wedged read leaves the lock standing for its whole TTL, and
    // every following toggle for that user takes the slow fallback.
    expect(delMock).toHaveBeenCalledWith(LOCK_KEY);
  });
});
