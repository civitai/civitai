import { describe, expect, it, vi } from 'vitest';
import type { StalePackedClient } from '~/server/meilisearch/image-search-stale-cache';
import {
  MEILI_STALE_MAX_AGE_MS,
  MEILI_STALE_MAX_AGE_SECONDS,
  buildImageSearchStaleKey,
  readImageSearchStale,
  staleServeOnError,
  writeImageSearchStale,
} from '~/server/meilisearch/image-search-stale-cache';

// A minimal in-memory fake of the packed redis surface the module uses. Stores
// the exact { value, cachedAt } envelope writeImageSearchStale produces so read
// and write can be exercised end-to-end without a real redis.
function makeFakeRedis() {
  const store = new Map<string, unknown>();
  const client: StalePackedClient & { store: Map<string, unknown> } = {
    store,
    packed: {
      get: vi.fn(async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null)),
      set: vi.fn(async <T>(key: string, value: T) => {
        store.set(key, value);
      }),
    },
  };
  return client;
}

// Two Meili filter strings that differ ONLY in the nsfwLevel IN [...] clause —
// i.e. two different browsing levels. Everything else identical. This is the
// exact vector the cache key must keep separate to avoid an NSFW leak.
const FILTER_PG = 'postId IS NOT NULL AND (nsfwLevel IN [1] OR (nsfwLevel = 0))';
const FILTER_NSFW = 'postId IS NOT NULL AND (nsfwLevel IN [1,2,4,8,16] OR (nsfwLevel = 0))';
const BASE_PARTS = {
  index: 'metrics_images_v1',
  filter: FILTER_PG,
  sort: ['sortAt:desc'] as string[],
  limit: 101,
  offset: 0,
};

describe('buildImageSearchStaleKey', () => {
  it('is deterministic for identical request parts', () => {
    expect(buildImageSearchStaleKey(BASE_PARTS)).toBe(buildImageSearchStaleKey({ ...BASE_PARTS }));
  });

  it('is prefixed with the dedicated cache namespace', () => {
    expect(buildImageSearchStaleKey(BASE_PARTS)).toMatch(/^packed:caches:image-search-stale:/);
  });

  it('SECURITY: a different browsingLevel (nsfwLevel filter) yields a different key', () => {
    const pgKey = buildImageSearchStaleKey({ ...BASE_PARTS, filter: FILTER_PG });
    const nsfwKey = buildImageSearchStaleKey({ ...BASE_PARTS, filter: FILTER_NSFW });
    expect(pgKey).not.toBe(nsfwKey);
  });

  it('SECURITY: an added per-user own-carve-out clause yields a different key', () => {
    // The logged-in own-carve-out appends `OR "userId" = <id>` into the filter.
    // Two different users (or anon vs user) must never share a stale entry.
    const anon = buildImageSearchStaleKey({ ...BASE_PARTS, filter: FILTER_PG });
    const user123 = buildImageSearchStaleKey({
      ...BASE_PARTS,
      filter: `${FILTER_PG} AND ((NOT availability = Private) OR "userId" = 123)`,
    });
    const user456 = buildImageSearchStaleKey({
      ...BASE_PARTS,
      filter: `${FILTER_PG} AND ((NOT availability = Private) OR "userId" = 456)`,
    });
    expect(new Set([anon, user123, user456]).size).toBe(3);
  });

  it('differs on sort, limit, offset, and index', () => {
    const base = buildImageSearchStaleKey(BASE_PARTS);
    expect(buildImageSearchStaleKey({ ...BASE_PARTS, sort: ['reactionCount:desc'] })).not.toBe(base);
    expect(buildImageSearchStaleKey({ ...BASE_PARTS, limit: 51 })).not.toBe(base);
    expect(buildImageSearchStaleKey({ ...BASE_PARTS, offset: 100 })).not.toBe(base);
    expect(buildImageSearchStaleKey({ ...BASE_PARTS, index: 'other_index' })).not.toBe(base);
  });
});

