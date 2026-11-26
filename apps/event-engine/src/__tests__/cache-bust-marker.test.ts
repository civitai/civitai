import { describe, expect, it, vi } from 'vitest';
import { createCache, type CacheContext } from '../common/caches/base';

type Row = { userId: number; url: string };

describe('a busted cache entry read while another request holds its lock', () => {
  it('is read from the source, not decoded from the bust marker', async () => {
    const marker = { debounce: '1', cachedAt: new Date().toISOString() };
    const redis = {
      hGetAll: vi.fn(async () => marker),
      // Another request holds the lock.
      set: vi.fn(async () => null),
      hSet: vi.fn(async () => 1),
      expire: vi.fn(async () => true),
      del: vi.fn(async () => 1),
    };
    const fetch = vi.fn(async (_ctx: CacheContext, ids: number[]) =>
      ids.map((userId) => ({ userId, url: `pic-${userId}` }))
    );
    const cache = createCache<Row>({
      redisKey: 'test:bust',
      idKey: 'userId',
      fieldTypes: { userId: 'number', url: 'string' },
      fetch,
    });
    const ctx = {
      pg: { query: vi.fn() },
      ch: { query: vi.fn() },
      redis,
    } as unknown as CacheContext;

    const result = await cache.fetch(ctx, [7]);

    expect(result[7]).toEqual({ userId: 7, url: 'pic-7' });
    expect(fetch).toHaveBeenLastCalledWith(ctx, [7]);
  });
});
