import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';

/**
 * `queryCache` / `queryCacheRaw` callers bind the viewer's id into the statement and rely on the
 * statement's key to keep each viewer's rows apart (`getAllImages` does this for private posts).
 * These two ids are a real pair whose statements below shared a key under the earlier 32-bit
 * statement hash, so the second viewer was served the first viewer's cached rows.
 */
const VIEWER_A = 5691075;
const VIEWER_B = 46029314;

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));

import { queryCache, queryCacheRaw } from '~/server/utils/cache-helpers';

const forViewer = (userId: number) =>
  Prisma.sql`SELECT i.id FROM "Image" i WHERE (i."acceptableMinor" = FALSE OR i."userId" = ${userId})`;
const rowsFor = (userId: number) => [{ id: userId * 10 }];

describe('query cache keys never mix two viewers', () => {
  beforeEach(() => {
    installFakeCacheRedis();
  });

  it('queryCacheRaw serves each viewer their own rows', async () => {
    const executor = vi.fn(async (q: Prisma.Sql) => rowsFor(q.values[0] as number));
    const cacheable = queryCacheRaw(executor as never, 'getImagesRaw', 'v1');

    expect(await cacheable(forViewer(VIEWER_A), { ttl: 60, tag: [] })).toEqual(rowsFor(VIEWER_A));
    expect(await cacheable(forViewer(VIEWER_B), { ttl: 60, tag: [] })).toEqual(rowsFor(VIEWER_B));
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('queryCache serves each viewer their own rows', async () => {
    const $queryRaw = vi.fn(async (q: Prisma.Sql) => rowsFor(q.values[0] as number));
    const cacheable = queryCache({ $queryRaw } as never, 'getPostsInfinite', 'v1');

    expect(await cacheable(forViewer(VIEWER_A), { ttl: 60, tag: [] })).toEqual(rowsFor(VIEWER_A));
    expect(await cacheable(forViewer(VIEWER_B), { ttl: 60, tag: [] })).toEqual(rowsFor(VIEWER_B));
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('still serves a repeat read from the cache', async () => {
    const executor = vi.fn(async (q: Prisma.Sql) => rowsFor(q.values[0] as number));
    const cacheable = queryCacheRaw(executor as never, 'getImagesRaw', 'v1');

    await cacheable(forViewer(VIEWER_A), { ttl: 60, tag: [] });
    expect(await cacheable(forViewer(VIEWER_A), { ttl: 60, tag: [] })).toEqual(rowsFor(VIEWER_A));
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
