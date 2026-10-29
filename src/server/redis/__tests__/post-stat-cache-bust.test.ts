import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * A post card shows reactions from `postStatCache`. A post read before its AllTime PostMetric row
 * existed (a draft, or a post created already published, which the publish trigger never seeds) is
 * negatively cached; the metrics job then upserts the row and busts. That bust has to make the
 * counts readable, or the card stays blank for as long as the metrics job keeps busting.
 */

const { postStatCache } = await import('~/server/redis/caches');

// A Redis double that honours EX and NX against the fake clock.
const store = new Map<string, { value: unknown; expiresAt: number }>();
const read = (key: string) => {
  const e = store.get(key);
  if (!e || Date.now() >= e.expiresAt) return null;
  return structuredClone(e.value);
};

const POST = 101;
const row = {
  postId: POST,
  commentCount: 0,
  likeCount: 2,
  dislikeCount: 0,
  heartCount: 3,
  laughCount: 0,
  cryCount: 0,
  collectedCount: 0,
};
const T0 = new Date('2026-10-29T00:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store.clear();
  redisMock.redis.packed.mGet.mockImplementation(async (keys: string[]) => keys.map(read));
  redisMock.redis.packed.set.mockImplementation(
    async (key: string, value: unknown, opts?: { EX?: number; NX?: boolean }) => {
      if (opts?.NX && read(key) !== null) return null;
      store.set(key, {
        value: structuredClone(value),
        expiresAt: Date.now() + (opts?.EX ?? Infinity) * 1000,
      });
      return 'OK';
    }
  );
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
  dbMock.dbRead.$queryRaw.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('postStatCache', () => {
  it('serves the counts after the metrics job busts a post that was cached before it had a row', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
    expect(await postStatCache.fetch([POST])).toEqual({});
    // Negatively cached: the second read does not query.
    expect(await postStatCache.fetch([POST])).toEqual({});
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);

    // post.metrics.ts: upsert the AllTime row, then bust.
    dbMock.dbRead.$queryRaw.mockResolvedValue([row]);
    await postStatCache.bust([POST]);

    vi.setSystemTime(T0 + 60_000);
    expect(await postStatCache.fetch([POST])).toEqual({ [POST]: row });
  });
});
