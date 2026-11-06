import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCacheBuilders, type CacheBuilderDeps } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';

/**
 * `cacheNotFound` as a FUNCTION (a runtime switch): asked once per fetch that reaches Redis. On,
 * an id the lookup finds nothing for is cached as a notFound marker; off, nothing is written and a
 * marker left from an "on" period is read as a miss, so off is the uncached behaviour at once.
 * A static `false` keeps its old meaning (no writes, a marker found is still served).
 *
 * The redis stub is a Map with EX expiry on the faked clock, so what one fetch writes is what the
 * next reads.
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
  const { createCachedObject } = createCacheBuilders({
    redis: redis as unknown as CacheBuilderDeps['redis'],
    defaultTtl: 300,
    metrics: {
      hit: noop,
      miss: noop,
      revalidate: noop,
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
  return { cache, db, lookups, lookedUp, sets, store };
}

const FRAMELESS = 4242;
const FRAMED = 5151;

describe('switchable cacheNotFound', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('on: a frameless id is read from the origin once across two requests', async () => {
    const w = build(() => true);
    w.db.set(FRAMED, 'gold-7');
    expect(await w.cache.fetch([FRAMELESS, FRAMED])).toEqual({
      [FRAMED]: { id: FRAMED, frame: 'gold-7' },
    });
    expect(await w.cache.fetch([FRAMELESS, FRAMED])).toEqual({
      [FRAMED]: { id: FRAMED, frame: 'gold-7' },
    });
    expect(w.lookedUp(FRAMELESS)).toBe(1);
    expect(w.lookedUp(FRAMED)).toBe(1);
  });

  it('off (control): a frameless id is read from the origin on every request, nothing written', async () => {
    const w = build(() => false);
    for (let i = 0; i < 3; i++) await w.cache.fetch([FRAMELESS]);
    expect(w.lookedUp(FRAMELESS)).toBe(3);
    expect(w.sets).toEqual([]);
  });

  it('on: the marker lives exactly as long as a cached frame', async () => {
    const w = build(() => true);
    w.db.set(FRAMED, 'gold-7');
    await w.cache.fetch([FRAMELESS, FRAMED]);
    const ex = (id: number) => w.sets.find((s) => s.key === `${KEY}:${id}`)?.EX;
    expect(ex(FRAMELESS)).toBe(TTL);
    expect(ex(FRAMED)).toBe(TTL);
    expect(w.sets.find((s) => s.key === `${KEY}:${FRAMELESS}`)?.NX).toBe(true);
    vi.setSystemTime(new Date(Date.now() + (TTL - 1) * 1000));
    await w.cache.fetch([FRAMELESS]);
    expect(w.lookedUp(FRAMELESS)).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 2_000));
    await w.cache.fetch([FRAMELESS]);
    expect(w.lookedUp(FRAMELESS)).toBe(2);
  });

  it('on: putting a frame on refreshes the entry, so the next request sees it', async () => {
    const w = build(() => true);
    await w.cache.fetch([FRAMELESS]);
    w.db.set(FRAMELESS, 'silver-3');
    await w.cache.refresh(FRAMELESS); // what every equip path does
    expect(await w.cache.fetch([FRAMELESS])).toEqual({
      [FRAMELESS]: { id: FRAMELESS, frame: 'silver-3' },
    });
  });

  it('on: a bust also ends the marker (the next request reads the origin)', async () => {
    const w = build(() => true);
    await w.cache.fetch([FRAMELESS]);
    w.db.set(FRAMELESS, 'silver-3');
    await w.cache.bust(FRAMELESS);
    expect(await w.cache.fetch([FRAMELESS])).toEqual({
      [FRAMELESS]: { id: FRAMELESS, frame: 'silver-3' },
    });
  });

  it('turned off, a marker written while on is ignored at once', async () => {
    let on = true;
    const w = build(() => on);
    await w.cache.fetch([FRAMELESS]);
    // A frame goes on through a writer that does not refresh; with the switch off it must still
    // show on the next request, as it does today.
    w.db.set(FRAMELESS, 'bronze-9');
    on = false;
    expect(await w.cache.fetch([FRAMELESS])).toEqual({
      [FRAMELESS]: { id: FRAMELESS, frame: 'bronze-9' },
    });
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
});
