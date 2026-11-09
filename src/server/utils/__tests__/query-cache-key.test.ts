import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as PromClient from '~/server/prom/client';
import { queryCacheKeyHash } from '~/server/utils/query-cache-key';
import { hashifyObject } from '~/utils/string-helpers';

/**
 * `queryCache` / `queryCacheRaw` callers bind the viewer's id into the statement and rely on the
 * statement's key to keep each viewer's rows apart (`getAllImages` does this for private posts).
 * These two ids are a real pair that collided under a 32-bit hash; the statements below must
 * get distinct keys.
 */
const VIEWER_A = 5691075;
const VIEWER_B = 46029314;

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
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

  it('gives the two viewers different statement keys, where the 32-bit hash collided', () => {
    // The fixture is a real collision; without this the tests above could pass for a weaker hash.
    expect(hashifyObject(forViewer(VIEWER_A))).toBe(hashifyObject(forViewer(VIEWER_B)));
    expect(queryCacheKeyHash(forViewer(VIEWER_A))).not.toBe(queryCacheKeyHash(forViewer(VIEWER_B)));
  });

  it('keys a bound value apart from its string spelling', () => {
    const key = (v: unknown) => queryCacheKeyHash(Prisma.sql`SELECT ${v}`);
    expect(key(BigInt(1))).not.toBe(key('1n'));
    expect(key(new Date('2026-01-01T00:00:00Z'))).not.toBe(key('2026-01-01T00:00:00.000Z'));
    expect(key(undefined)).not.toBe(key(null));
  });
});
