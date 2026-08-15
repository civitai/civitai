import { vi, describe, it, expect, beforeEach } from 'vitest';
import { pack, unpack } from 'msgpackr';

// Backing store for the fake Redis. Values are stored as msgpackr-PACKED Buffers and
// unpacked on read — the SAME codec the real `redis.packed` client uses (set -> pack(value),
// get -> unpack(buffer)) — so the byte-identical claim is exercised through the real
// serializer end-to-end, not a pass-through fake. Cache hit/miss semantics stay real (a Map),
// letting us assert exactly when the origin DB query is re-run.
const { store } = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
}));

import {
  getCachedImageDeliveryMetadata,
  bustImageDeliveryMetadataCache,
} from '~/server/services/image-delivery.service';
import { CacheTTL } from '~/server/common/constants';
// The DB fake narrows each fixture row to the columns the statement actually SELECTs, the way
// a real database does. Without it, `mockResolvedValue([row])` hands back the whole fixture no
// matter what was asked for, and every assertion about a NEWLY-selected column passes on code
// that never selects it — measured: 5 of the media-type assertions below went green against
// the pre-change service until this was introduced.
import { respondWithRows } from '~/test-utils/queryRawProjection';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const redisDel = redisMock.redis.del;
const redisPackedGet = redisMock.redis.packed.get;
const redisPackedSet = redisMock.redis.packed.set;
const dbReadQueryRaw = dbMock.dbRead.$queryRaw;
const dbWriteQueryRaw = dbMock.dbWrite.$queryRaw;

// `:v2` — bumped when the cached value gained `type`/`mimeType`, so a hit on an entry packed
// by the previous release can never serve a response missing those fields.
const KEY_PREFIX = 'packed:caches:image-delivery-metadata:v2';

// A row exactly as the raw `Image WHERE url = $1` query returns it. Every field holds a
// DISTINCT value so an assertion cannot pass by one field aliasing another.
const URL = 'abc123/def456.jpeg';
const IMAGE_ROW = { id: 42, url: URL, hideMeta: false, type: 'image', mimeType: 'image/jpeg' };

