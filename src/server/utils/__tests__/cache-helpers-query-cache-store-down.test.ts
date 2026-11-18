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
import { fetchThroughCache, queryCache, queryCacheRaw } from '~/server/utils/cache-helpers';
import { pack, unpack } from 'msgpackr';
import type { RedisKeyTemplateCache } from '~/server/redis/client';

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

  it('a joiner gets what a cache hit would return (Prisma.Decimal → its string), never a clone error', async () => {
    redisMock.redis.packed.get.mockImplementation(never);
    redisMock.redis.packed.set.mockResolvedValue('OK');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queryRaw = vi.fn(async () => {
      await gate;
      return [{ id: 1, amount: new Prisma.Decimal('1.25') }];
    });
    const db = { $queryRaw: queryRaw } as never as Parameters<typeof queryCache>[0];
    const cached = queryCache(db, 'qc-sf-decimal');

    const first = cached(SQL, { ttl: 60, tag: 't' });
    const joiner = cached(SQL, { ttl: 60, tag: 't' });
    await new Promise((r) => setTimeout(r, 400));
    release();
    const [a, b] = (await within(Promise.all([first, joiner]), 3000)) as {
      id: number;
      amount: unknown;
    }[][];

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(a[0].amount).toBeInstanceOf(Prisma.Decimal); // the first caller: the query's own value
    // The joiner: exactly the cache codec's decoding, as a cache hit gets it.
    expect(b).toEqual(unpack(pack([{ id: 1, amount: new Prisma.Decimal('1.25') }])));
    expect(b[0].amount).toBe('1.25');
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

describe('fetchThroughCache fail-open single-flight (same helper)', () => {
  const KEY = 'packed:caches:failopen-sf-test' as RedisKeyTemplateCache;

  it('concurrent fail-open callers share one origin fetch and each gets its own value', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cluster down'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = vi.fn(async () => {
      await gate;
      return { items: [1, 2, 3] };
    });

    const calls = Array.from({ length: 4 }, () => fetchThroughCache(KEY, fetchFn));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = (await within(Promise.all(calls), 2000)) as { items: number[] }[];

    expect(fetchFn).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual({ items: [1, 2, 3] });
    // The first caller mutating its value (synchronously, as soon as it has it) reaches no other.
    results[0].items.pop();
    for (const r of results.slice(1)) expect(r.items).toHaveLength(3);
  });

  it('the first caller mutating synchronously on resolve cannot reach a joiner', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cluster down'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = vi.fn(async () => {
      await gate;
      return { items: [1, 2, 3] };
    });

    // The first caller's continuation is registered before the joiner's and pops immediately.
    const first = fetchThroughCache(KEY, fetchFn).then((v) => {
      v.items.pop();
      return v;
    });
    const joiner = fetchThroughCache(KEY, fetchFn);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = (await within(Promise.all([first, joiner]), 2000)) as { items: number[] }[];

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a.items).toEqual([1, 2]);
    expect(b.items).toEqual([1, 2, 3]);
  });
});
