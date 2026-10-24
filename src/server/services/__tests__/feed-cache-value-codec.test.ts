import { describe, expect, it, vi } from 'vitest';
import { createCache } from '../../../../event-engine-common/caches/base';
import { userData } from '../../../../event-engine-common/caches/userData.cache';
import type {
  IClickhouseClient,
  IRedisClient,
} from '../../../../event-engine-common/types/package-stubs';

/**
 * REGRESSION GUARD for civitai#4768 (reported downstream as civitai/cli#513).
 *
 * `/api/v1/images?username=<all-digit-name>` emitted `username` as a bare JSON
 * NUMBER, and for a name with a leading zero it emitted a DIFFERENT name:
 * `0222` came back as `222`, which round-trips to no account at all.
 *
 * The coercion is NOT in Meilisearch and NOT at the endpoint. It is in the feed's
 * Redis entity cache. A Redis hash stores only strings, so `createCache`
 * serialises every field on write and de-serialises it on read — and the read
 * used to GUESS the type back:
 *
 *     item[key] = isNaN(Number(value)) ? value : Number(value);
 *
 * `username` is a string that can be all digits (`usernameSchema` is
 * `/^[A-Za-z0-9_]*$/`), so this is legal data, not bad data. The REST endpoint's
 * legacy Prisma branch never goes through this cache, which is exactly why
 * `?imageId=` was quoted while `?username=` was not.
 *
 * These tests drive the REAL `createCache` against a fake Redis and assert the
 * property that matters: whatever the fetcher produced is what a cache HIT
 * returns. Fixture values are pairwise distinct so no assertion can pass by
 * collapsing onto a neighbour's value or onto a constant it names itself.
 */

type Row = {
  userId: number;
  username: string;
  altName: string;
  bio: string;
  nsfw: boolean;
  deletedAt: string | null;
  image: string;
  tags: number[];
  meta: { weight: number };
};

/** A user whose real name is all digits WITH a leading zero — the worst case. */
const ROW: Row = {
  userId: 4768,
  username: '0222',
  altName: '2428023993',
  bio: '',
  nsfw: false,
  deletedAt: null,
  image: 'avatar-7f3a',
  tags: [3, 9],
  meta: { weight: 51 },
};

const FIELD_TYPES = {
  userId: 'number',
  username: 'string',
  altName: 'string',
  bio: 'string',
  nsfw: 'boolean',
  deletedAt: 'date?',
  image: 'string',
  tags: 'json',
  meta: 'json',
} as const;

type FakeRedis = IRedisClient & {
  __hashes: Map<string, Record<string, string>>;
  __strings: Map<string, string>;
  __hGetAllCalls: number;
};

function makeFakeRedis(opts: { hideFirstRead?: boolean } = {}): FakeRedis {
  const hashes = new Map<string, Record<string, string>>();
  const strings = new Map<string, string>();
  const client = {
    __hashes: hashes,
    __strings: strings,
    __hGetAllCalls: 0,
    async hGetAll(key: string) {
      client.__hGetAllCalls += 1;
      if (opts.hideFirstRead && client.__hGetAllCalls === 1) return {};
      return { ...(hashes.get(key) ?? {}) };
    },
    async hSet(key: string, fields: Record<string, string>) {
      const current = hashes.get(key) ?? {};
      Object.assign(current, fields);
      hashes.set(key, current);
      return 1;
    },
    async expire() {
      return 1;
    },
    async set(key: string, value: string, options?: { NX?: boolean; EX?: number }) {
      if (options?.NX && strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    },
    async del(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        strings.delete(key);
        hashes.delete(key);
      }
      return list.length;
    },
  } as unknown as FakeRedis;
  return client;
}

const noopPg = { query: async () => [] } as unknown as {
  query: <T>(q: string, p?: any[]) => Promise<T[]>;
};
const noopCh = noopPg as unknown as IClickhouseClient & typeof noopPg;

function makeCache(rows: Row[], redisKey: string) {
  const fetcher = vi.fn(async () => rows);
  const cache = createCache<Row>({
    redisKey,
    idKey: 'userId',
    fieldTypes: FIELD_TYPES,
    fetch: fetcher,
  });
  return { cache, fetcher };
}

function ctxFor(redis: FakeRedis) {
  return { redis, pg: noopPg, ch: noopCh } as any;
}

