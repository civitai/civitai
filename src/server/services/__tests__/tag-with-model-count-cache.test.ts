import { vi, describe, it, expect, beforeEach } from 'vitest';
import { pack, unpack } from 'msgpackr';

// Backing store for the fake Redis. Values are stored as msgpackr-PACKED Buffers and
// unpacked on read — the SAME codec the real `redis.packed` client uses (set -> pack(value),
// get -> unpack(buffer)) — so the byte-identical claim is exercised through the real
// serializer end-to-end, not a pass-through fake. Cache hit/miss semantics stay real (a
// Map), letting us assert exactly when the origin DB query is re-run.
const { store, dbReadQueryRaw, redisPackedGet, redisPackedSet, redisDel } = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  dbReadQueryRaw: vi.fn(),
  redisPackedGet: vi.fn(),
  redisPackedSet: vi.fn(),
  redisDel: vi.fn(),
}));

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
  // Real msgpackr round-trip: set packs to a Buffer, get unpacks — mirrors the production
  // redis.packed codec so serializer fidelity (stored-case string, `count:0` int, boolean,
  // array shape) is actually under test on the hit path.
  redisPackedGet.mockImplementation(async (key: string) => {
    const buf = store.get(key);
    return buf ? unpack(buf) : null;
  });
  redisPackedSet.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, pack(value));
  });
  redisDel.mockImplementation(async (key: string) => {
    store.delete(key);
    return 1;
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

    // Prove byte-identity THROUGH the real msgpackr codec: unpack the actual stored Buffer
    // and assert every field survives the serializer — stored-case string, `count:0` int,
    // `unfeatured` boolean, single-element array shape.
    const storedBuffer = store.get(`${KEY_PREFIX}:anime`);
    expect(Buffer.isBuffer(storedBuffer)).toBe(true);
    const roundTripped = unpack(storedBuffer!) as typeof ANIME_ROW[];
    expect(roundTripped).toEqual([ANIME_ROW]);
    expect(roundTripped).toHaveLength(1);
    expect(roundTripped[0].name).toBe('Anime');
    expect(roundTripped[0].count).toBe(0);
    expect(roundTripped[0].unfeatured).toBe(false);
  });

  it('serves a msgpackr-codec round-tripped result on the cache HIT path', async () => {
    // First call populates the cache (packed Buffer); the second is served purely from the
    // unpacked Buffer — this asserts the HIT path itself is byte-identical post-serializer.
    dbReadQueryRaw.mockResolvedValue([ANIME_ROW]);
    await getTagWithModelCount({ name: 'Anime' }); // populate

    const hit = await getTagWithModelCount({ name: 'Anime' }); // served from unpack(Buffer)
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    expect(hit).toEqual([{ id: 7, name: 'Anime', unfeatured: false, count: 0 }]);
    expect(hit[0].name).toBe('Anime'); // stored case survived pack -> unpack
    expect(hit[0].count).toBe(0);
    expect(hit[0].unfeatured).toBe(false);
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

  it('still returns the DB result when the Redis WRITE (populate) throws', async () => {
    // Cache miss -> origin query succeeds -> the best-effort cache SET fails. The SET catch
    // must swallow it so a Redis write outage never breaks the request.
    redisPackedGet.mockResolvedValueOnce(null); // miss
    redisPackedSet.mockRejectedValueOnce(new Error('redis write down'));
    dbReadQueryRaw.mockResolvedValue([ANIME_ROW]);

    const result = await getTagWithModelCount({ name: 'Anime' });
    expect(result).toEqual([ANIME_ROW]); // request succeeds despite the write failure
    expect(redisPackedSet).toHaveBeenCalledTimes(1); // it was attempted
  });
});
