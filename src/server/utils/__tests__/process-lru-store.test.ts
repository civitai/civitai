import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLruCache, type LruStoreResolver } from '@civitai/redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createProcessLruStoreResolver } from '~/server/utils/process-lru-store';

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
  cacheMissWouldJoinCounter: { inc: vi.fn() },
}));

const mGetMock = redisMock.redis.packed.mGet;

type Store = ReturnType<Parameters<LruStoreResolver>[1]>;
// Opaque, distinct objects: the resolver only stores and returns them.
const newStore = () => ({} as Store);

type Row = { id: number; name: string };

const lruOptions = (name: string) => ({
  name,
  max: 10,
  maxSize: 10_000,
  ttl: 60_000,
  keyFn: (id: number) => String(id),
  fetchFn: async (id: number) => ({ id }),
});

beforeEach(() => {
  delete globalThis.__civitaiProcessLruStores;
  mGetMock.mockReset().mockResolvedValue([]);
  redisMock.redis.packed.set.mockResolvedValue(undefined);
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
  redisMock.redis.del.mockResolvedValue(undefined);
});

afterEach(() => {
  delete globalThis.__civitaiProcessLruStores;
});

describe('createProcessLruStoreResolver', () => {
  it('hands a second module graph the first graph’s store, built once', () => {
    const create = vi.fn(newStore);
    const graphA = createProcessLruStoreResolver();
    const graphB = createProcessLruStoreResolver();

    const a = graphA('cache|max=10', create);
    const b = graphB('cache|max=10', create);

    expect(b).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('gives a second same-id request in ONE graph a private store', () => {
    const create = vi.fn(newStore);
    const graph = createProcessLruStoreResolver();

    const first = graph('cache|max=10', create);
    const second = graph('cache|max=10', create);

    expect(second).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
  });

  // Invariant guard (no store option exists on main): every option that shapes the store is part
  // of its id, so two same-named caches built differently never alias.
  it.each([
    ['max', { max: 11 }],
    ['maxSize', { maxSize: 20_000 }],
    ['ttl', { ttl: 30_000 }],
    ['allowStale', { allowStale: true }],
    ['sizeCalculation', { sizeCalculation: () => 1 }],
    ['name', { name: 'other-name' }],
  ] as const)('never shares a store between caches differing in %s', (_field, override) => {
    const graphA = createProcessLruStoreResolver();
    const graphB = createProcessLruStoreResolver();

    const a = createLruCache({ ...lruOptions('same-name'), store: graphA });
    const b = createLruCache({ ...lruOptions('same-name'), ...override, store: graphB });

    a.set(1, { id: 1 });
    expect(b.get(1)).toBeUndefined();
  });

  it('control: identically built caches in two graphs DO share', () => {
    const a = createLruCache({
      ...lruOptions('same-name'),
      store: createProcessLruStoreResolver(),
    });
    const b = createLruCache({
      ...lruOptions('same-name'),
      store: createProcessLruStoreResolver(),
    });

    a.set(1, { id: 1 });
    expect(b.get(1)).toEqual({ id: 1 });
  });
});

describe('createCachedArray L1 across module graphs', () => {
  async function loadBuilders() {
    const { createCachedArray } = await import('~/server/utils/cache-helpers');
    return createCachedArray;
  }

  const lookup = () =>
    vi.fn(
      async (ids: number[]) =>
        Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );

  it('serves graph B from the L1 entry graph A filled, and a bust in B reaches A', async () => {
    vi.resetModules();
    const lookupA = lookup();
    const cacheA = (await loadBuilders())<Row>({
      key: 'test:cross-graph-l1' as never,
      idKey: 'id',
      lookupFn: lookupA,
      localTtl: 60,
      localMaxBytes: 100_000,
    });
    vi.resetModules();
    const lookupB = lookup();
    const cacheB = (await loadBuilders())<Row>({
      key: 'test:cross-graph-l1' as never,
      idKey: 'id',
      lookupFn: lookupB,
      localTtl: 60,
      localMaxBytes: 100_000,
    });

    await cacheA.fetch([1]);
    expect(lookupA).toHaveBeenCalledTimes(1);
    mGetMock.mockClear();

    expect(await cacheB.fetch([1])).toEqual([{ id: 1, name: 'db-1' }]);
    expect(mGetMock).not.toHaveBeenCalled();
    expect(lookupB).not.toHaveBeenCalled();

    await cacheB.bust(1);
    mGetMock.mockClear(); // invalidate reads Redis itself
    await cacheA.fetch([1]);
    expect(mGetMock).toHaveBeenCalledTimes(1);
  });
});
