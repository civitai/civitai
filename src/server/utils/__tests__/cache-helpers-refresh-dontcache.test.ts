import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `refresh()` is the only writer in createCachedArray that used to ignore `dontCacheFn`.
 *
 * `fetch()` honors it (a rejected record is returned to the caller but never written) and the
 * degraded/fail-open path honors it, so a cache that uses `dontCacheFn` as a correctness guard
 * — "only cache values that are safe to serve stale" — silently loses that guard the moment
 * anything calls `refresh()`. modelVersionAccessCache is exactly that shape: it refuses to cache
 * non-Public / just-published versions, and `bustMvCache()` (its only invalidation path) calls
 * `refresh()`. A version mutated while its row was non-Public got that non-Public availability
 * pinned in Redis for `ttl + swr tail`, and hasEntityAccess then denied every non-owner.
 */

const mGetMock = vi.fn();
const setMock = vi.fn().mockResolvedValue(undefined);
const setNxMock = vi.fn().mockResolvedValue(true);
const delMock = vi.fn().mockResolvedValue(undefined);

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: {
      mGet: (...args: unknown[]) => mGetMock(...args),
      set: (...args: unknown[]) => setMock(...args),
    },
    setNxKeepTtlWithEx: (...args: unknown[]) => setNxMock(...args),
    del: (...args: unknown[]) => delMock(...args),
  },
  sysRedis: {},
  REDIS_KEYS: { CACHE_LOCKS: 'caches:lock', TAG: 'caches:tag' },
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

type Row = { id: number; availability: string };

const KEY = 'packed:caches:test-refresh-dontcache';

function makeCache(lookup: (ids: number[]) => Record<string, Row>) {
  return createCachedObject<Row>({
    key: KEY as never,
    idKey: 'id',
    ttl: 60,
    lookupFn: async (ids) => lookup(ids as number[]),
    dontCacheFn: (data) => data.availability !== 'Public',
  });
}

// Same cache with NO dontCacheFn — the shape all but three caches in the repo use.
function makePlainCache(lookup: (ids: number[]) => Record<string, Row>) {
  return createCachedObject<Row>({
    key: KEY as never,
    idKey: 'id',
    ttl: 60,
    lookupFn: async (ids) => lookup(ids as number[]),
  });
}

const setKeys = () => setMock.mock.calls.map((c) => c[0] as string);
const delKeys = () => delMock.mock.calls.flatMap((c) => (Array.isArray(c[0]) ? c[0] : [c[0]]));

beforeEach(() => {
  vi.clearAllMocks();
  mGetMock.mockResolvedValue([]);
});

describe('createCachedArray.refresh — dontCacheFn', () => {
  it('does not write a record that dontCacheFn rejects', async () => {
    const cache = makeCache(() => ({ '1': { id: 1, availability: 'EarlyAccess' } }));

    await cache.refresh([1]);

    expect(setKeys()).not.toContain(`${KEY}:1`);
  });

  it('deletes the existing key for a record that dontCacheFn rejects', async () => {
    const cache = makeCache(() => ({ '1': { id: 1, availability: 'EarlyAccess' } }));

    await cache.refresh([1]);

    expect(delKeys()).toContain(`${KEY}:1`);
  });

  it('still writes records dontCacheFn accepts', async () => {
    const cache = makeCache(() => ({ '1': { id: 1, availability: 'Public' } }));

    await cache.refresh([1]);

    expect(setKeys()).toContain(`${KEY}:1`);
    expect(delKeys()).not.toContain(`${KEY}:1`);
  });

  it('splits a mixed batch — caches the acceptable ids, drops the rejected ones', async () => {
    const cache = makeCache(() => ({
      '1': { id: 1, availability: 'Public' },
      '2': { id: 2, availability: 'Private' },
    }));

    await cache.refresh([1, 2, 3]);

    expect(setKeys()).toEqual([`${KEY}:1`]);
    // 2 was rejected by dontCacheFn, 3 had no row at all — both must end up absent.
    expect(delKeys()).toEqual(expect.arrayContaining([`${KEY}:2`, `${KEY}:3`]));
  });

  it('never touches an id that was not asked for', async () => {
    const cache = makeCache(() => ({
      '1': { id: 1, availability: 'Public' },
      '99': { id: 99, availability: 'Private' },
    }));

    await cache.refresh([1]);

    expect(delKeys()).not.toContain(`${KEY}:99`);
  });
});

// The change is scoped to caches that opt into dontCacheFn. Every other cache in the repo must
// keep the exact refresh() semantics it had: write every row, delete only the ids with no row.
describe('createCachedArray.refresh — caches without dontCacheFn are unchanged', () => {
  it('writes every returned record', async () => {
    const cache = makePlainCache(() => ({
      '1': { id: 1, availability: 'Public' },
      '2': { id: 2, availability: 'Private' },
      '3': { id: 3, availability: 'EarlyAccess' },
    }));

    await cache.refresh([1, 2, 3]);

    expect(setKeys()).toEqual([`${KEY}:1`, `${KEY}:2`, `${KEY}:3`]);
    expect(delKeys()).toEqual([]);
  });

  it('deletes only the ids the lookup had no row for', async () => {
    const cache = makePlainCache(() => ({ '1': { id: 1, availability: 'Private' } }));

    await cache.refresh([1, 2]);

    expect(setKeys()).toEqual([`${KEY}:1`]);
    expect(delKeys()).toEqual([`${KEY}:2`]);
  });

  it('treats a falsy lookup value as no row — deleted, never written', async () => {
    const cache = makePlainCache(() => ({ '1': undefined } as unknown as Record<string, Row>));

    await cache.refresh([1]);

    expect(setKeys()).toEqual([]);
    expect(delKeys()).toEqual([`${KEY}:1`]);
  });
});