describe('readImageSearchStale / writeImageSearchStale', () => {
  const key = buildImageSearchStaleKey(BASE_PARTS);
  const value = { data: [{ id: 1 }], nextCursor: 42 };

  it('round-trips a written value that is within the stale bound', async () => {
    const redis = makeFakeRedis();
    const now = 1_000_000;
    writeImageSearchStale(redis, key, value, now);
    await Promise.resolve(); // let the fire-and-forget set settle
    const read = await readImageSearchStale<typeof value>(redis, key, now + 1000);
    expect(read).toEqual(value);
    // stored with the EX bound
    expect(redis.packed.set).toHaveBeenCalledWith(
      key,
      { value, cachedAt: now },
      { EX: MEILI_STALE_MAX_AGE_SECONDS }
    );
  });

  it('returns null when the entry is older than the stale bound', async () => {
    const redis = makeFakeRedis();
    const now = 1_000_000;
    writeImageSearchStale(redis, key, value, now);
    await Promise.resolve();
    const read = await readImageSearchStale<typeof value>(
      redis,
      key,
      now + MEILI_STALE_MAX_AGE_MS + 1
    );
    expect(read).toBeNull();
  });

  it('serves right up to the bound but not past it', async () => {
    const redis = makeFakeRedis();
    const now = 5_000_000;
    writeImageSearchStale(redis, key, value, now);
    await Promise.resolve();
    expect(await readImageSearchStale(redis, key, now + MEILI_STALE_MAX_AGE_MS)).toEqual(value);
    expect(await readImageSearchStale(redis, key, now + MEILI_STALE_MAX_AGE_MS + 1)).toBeNull();
  });

  it('returns null when nothing is cached', async () => {
    const redis = makeFakeRedis();
    expect(await readImageSearchStale(redis, key)).toBeNull();
  });

  it('returns null (never throws) when the redis read fails', async () => {
    const redis = makeFakeRedis();
    redis.packed.get = vi.fn(async () => {
      throw new Error('redis down');
    });
    await expect(readImageSearchStale(redis, key)).resolves.toBeNull();
  });

  it('write never rejects even if the underlying set throws', async () => {
    const redis = makeFakeRedis();
    redis.packed.set = vi.fn(async () => {
      throw new Error('redis down');
    });
    // Must not throw synchronously nor create an unhandled rejection.
    expect(() => writeImageSearchStale(redis, key, value)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('staleServeOnError', () => {
  const liveValue = { data: [{ id: 1 }], nextCursor: 1 };
  const staleValue = { data: [{ id: 2 }], nextCursor: 2 };

  it('happy path: returns the LIVE value byte-identically, writes it, never reads stale', async () => {
    const read = vi.fn(async () => staleValue);
    const write = vi.fn();
    const onStaleServed = vi.fn();
    const result = await staleServeOnError({
      run: async () => liveValue,
      read,
      write,
      isRecoverable: () => true,
      onStaleServed,
    });
    expect(result).toBe(liveValue);
    expect(write).toHaveBeenCalledWith(liveValue);
    expect(read).not.toHaveBeenCalled();
    expect(onStaleServed).not.toHaveBeenCalled();
  });

  it('genuine empty result is returned as-is (not treated as a failure / not stale-served)', async () => {
    const empty = { data: [], nextCursor: undefined };
    const read = vi.fn(async () => staleValue);
    const onStaleServed = vi.fn();
    const result = await staleServeOnError({
      run: async () => empty,
      read,
      write: vi.fn(),
      isRecoverable: () => true,
      onStaleServed,
    });
    expect(result).toBe(empty);
    expect(read).not.toHaveBeenCalled();
    expect(onStaleServed).not.toHaveBeenCalled();
  });

  it('transient failure + fresh stale present → serves stale and increments the metric', async () => {
    const onStaleServed = vi.fn();
    const write = vi.fn();
    const result = await staleServeOnError({
      run: async () => {
        throw new Error('meili timeout');
      },
      read: async () => staleValue,
      write,
      isRecoverable: () => true,
      onStaleServed,
    });
    expect(result).toBe(staleValue);
    expect(onStaleServed).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('transient failure + stale absent/too old (read → null) → rethrows, no metric', async () => {
    const onStaleServed = vi.fn();
    const err = new Error('meili timeout');
    await expect(
      staleServeOnError({
        run: async () => {
          throw err;
        },
        read: async () => null,
        write: vi.fn(),
        isRecoverable: () => true,
        onStaleServed,
      })
    ).rejects.toBe(err);
    expect(onStaleServed).not.toHaveBeenCalled();
  });

  it('non-recoverable error rethrows WITHOUT consulting the stale cache', async () => {
    const read = vi.fn(async () => staleValue);
    const onStaleServed = vi.fn();
    const err = new Error('validation error');
    await expect(
      staleServeOnError({
        run: async () => {
          throw err;
        },
        read,
        write: vi.fn(),
        isRecoverable: () => false,
        onStaleServed,
      })
    ).rejects.toBe(err);
    expect(read).not.toHaveBeenCalled();
    expect(onStaleServed).not.toHaveBeenCalled();
  });

  it('rethrows the ORIGINAL error (not the read error) if the stale read itself throws', async () => {
    const err = new Error('meili timeout');
    const onStaleServed = vi.fn();
    await expect(
      staleServeOnError({
        run: async () => {
          throw err;
        },
        read: async () => {
          throw new Error('redis down');
        },
        write: vi.fn(),
        isRecoverable: () => true,
        onStaleServed,
      })
    ).rejects.toBe(err);
    expect(onStaleServed).not.toHaveBeenCalled();
  });
});