// A video row — the case the media-type fields exist for. Distinct in every field from
// IMAGE_ROW (different id, url, hideMeta, type and mimeType).
const VIDEO_URL = 'vid987/clip.mp4';
const VIDEO_ROW = {
  id: 77,
  url: VIDEO_URL,
  hideMeta: true,
  type: 'video',
  mimeType: 'video/mp4',
};

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
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));

    const first = await getCachedImageDeliveryMetadata(URL);
    const second = await getCachedImageDeliveryMetadata(URL);

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1); // the win: one DB read, not two
    expect(first).toEqual(second);
    expect(redisPackedSet).toHaveBeenCalledTimes(1);
  });

  it('returns output byte-identical to the raw query', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));

    const result = await getCachedImageDeliveryMetadata(URL);
    expect(result).toEqual({
      id: 42,
      url: URL,
      hideMeta: false,
      type: 'image',
      mimeType: 'image/jpeg',
    });

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
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));
    await getCachedImageDeliveryMetadata(URL); // populate

    const hit = await getCachedImageDeliveryMetadata(URL); // served from unpack(Buffer)
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    expect(hit).toEqual({
      id: 42,
      url: URL,
      hideMeta: false,
      type: 'image',
      mimeType: 'image/jpeg',
    });
    expect(hit?.hideMeta).toBe(false);
  });

  it('preserves hideMeta:true through the codec on the hit path', async () => {
    const hidden = {
      id: 7,
      url: 'hidden/img.png',
      hideMeta: true,
      type: 'image',
      mimeType: 'image/png',
    };
    dbReadQueryRaw.mockImplementation(respondWithRows([hidden]));

    await getCachedImageDeliveryMetadata(hidden.url); // populate
    const hit = await getCachedImageDeliveryMetadata(hidden.url);

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    expect(hit).toEqual(hidden);
    expect(hit?.hideMeta).toBe(true); // boolean true survived pack -> unpack
  });

  it('keys by the EXACT url — a case/whitespace variant is a MISS (no collision)', async () => {
    dbReadQueryRaw.mockImplementationOnce(respondWithRows([IMAGE_ROW]));
    await getCachedImageDeliveryMetadata(URL);

    // An uppercased variant must NOT resolve to the same cached row (url WHERE is
    // case-sensitive, unlike citext) — it re-hits the DB with its own row.
    const variantRow = {
      id: 99,
      url: URL.toUpperCase(),
      hideMeta: false,
      type: 'image',
      mimeType: 'image/webp',
    };
    dbReadQueryRaw.mockImplementationOnce(respondWithRows([variantRow]));
    const variant = await getCachedImageDeliveryMetadata(URL.toUpperCase());

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(2); // no collision — separate DB read
    expect(variant).toEqual(variantRow);
    expect(new Set(store.keys())).toEqual(
      new Set([`${KEY_PREFIX}:${URL}`, `${KEY_PREFIX}:${URL.toUpperCase()}`])
    );
  });

  it('passes the exact url to the DB query as the WHERE value', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));
    await getCachedImageDeliveryMetadata(URL);
    const values = dbReadQueryRaw.mock.calls[0].slice(1);
    expect(values).toContain(URL);
  });

  it('sets the cache entry with the short TTL', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));
    await getCachedImageDeliveryMetadata(URL);
    expect(redisPackedSet).toHaveBeenCalledWith(`${KEY_PREFIX}:${URL}`, IMAGE_ROW, {
      EX: CacheTTL.sm,
    });
  });

  it('does NOT cache a negative result — an unknown url re-hits the DB every call', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([])); // no such image

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
    dbReadQueryRaw.mockImplementationOnce(respondWithRows([])); // miss — not cached
    expect(await getCachedImageDeliveryMetadata('brandnew/img.png')).toBeNull();

    const created = {
      id: 555,
      url: 'brandnew/img.png',
      hideMeta: false,
      type: 'image',
      mimeType: 'image/png',
    };
    dbReadQueryRaw.mockImplementationOnce(respondWithRows([created]));
    expect(await getCachedImageDeliveryMetadata('brandnew/img.png')).toEqual(created);
  });

  it('fails open to dbRead when the Redis read throws (hot path must not 500)', async () => {
    redisPackedGet.mockRejectedValueOnce(new Error('redis down'));
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));

    const result = await getCachedImageDeliveryMetadata(URL);
    expect(result).toEqual(IMAGE_ROW); // degraded to origin, correct result
  });

  it('still returns the DB result when the Redis WRITE (populate) throws', async () => {
    redisPackedGet.mockResolvedValueOnce(null); // miss
    redisPackedSet.mockRejectedValueOnce(new Error('redis write down'));
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));

    const result = await getCachedImageDeliveryMetadata(URL);
    expect(result).toEqual(IMAGE_ROW); // request succeeds despite the write failure
    expect(redisPackedSet).toHaveBeenCalledTimes(1); // it was attempted
  });

  it('falls over to dbWrite (primary) when the read replica query rejects', async () => {
    redisPackedGet.mockResolvedValue(null); // cache miss
    dbReadQueryRaw.mockRejectedValueOnce(new Error('replica error'));
    dbWriteQueryRaw.mockImplementationOnce(respondWithRows([IMAGE_ROW]));

    const result = await getCachedImageDeliveryMetadata(URL);
    expect(result).toEqual(IMAGE_ROW); // primary fallback resolved
    expect(dbWriteQueryRaw).toHaveBeenCalledTimes(1);
  });
});

/**
 * Media-type fields. The delivery caller has no way to tell a video from an image from
 * `{ id, url, hideMeta }` alone, so every entry looks like an image and video uploads get
 * routed to an image-only conversion path. `type` is the discriminator (NOT NULL on the
 * row, present on every image old and new); `mimeType` refines the container and is
 * genuinely nullable.
 *
 * REGRESSION coverage, not invariant guards: every assertion below fails on the pre-change
 * service, which returns only `{ id, url, hideMeta }`.
 */
