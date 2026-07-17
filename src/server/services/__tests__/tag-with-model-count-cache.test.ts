import { vi, describe, it, expect, beforeEach } from 'vitest';

// Backing store for the fake Redis so cache hit/miss semantics are REAL (a Map), letting
// us assert exactly when the origin DB query is re-run.
const { store, dbReadQueryRaw, redisPackedGet, redisPackedSet, redisDel } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    dbReadQueryRaw: vi.fn(),
    redisPackedGet: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    redisPackedSet: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    redisDel: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: dbReadQueryRaw },
  dbWrite: {},
}));
// Keep the real REDIS_KEYS (so the key we build matches the production constant) and only
// swap the live client for the in-memory fake.
vi.mock('~/server/redis/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/redis/client')>();
  return {
    ...actual,
    redis: { del: redisDel, packed: { get: redisPackedGet, set: redisPackedSet } },
  };
});

import { getTagWithModelCount } from '~/server/services/tag.service';

const KEY_PREFIX = 'packed:caches:tag-with-model-count';

// A stored-case tag row exactly as the raw query returns it. Note `name` is the ACTUAL
// stored case ("Anime"), which must survive byte-identically through the cache regardless
// of the (lowercased) key.
const ANIME_ROW = { id: 7, name: 'Anime', unfeatured: false, count: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  redisPackedGet.mockImplementation(async (key: string) =>
    store.has(key) ? store.get(key) : null
  );
  redisPackedSet.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value);
  });
});

describe('getTagWithModelCount — read-through cache', () => {
  it('serves the second call for the same name from cache without re-hitting the DB', async () => {
    dbReadQueryRaw.mockResolvedValue([ANIME_ROW]);

    const first = await getTagWithModelCount({ name: 'Anime' });
    const second = await getTagWithModelCount({ name: 'Anime' });

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1); // the win: one DB read, not two
    expect(first).toEqual(second);
    expect(redisPackedSet).toHaveBeenCalledTimes(1);
  });

  it('returns output byte-identical to the raw query, incl. the stored-case name', async () => {
    dbReadQueryRaw.mockResolvedValue([ANIME_ROW]);

    const result = await getTagWithModelCount({ name: 'anime' });

    // Shape + values match {id,name,unfeatured,count:0}; `name` is the DB stored case.
    expect(result).toEqual([{ id: 7, name: 'Anime', unfeatured: false, count: 0 }]);
    // What we cached is exactly what we returned (no transformation of the DB row).
    expect(store.get(`${KEY_PREFIX}:anime`)).toEqual([ANIME_ROW]);
  });

  it('keys by lowercased name: "Anime" and "anime" share ONE entry (one DB hit)', async () => {
    dbReadQueryRaw.mockResolvedValue([ANIME_ROW]);

    const upper = await getTagWithModelCount({ name: 'Anime' });
    const lower = await getTagWithModelCount({ name: 'anime' });

    // citext is case-insensitive; the cache mirrors that — the second case-variant is a hit.
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    expect(Array.from(store.keys())).toEqual([`${KEY_PREFIX}:anime`]);
    // Both return the tag's actual stored-case name, not the normalized key.
    expect(upper[0].name).toBe('Anime');
    expect(lower[0].name).toBe('Anime');
  });

  it('passes the raw name (not the lowercased key) to the DB query — citext resolves case', async () => {
    dbReadQueryRaw.mockResolvedValue([ANIME_ROW]);
    await getTagWithModelCount({ name: 'Anime' });
    // The tagged-template call receives the ORIGINAL-case value as its first interpolation.
    const values = dbReadQueryRaw.mock.calls[0].slice(1);
    expect(values).toContain('Anime');
  });

  it('does NOT cache a negative result — an unknown name re-hits the DB every call', async () => {
    dbReadQueryRaw.mockResolvedValue([]); // no such tag

    const first = await getTagWithModelCount({ name: 'does-not-exist' });
    const second = await getTagWithModelCount({ name: 'does-not-exist' });

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    // Both calls hit the DB (no negative caching) so a newly-created tag is findable at once.
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(2);
    expect(redisPackedSet).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('becomes findable immediately after the tag is created (no stale negative)', async () => {
    // Miss (tag absent) — not cached.
    dbReadQueryRaw.mockResolvedValueOnce([]);
    expect(await getTagWithModelCount({ name: 'brandnew' })).toEqual([]);

    // Tag now created out-of-band; next read finds it (no cached negative to shadow it).
    const created = { id: 99, name: 'brandnew', unfeatured: false, count: 0 };
    dbReadQueryRaw.mockResolvedValueOnce([created]);
    expect(await getTagWithModelCount({ name: 'brandnew' })).toEqual([created]);
  });

  it('fails open to the DB when the Redis read throws (hot path must not 500)', async () => {
    redisPackedGet.mockRejectedValueOnce(new Error('redis down'));
    dbReadQueryRaw.mockResolvedValue([ANIME_ROW]);

    const result = await getTagWithModelCount({ name: 'Anime' });
    expect(result).toEqual([ANIME_ROW]); // degraded to origin, correct result
  });
});