describe('createCache value codec — civitai#4768 numeric-username coercion', () => {
  it('POSITIVE CONTROL: the second read is served from Redis, so the decode path really runs', async () => {
    const redis = makeFakeRedis();
    const { cache, fetcher } = makeCache([ROW], 'codec:control');

    const miss = await cache.fetch(ctxFor(redis), [ROW.userId]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The miss returns the fetcher's own object untouched — it proves nothing
    // about the codec, which is why every assertion below reads the SECOND call.
    expect(miss[ROW.userId].username).toBe('0222');

    // Something was actually written to Redis. Without this, a cache that stored
    // nothing would make every "hit" below a silent re-fetch and the whole file
    // would pass while testing no decode at all.
    expect(redis.__hashes.get(`codec:control:${ROW.userId}`)).toBeDefined();

    const hit = await cache.fetch(ctxFor(redis), [ROW.userId]);
    expect(fetcher).toHaveBeenCalledTimes(1); // no second fetch => served from cache
    expect(hit[ROW.userId]).toBeDefined();
  });

  it('keeps an all-digit username with a leading zero as the SAME string', async () => {
    const redis = makeFakeRedis();
    const { cache } = makeCache([ROW], 'codec:leading-zero');

    await cache.fetch(ctxFor(redis), [ROW.userId]);
    const hit = await cache.fetch(ctxFor(redis), [ROW.userId]);

    expect(hit[ROW.userId].username).toBe('0222');
    expect(typeof hit[ROW.userId].username).toBe('string');
  });

  it('keeps an all-digit username WITHOUT a leading zero as a string, not a number', async () => {
    const redis = makeFakeRedis();
    const { cache } = makeCache([ROW], 'codec:all-digit');

    await cache.fetch(ctxFor(redis), [ROW.userId]);
    const hit = await cache.fetch(ctxFor(redis), [ROW.userId]);

    expect(hit[ROW.userId].altName).toBe('2428023993');
    expect(typeof hit[ROW.userId].altName).toBe('string');
  });

  it('round-trips every field type the caches actually store', async () => {
    const redis = makeFakeRedis();
    const { cache } = makeCache([ROW], 'codec:round-trip');

    await cache.fetch(ctxFor(redis), [ROW.userId]);
    const hit = await cache.fetch(ctxFor(redis), [ROW.userId]);

    // Numbers stay numbers (INVARIANT GUARD — this held before the fix too; it
    // is here so an over-correction that stringified everything is caught).
    expect(hit[ROW.userId].userId).toBe(4768);
    // `false` used to come back as the STRING 'false', which is truthy.
    expect(hit[ROW.userId].nsfw).toBe(false);
    // `null` used to come back as the STRING 'null', which is truthy — and
    // `deletedAt` is branched on with `!!user.deletedAt` by several consumers.
    expect(hit[ROW.userId].deletedAt).toBeNull();
    // An empty string used to come back as the NUMBER 0, because Number('') is 0.
    expect(hit[ROW.userId].bio).toBe('');
    // Non-numeric strings were never affected (INVARIANT GUARD).
    expect(hit[ROW.userId].image).toBe('avatar-7f3a');
    // Arrays/objects round-trip (INVARIANT GUARD for the uncontended read path).
    expect(hit[ROW.userId].tags).toEqual([3, 9]);
    expect(hit[ROW.userId].meta).toEqual({ weight: 51 });
  });

  it('decodes arrays on the CONTENDED read path, not just the uncontended one', async () => {
    // The lock-contention retry loop had its OWN copy of the decoder, and that
    // copy lacked the array/object branch entirely — so a cached `tags` array
    // came back as the raw string '[3,9]' and every `Array.isArray` check on it
    // silently saw `false`. Consolidating the two decoders is what fixes this.
    const redis = makeFakeRedis({ hideFirstRead: true });
    const key = 'codec:contended';
    const { cache, fetcher } = makeCache([ROW], key);

    // Warm the hash the way a real writer would (through the cache itself), then
    // hand the next reader a HELD lock so it takes the retry path.
    const warm = makeFakeRedis();
    await cache.fetch(ctxFor(warm), [ROW.userId]);
    const stored = warm.__hashes.get(`${key}:${ROW.userId}`);
    expect(stored).toBeDefined();
    redis.__hashes.set(`${key}:${ROW.userId}`, { ...(stored as Record<string, string>) });
    redis.__strings.set(`lock:${key}:${ROW.userId}`, '1'); // someone else holds it

    fetcher.mockClear();
    const hit = await cache.fetch(ctxFor(redis), [ROW.userId]);

    expect(fetcher).not.toHaveBeenCalled(); // proves the retry path served it
    expect(hit[ROW.userId].tags).toEqual([3, 9]);
    expect(hit[ROW.userId].username).toBe('0222');
    expect(hit[ROW.userId].meta).toEqual({ weight: 51 });
  });

  it('repairs entries ALREADY in Redis, with no re-write and no migration', async () => {
    // The stored bytes were never wrong — `0222` is in the hash as `0222`; only
    // the read destroyed it. This is why the fix declares field types instead of
    // re-encoding: an entry written by a process running the OLD code decodes
    // correctly on the FIRST read, so there is no TTL to wait out, no cold cache
    // and no window in which two deployed versions disagree about the format.
    const redis = makeFakeRedis();
    const key = 'codec:pre-existing';
    const { cache, fetcher } = makeCache([ROW], key);

    redis.__hashes.set(`${key}:${ROW.userId}`, {
      cachedAt: new Date().toISOString(),
      userId: '4768',
      username: '0222',
      altName: '2428023993',
      bio: '',
      nsfw: 'false',
      deletedAt: 'null',
      image: 'avatar-7f3a',
      tags: '[3,9]',
      meta: '{"weight":51}',
    });

    const hit = await cache.fetch(ctxFor(redis), [ROW.userId]);
    expect(fetcher).not.toHaveBeenCalled(); // decoded straight out of the old hash

    expect(hit[ROW.userId].username).toBe('0222');
    expect(hit[ROW.userId].altName).toBe('2428023993');
    expect(hit[ROW.userId].userId).toBe(4768);
    expect(hit[ROW.userId].nsfw).toBe(false);
    expect(hit[ROW.userId].deletedAt).toBeNull();
    expect(hit[ROW.userId].bio).toBe('');
    expect(hit[ROW.userId].tags).toEqual([3, 9]);
  });

  it('a field with no declaration no longer destroys leading zeros', async () => {
    // Fallback path: a stale hash field left behind by a removed column has no
    // declaration. It still gets the type guess, but only when the text is the
    // CANONICAL rendering of the number — `String(222)` can never produce the
    // text '0222', so '0222' was never a number.
    const redis = makeFakeRedis();
    const key = 'codec:undeclared';
    const { cache, fetcher } = makeCache([ROW], key);

    redis.__hashes.set(`${key}:${ROW.userId}`, {
      cachedAt: new Date().toISOString(),
      userId: '4768',
      username: '0222',
      altName: '2428023993',
      bio: '',
      nsfw: 'false',
      deletedAt: 'null',
      image: 'avatar-7f3a',
      tags: '[3,9]',
      meta: '{"weight":51}',
      legacyPaddedCode: '0077', // no declaration
      legacyCount: '42', // no declaration
    });

    const hit = (await cache.fetch(ctxFor(redis), [ROW.userId]))[ROW.userId] as unknown as Record<
      string,
      unknown
    >;
    expect(fetcher).not.toHaveBeenCalled();

    expect(hit.legacyPaddedCode).toBe('0077');
    // A canonical number is still recovered as one (INVARIANT GUARD).
    expect(hit.legacyCount).toBe(42);
  });
});

describe('the userData cache declares username as a string', () => {
  // A BEHAVIOURAL check on the real cache object, not a spelling check: the
  // shipped `userData` config is what the images feed uses to build
  // `user.username`, and it is the one declaration whose absence caused #4768.
  it('never infers a type for username', async () => {
    const redis = makeFakeRedis();
    const rows = [{ userId: 4768, username: '0222', image: null, deletedAt: null }];
    const pg = { query: vi.fn(async () => rows) } as any;
    const ctx = { redis, pg, ch: noopCh } as any;

    await userData.fetch(ctx, [4768]);
    const hit = await userData.fetch(ctx, [4768]);

    expect(pg.query).toHaveBeenCalledTimes(1); // second read came from Redis
    expect(hit[4768].username).toBe('0222');
    expect(typeof hit[4768].username).toBe('string');
  });
});