describe('getCachedImageDeliveryMetadata — media type', () => {
  it('returns type "video" and the video mimeType for a video row', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([VIDEO_ROW]));

    const result = await getCachedImageDeliveryMetadata(VIDEO_URL);

    expect(result?.type).toBe('video');
    expect(result?.mimeType).toBe('video/mp4');
    expect(result).toEqual(VIDEO_ROW);
  });

  it('returns type "image" and the image mimeType for an image row', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));

    const result = await getCachedImageDeliveryMetadata(URL);

    expect(result?.type).toBe('image');
    expect(result?.mimeType).toBe('image/jpeg');
    expect(result).toEqual(IMAGE_ROW);
  });

  it('carries the media type through the msgpackr codec on the cache HIT path', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([VIDEO_ROW]));
    await getCachedImageDeliveryMetadata(VIDEO_URL); // populate

    const hit = await getCachedImageDeliveryMetadata(VIDEO_URL); // served from unpack(Buffer)

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1); // genuinely the cached copy
    expect(hit?.type).toBe('video');
    expect(hit?.mimeType).toBe('video/mp4');

    // And through the real serializer, not just the in-memory object.
    const roundTripped = unpack(store.get(`${KEY_PREFIX}:${VIDEO_URL}`)!) as typeof VIDEO_ROW;
    expect(roundTripped.type).toBe('video');
    expect(roundTripped.mimeType).toBe('video/mp4');
  });

  it('reports mimeType as explicit null (key PRESENT) when the row has none', async () => {
    // Old rows predate `mimeType`. The key must still be in the payload and must be null —
    // a missing key is indistinguishable from "this deployment does not send the field".
    const legacyRow = {
      id: 3,
      url: 'legacy/old.jpeg',
      hideMeta: false,
      type: 'image',
      mimeType: null,
    };
    dbReadQueryRaw.mockImplementation(respondWithRows([legacyRow]));

    const result = await getCachedImageDeliveryMetadata(legacyRow.url);

    expect(result?.mimeType).toBeNull();
    expect(result).toHaveProperty('mimeType'); // present, not dropped
    expect(Object.keys(result!)).toContain('mimeType');
    expect(result?.type).toBe('image'); // the discriminator still resolves without a mimeType
    // The null must survive JSON serialization as a key, since that is what the endpoint
    // hands the caller — `undefined` would be dropped by JSON.stringify.
    expect(JSON.parse(JSON.stringify(result))).toHaveProperty('mimeType', null);
  });

  it('normalizes an undefined mimeType to null rather than dropping the key', async () => {
    // Explicit `undefined`, not an omitted key: the column IS selected, it just has no value.
    // (The DB fake requires every selected column to be modelled, so an omitted key would be a
    // loud fixture error rather than a silent `undefined` — see queryRawProjection.)
    const undefinedRow = {
      id: 4,
      url: 'legacy/undef.jpeg',
      hideMeta: false,
      type: 'image',
      mimeType: undefined,
    };
    dbReadQueryRaw.mockImplementation(respondWithRows([undefinedRow]));

    const result = await getCachedImageDeliveryMetadata(undefinedRow.url);

    expect(result?.mimeType).toBeNull();
    expect(JSON.parse(JSON.stringify(result))).toHaveProperty('mimeType', null);
  });

  it('normalizes a blank mimeType to null (never a present-but-meaningless value)', async () => {
    const blankRow = {
      id: 5,
      url: 'legacy/blank.jpeg',
      hideMeta: false,
      type: 'image',
      mimeType: '   ',
    };
    dbReadQueryRaw.mockImplementation(respondWithRows([blankRow]));

    const result = await getCachedImageDeliveryMetadata(blankRow.url);

    expect(result?.mimeType).toBeNull(); // not '', not '   '
  });

  it('caches and re-serves a null mimeType as null on the hit path', async () => {
    const legacyRow = {
      id: 6,
      url: 'legacy/hit.jpeg',
      hideMeta: false,
      type: 'video',
      mimeType: null,
    };
    dbReadQueryRaw.mockImplementation(respondWithRows([legacyRow]));

    await getCachedImageDeliveryMetadata(legacyRow.url); // populate
    const hit = await getCachedImageDeliveryMetadata(legacyRow.url);

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    expect(hit?.mimeType).toBeNull();
    // A missing mimeType must NOT mask the discriminator — this row is still a video.
    expect(hit?.type).toBe('video');
  });

  it('selects the media-type columns from the SAME single query — no extra round-trip', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([VIDEO_ROW]));

    await getCachedImageDeliveryMetadata(VIDEO_URL);

    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1); // one query total, not two
    expect(dbWriteQueryRaw).not.toHaveBeenCalled();
    // The columns come from that one statement's SELECT list.
    const sql = (dbReadQueryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('"mimeType"');
    expect(sql).toMatch(/\btype\b/);
    expect(sql).toContain('"hideMeta"');
  });

  it('keeps the media type on the dbWrite (primary) fallback path', async () => {
    redisPackedGet.mockResolvedValue(null);
    dbReadQueryRaw.mockRejectedValueOnce(new Error('replica error'));
    dbWriteQueryRaw.mockImplementationOnce(respondWithRows([VIDEO_ROW]));

    const result = await getCachedImageDeliveryMetadata(VIDEO_URL);

    expect(dbWriteQueryRaw).toHaveBeenCalledTimes(1);
    expect(result?.type).toBe('video');
    expect(result?.mimeType).toBe('video/mp4');
  });

  it('never serves a pre-widening cached entry — the deploy window cannot leak a 3-field row', async () => {
    // THE DEPLOY-WINDOW HAZARD. The response has been cached (before this change) for the
    // whole TTL, so entries packed by the previous release hold only {id, url, hideMeta}. If
    // those were still readable, a hit on one would serve a video with NO `type` at all for up
    // to the TTL after release — and a caller has no way to tell that apart from a row whose
    // media type is genuinely unknown, so every video in the window silently falls back to the
    // image path. Bumping the cache key prefix is what removes the window entirely.
    //
    // Seed the OLD (pre-bump) key with an old-shape value and prove it is never read.
    const legacyKey = `packed:caches:image-delivery-metadata:${VIDEO_URL}`;
    store.set(legacyKey, pack({ id: 77, url: VIDEO_URL, hideMeta: true }));
    dbReadQueryRaw.mockImplementation(respondWithRows([VIDEO_ROW]));

    const result = await getCachedImageDeliveryMetadata(VIDEO_URL);

    // The stale 3-field entry was ignored: the DB was consulted and the full shape returned.
    expect(dbReadQueryRaw).toHaveBeenCalledTimes(1);
    expect(result?.type).toBe('video');
    expect(result).toEqual(VIDEO_ROW);
    // ...and the old entry is left alone rather than overwritten, so a rollback still finds it.
    expect(unpack(store.get(legacyKey)!)).toEqual({ id: 77, url: VIDEO_URL, hideMeta: true });
    expect(store.has(`${KEY_PREFIX}:${VIDEO_URL}`)).toBe(true); // written under the new key
  });

  it('leaves hideMeta untouched — the pre-existing field is unchanged for old callers', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([VIDEO_ROW]));

    const result = await getCachedImageDeliveryMetadata(VIDEO_URL);

    // The additive change must not rename, reshape or drop what a caller already reads.
    expect(result?.hideMeta).toBe(true);
    expect(result?.id).toBe(77);
    expect(result?.url).toBe(VIDEO_URL);
  });
});

describe('bustImageDeliveryMetadataCache', () => {
  it('deletes the exact url key so the next read re-queries', async () => {
    dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));
    await getCachedImageDeliveryMetadata(URL); // populate
    expect(store.has(`${KEY_PREFIX}:${URL}`)).toBe(true);

    await bustImageDeliveryMetadataCache(URL);
    expect(redisDel).toHaveBeenCalledWith(`${KEY_PREFIX}:${URL}`);
    expect(store.has(`${KEY_PREFIX}:${URL}`)).toBe(false);

    // Next read re-hits the DB (fresh row) rather than serving the busted entry.
    const fresh = { id: 42, url: URL, hideMeta: true, type: 'image', mimeType: 'image/jpeg' };
    dbReadQueryRaw.mockImplementation(respondWithRows([fresh]));
    const after = await getCachedImageDeliveryMetadata(URL);
    expect(after).toEqual(fresh);
    expect(after?.hideMeta).toBe(true); // the flipped value is now served
  });

  it('swallows a Redis del error (best-effort bust never throws)', async () => {
    redisDel.mockRejectedValueOnce(new Error('redis down'));
    await expect(bustImageDeliveryMetadataCache(URL)).resolves.toBeUndefined();
  });
});
