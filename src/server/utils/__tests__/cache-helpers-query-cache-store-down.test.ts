import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `queryCache` / `queryCacheRaw` with the cluster cache unavailable: the query runs against the
 * database and its rows are returned, whether the cache read rejects or was sent and never
 * answered, and whether or not the write-back lands — within the cache deadline, not the client's
 * 15s backstop.
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { queryCache, queryCacheRaw } from '~/server/utils/cache-helpers';

const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);
const never = () => new Promise<never>(() => undefined);

const ROWS = [{ id: 1 }, { id: 2 }];
const SQL = Prisma.sql`SELECT 1`;

function prismaDb() {
  return { $queryRaw: vi.fn(async () => ROWS) } as never as Parameters<typeof queryCache>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('queryCache with the cache unavailable', () => {
  it('a rejecting cache read runs the query and returns its rows', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cluster down'));

    const result = await within(
      queryCache(prismaDb(), 'qc-test')(SQL, { ttl: 60, tag: 't' }),
      2000
    );

    expect(result).toEqual(ROWS);
  });

  it('a cache read and write-back that never answer return the rows within 1000ms', async () => {
    redisMock.redis.packed.get.mockImplementation(never);
    redisMock.redis.packed.set.mockImplementation(never);
    redisMock.redis.sAdd.mockImplementation(never);

    const started = Date.now();
    const result = await within(
      queryCache(prismaDb(), 'qc-test')(SQL, { ttl: 60, tag: 't' }),
      3000
    );

    expect(result).toEqual(ROWS);
    // read (250ms) + write-back incl. tag (250ms) + slack.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('queryCacheRaw with the cache unavailable', () => {
  it('a cache read that never answers returns the rows within 1000ms', async () => {
    redisMock.redis.packed.get.mockImplementation(never);
    redisMock.redis.packed.set.mockResolvedValue('OK');
    const executor = vi.fn(async () => ROWS) as never as Parameters<typeof queryCacheRaw>[0];

    const started = Date.now();
    const result = await within(
      queryCacheRaw(executor, 'qcr-test')(SQL, { ttl: 60, tag: 't' }),
      3000
    );

    expect(result).toEqual(ROWS);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('queryCache single-flight on a miss', () => {
  it('N concurrent misses for one key run the query once, and each caller gets its own rows', async () => {
    redisMock.redis.packed.get.mockImplementation(never); // every read times out: a miss
    redisMock.redis.packed.set.mockResolvedValue('OK');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queryRaw = vi.fn(async () => {
      await gate;
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    });
    const db = { $queryRaw: queryRaw } as never as Parameters<typeof queryCache>[0];
    const cached = queryCache(db, 'qc-single-flight');

    const calls = Array.from({ length: 5 }, () => cached(SQL, { ttl: 60, tag: 't' }));
    // Let every read time out and join before the query settles.
    await new Promise((r) => setTimeout(r, 400));
    release();
    const results = await within(Promise.all(calls), 3000);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(results).not.toBe(HUNG);
    const rows = results as { id: number }[][];
    for (const r of rows) expect(r).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    // A caller that pops its cursor row (post.service does) must not shorten anyone else's page.
    rows[0].pop();
    for (const r of rows.slice(1)) expect(r).toHaveLength(3);
  });

  it('control: misses for different keys each run their own query', async () => {
    redisMock.redis.packed.get.mockResolvedValue(null);
    redisMock.redis.packed.set.mockResolvedValue('OK');
    const queryRaw = vi.fn(async () => ROWS);
    const db = { $queryRaw: queryRaw } as never as Parameters<typeof queryCache>[0];
    await Promise.all([
      queryCache(db, 'qc-sf-a')(SQL, { ttl: 60, tag: 't' }),
      queryCache(db, 'qc-sf-b')(SQL, { ttl: 60, tag: 't' }),
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('a miss after the first one settled runs the query again (nothing is held)', async () => {
    redisMock.redis.packed.get.mockResolvedValue(null);
    redisMock.redis.packed.set.mockResolvedValue('OK');
    const queryRaw = vi.fn(async () => ROWS);
    const db = { $queryRaw: queryRaw } as never as Parameters<typeof queryCache>[0];
    const cached = queryCache(db, 'qc-sf-seq');
    await cached(SQL, { ttl: 60, tag: 't' });
    await cached(SQL, { ttl: 60, tag: 't' });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
