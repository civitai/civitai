import { describe, expect, it, vi } from 'vitest';
import { createCacheBuilders, type CacheBuilderDeps } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';

/**
 * `cacheNotFound` as a FUNCTION: asked once per fetch, a throw counts as false, and the static
 * `true`/`false` forms keep their old meaning. The flag-driven on/off/refresh behaviour of the one
 * caller (the frame caches) is covered end to end in src/server/__tests__/frame-cache-negative.test.ts.
 *
 * The redis stub is a Map with EX expiry, so what one fetch writes is what the next reads.
 */

type Row = { id: number; frame: string };
const KEY = 'packed:caches:test-negative' as RedisKeyTemplateCache;
const TTL = 86_400;

function build(cacheNotFound: boolean | (() => boolean | Promise<boolean>)) {
  const store = new Map<string, { value: unknown; exp?: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e?.exp !== undefined && e.exp <= Date.now()) store.delete(k);
    return store.get(k);
  };
  const sets: { key: string; EX?: number; NX: boolean }[] = [];
  const redis = {
    packed: {
      mGet: async (keys: string[]) => keys.map((k) => structuredClone(live(k)?.value ?? null)),
      set: async (key: string, value: unknown, o?: { EX?: number; NX?: boolean }) => {
        sets.push({ key, EX: o?.EX, NX: !!o?.NX });
        if (o?.NX && live(key)) return null;
        store.set(key, {
          value: structuredClone(value),
          exp: o?.EX ? Date.now() + o.EX * 1000 : undefined,
        });
        return 'OK';
      },
    },
    del: async (k: string | string[]) => {
      for (const x of [k].flat()) store.delete(x);
      return 1;
    },
    setNxKeepTtlWithEx: async () => true,
  };
  const noop = () => undefined;
  // Every hit/miss metric call, as [kind, cacheType, count].
  const metricCalls: [string, string, number][] = [];
  const record = (kind: string) => (_key: string, type: string, count: number) => {
    metricCalls.push([kind, type, count]);
  };
  const { createCachedObject } = createCacheBuilders({
    redis: redis as unknown as CacheBuilderDeps['redis'],
    defaultTtl: 300,
    metrics: {
      hit: record('hit'),
      miss: record('miss'),
      revalidate: record('revalidate'),
      failOpenDegraded: noop,
      failOpenOriginFetch: noop,
      missWouldJoin: noop,
    },
    logFailOpen: noop,
    logRefreshError: noop,
    log: noop,
    clearByPattern: async () => undefined,
  });
  // The origin: which ids wear something. Every lookup is recorded.
  const db = new Map<number, string>();
  const lookups: number[][] = [];
  const cache = createCachedObject<Row>({
    key: KEY,
    idKey: 'id',
    ttl: TTL,
    staleWhileRevalidate: false,
    debounceTime: 1,
    cacheNotFound,
    lookupFn: async (ids) => {
      lookups.push([...ids]);
      return Object.fromEntries(
        ids.filter((id) => db.has(id)).map((id) => [id, { id, frame: db.get(id) as string }])
      );
    },
  });
  const lookedUp = (id: number) => lookups.filter((l) => l.includes(id)).length;
  return { cache, db, lookups, lookedUp, metricCalls, sets, store };
}

const FRAMELESS = 4242;

describe('switchable cacheNotFound', () => {
  it('the function is asked once per fetch, and each answer governs that fetch', async () => {
    const answers = [true, false];
    const sw = vi.fn(() => answers.shift() ?? false);
    const w = build(sw);
    await w.cache.fetch([FRAMELESS]); // true: marker written
    expect(w.sets).toEqual([{ key: `${KEY}:${FRAMELESS}`, EX: TTL, NX: true }]);
    await w.cache.fetch([FRAMELESS]); // false: marker ignored, origin read again
    expect(sw).toHaveBeenCalledTimes(2);
    expect(w.lookedUp(FRAMELESS)).toBe(2);
  });

  it('switch off: a marker found is ignored, looked up again and never counted a notFound hit', async () => {
    let on = true;
    const w = build(() => on);
    await w.cache.fetch([FRAMELESS]); // on: marker written
    expect(w.store.has(`${KEY}:${FRAMELESS}`)).toBe(true);
    on = false;
    w.metricCalls.length = 0;
    await w.cache.fetch([FRAMELESS]);
    expect(w.lookedUp(FRAMELESS)).toBe(2);
    // Counted as `cacheNotFound: false` counts it: the lookup found nothing, so no metric at all.
    expect(w.metricCalls).toEqual([]);
    // A row the lookup then finds is an ordinary miss.
    w.db.set(FRAMELESS, 'bronze-9');
    expect(await w.cache.fetch([FRAMELESS])).toEqual({
      [FRAMELESS]: expect.objectContaining({ id: FRAMELESS, frame: 'bronze-9' }),
    });
    expect(w.metricCalls).toEqual([['miss', 'cachedArray', 1]]);
  });

  it('a throwing switch is off', async () => {
    const w = build(() => {
      throw new Error('flag service down');
    });
    await w.cache.fetch([FRAMELESS]);
    await w.cache.fetch([FRAMELESS]);
    expect(w.lookedUp(FRAMELESS)).toBe(2);
    expect(w.sets).toEqual([]);
  });

  it('a static false keeps its meaning: nothing written, a marker found is still served', async () => {
    const w = build(false);
    await w.cache.fetch([FRAMELESS]);
    expect(w.sets).toEqual([]);
    w.store.set(`${KEY}:${FRAMELESS}`, { value: { id: FRAMELESS, notFound: true } });
    w.db.set(FRAMELESS, 'bronze-9');
    expect(await w.cache.fetch([FRAMELESS])).toEqual({});
    expect(w.lookedUp(FRAMELESS)).toBe(1);
  });

  it('a static true keeps its meaning: the marker is written and served', async () => {
    const w = build(true);
    await w.cache.fetch([FRAMELESS]);
    await w.cache.fetch([FRAMELESS]);
    expect(w.sets).toEqual([{ key: `${KEY}:${FRAMELESS}`, EX: TTL, NX: true }]);
    expect(w.lookedUp(FRAMELESS)).toBe(1);
  });
});
