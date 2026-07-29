import { vi, describe, it, expect, beforeEach } from 'vitest';
import { pack, unpack } from 'msgpackr';

// Backing store for the fake Redis. Values are stored as msgpackr-PACKED Buffers and
// unpacked on read — the SAME codec the real `redis.packed` client uses (set -> pack(value),
// get -> unpack(buffer)) — so the byte-identical claim is exercised through the real
// serializer end-to-end, not a pass-through fake. Cache hit/miss semantics stay real (a Map),
// letting us assert exactly when the origin DB query is re-run.
const { store, dbReadQueryRaw, dbWriteQueryRaw, redisPackedGet, redisPackedSet, redisDel } =
  vi.hoisted(() => ({
    store: new Map<string, Buffer>(),
    dbReadQueryRaw: vi.fn(),
    dbWriteQueryRaw: vi.fn(),
    redisPackedGet: vi.fn(),
    redisPackedSet: vi.fn(),
    redisDel: vi.fn(),
  }));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: dbReadQueryRaw },
  dbWrite: { $queryRaw: dbWriteQueryRaw },
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

import {
  getCachedImageDeliveryMetadata,
  bustImageDeliveryMetadataCache,
} from '~/server/services/image-delivery.service';
import { CacheTTL } from '~/server/common/constants';

const KEY_PREFIX = 'packed:caches:image-delivery-metadata';

// A row exactly as the raw `Image WHERE url = $1` query returns it.
const URL = 'abc123/def456.jpeg';
const IMAGE_ROW = { id: 42, url: URL, hideMeta: false };

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  // Real msgpackr round-trip: set packs to a Buffer, get unpacks — mirrors the production
  // redis.packed codec so serializer fidelity (number id, string url, boolean hideMeta) is
  // actually under test on the hit path.
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

describe('getCachedImageDeliveryMetadata — read-through cache', () => {
  it('serves the second call for the same url from cache without re-hitting the DB', async () => {
    dbReadQueryRaw.mockResolvedValue([IMAGE_ROW]);

    const first = await getCachedImageDeliveryMetadata(URL);
    const second = await getCachedImageDeliveryMetadata(URL);

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1); // the win: one DB read, not two
    expect(first).toEqual(second);
    expect(redisPackedSet).toHaveBeenCalledTimes(1);
  });

  it('returns output byte-identical to the raw query', async () => {
    dbReadQueryRaw.mockResolvedValue([IMAGE_ROW]);

    const result = await getCachedImageDeliveryMetadata(URL);
    expect(result).toEqual({ id: 42, url: URL, hideMeta: false });

    // Prove byte-identity THROUGH the real msgpackr codec: unpack the actual stored Buffer
    // and assert every field survives the serializer — number id, string url, boolean.
    const storedBuffer = store.get(`${KEY_PREFIX}:${URL}`);
    expect(Buffer.isBuffer(storedBuffer)).toBe(true);
    const roundTripped = unpack(storedBuffer!) as typeof IMAGE_ROW;
    expect(roundTripped).toEqual(IMAGE_ROW);
    expect(roundTripped.id).toBe(42);
    expect(roundTripped.url).toBe(URL);
    expect(roundTripped.hideMeta).toBe(false);
  });

  it('serves a msgpackr-codec round-tripped result on the cache HIT path', async () => {
    dbReadQueryRaw.mockResolvedValue([IMAGE_ROW]);
    await getCachedImageDeliveryMetadata(URL); // populate

    const hit = await getCachedImageDeliveryMetadata(URL); // served from unpack(Buffer)
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    expect(hit).toEqual({ id: 42, url: URL, hideMeta: false });
    expect(hit?.hideMeta).toBe(false);
  });

  it('preserves hideMeta:true through the codec on the hit path', async () => {
    const hidden = { id: 7, url: 'hidden/img.png', hideMeta: true };
    dbReadQueryRaw.mockResolvedValue([hidden]);

    await getCachedImageDeliveryMetadata(hidden.url); // populate
    const hit = await getCachedImageDeliveryMetadata(hidden.url);

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    expect(hit).toEqual(hidden);
    expect(hit?.hideMeta).toBe(true); // boolean true survived pack -> unpack
  });

  it('keys by the EXACT url — a case/whitespace variant is a MISS (no collision)', async () => {
    dbReadQueryRaw.mockResolvedValueOnce([IMAGE_ROW]);
    await getCachedImageDeliveryMetadata(URL);

    // An uppercased variant must NOT resolve to the same cached row (url WHERE is
    // case-sensitive, unlike citext) — it re-hits the DB with its own row.
    const variantRow = { id: 99, url: URL.toUpperCase(), hideMeta: false };
    dbReadQueryRaw.mockResolvedValueOnce([variantRow]);
    const variant = await getCachedImageDeliveryMetadata(URL.toUpperCase());

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(2); // no collision — separate DB read
    expect(variant).toEqual(variantRow);
    expect(new Set(store.keys())).toEqual(
      new Set([`${KEY_PREFIX}:${URL}`, `${KEY_PREFIX}:${URL.toUpperCase()}`])
    );
  });

  it('passes the exact url to the DB query as the WHERE value', async () => {
    dbReadQueryRaw.mockResolvedValue([IMAGE_ROW]);
    await getCachedImageDeliveryMetadata(URL);
    const values = dbReadQueryRaw.mock.calls[0].slice(1);
    expect(values).toContain(URL);
  });

  it('sets the cache entry with the short TTL', async () => {
    dbReadQueryRaw.mockResolvedValue([IMAGE_ROW]);
    await getCachedImageDeliveryMetadata(URL);
    expect(redisPackedSet).toHaveBeenCalledWith(`${KEY_PREFIX}:${URL}`, IMAGE_ROW, {
      EX: CacheTTL.sm,
    });
  });

  it('does NOT cache a negative result — an unknown url re-hits the DB every call', async () => {
    dbReadQueryRaw.mockResolvedValue([]); // no such image

    const first = await getCachedImageDeliveryMetadata('missing/url.jpg');
    const second = await getCachedImageDeliveryMetadata('missing/url.jpg');

    expect(first).toBeNull();
    expect(second).toBeNull();
    // Both calls hit the DB (no negative caching) so a newly-registered image is findable.
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(2);
    expect(redisPackedSet).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('becomes findable immediately after the image is registered (no stale negative)', async () => {
    dbReadQueryRaw.mockResolvedValueOnce([]); // miss — not cached
    expect(await getCachedImageDeliveryMetadata('brandnew/img.png')).toBeNull();

    const created = { id: 555, url: 'brandnew/img.png', hideMeta: false };
    dbReadQueryRaw.mockResolvedValueOnce([created]);
    expect(await getCachedImageDeliveryMetadata('brandnew/img.png')).toEqual(created);
  });

  it('fails open to dbRead when the Redis read throws (hot path must not 500)', async () => {
    redisPackedGet.mockRejectedValueOnce(new Error('redis down'));
    dbReadQueryRaw.mockResolvedValue([IMAGE_ROW]);

    const result = await getCachedImageDeliveryMetadata(URL);
    expect(result).toEqual(IMAGE_ROW); // degraded to origin, correct result
  });

  it('still returns the DB result when the Redis WRITE (populate) throws', async () => {
    redisPackedGet.mockResolvedValueOnce(null); // miss
    redisPackedSet.mockRejectedValueOnce(new Error('redis write down'));
    dbReadQueryRaw.mockResolvedValue([IMAGE_ROW]);

    const result = await getCachedImageDeliveryMetadata(URL);
    expect(result).toEqual(IMAGE_ROW); // request succeeds despite the write failure
    expect(redisPackedSet).toHaveBeenCalledTimes(1); // it was attempted
  });

  it('falls over to dbWrite (primary) when the read replica query rejects', async () => {
    redisPackedGet.mockResolvedValue(null); // cache miss
    dbReadQueryRaw.mockRejectedValueOnce(new Error('replica error'));
    dbWriteQueryRaw.mockResolvedValueOnce([IMAGE_ROW]);

    const result = await getCachedImageDeliveryMetadata(URL);
    expect(result).toEqual(IMAGE_ROW); // primary fallback resolved
    expect(dbWriteQueryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('bustImageDeliveryMetadataCache', () => {
  it('deletes the exact url key so the next read re-queries', async () => {
    dbReadQueryRaw.mockResolvedValue([IMAGE_ROW]);
    await getCachedImageDeliveryMetadata(URL); // populate
    expect(store.has(`${KEY_PREFIX}:${URL}`)).toBe(true);

    await bustImageDeliveryMetadataCache(URL);
    expect(redisDel).toHaveBeenCalledWith(`${KEY_PREFIX}:${URL}`);
    expect(store.has(`${KEY_PREFIX}:${URL}`)).toBe(false);

    // Next read re-hits the DB (fresh row) rather than serving the busted entry.
    const fresh = { id: 42, url: URL, hideMeta: true };
    dbReadQueryRaw.mockResolvedValue([fresh]);
    const after = await getCachedImageDeliveryMetadata(URL);
    expect(after).toEqual(fresh);
    expect(after?.hideMeta).toBe(true); // the flipped value is now served
  });

  it('swallows a Redis del error (best-effort bust never throws)', async () => {
    redisDel.mockRejectedValueOnce(new Error('redis down'));
    await expect(bustImageDeliveryMetadataCache(URL)).resolves.toBeUndefined();
  });
});
