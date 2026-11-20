import { Prisma } from '@civitai/db-schema';
import { describe, expect, it, vi } from 'vitest';
import {
  isReadOnlySql,
  isRetryableRead,
  readRetryHook,
  retryRead,
  type QueryHookParams,
  type ReadRetryOptions,
} from './read-retry';

// A brief primary failover: the pooler answers new logins with a cached failure, and connections
// already pooled are found closed. Prisma surfaces both; a read retried a moment later succeeds.
const poolerLoginFailing = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Error in connector: Error querying the database: FATAL: server login has been failing, cached error: connect failed (server_login_retry)',
    { clientVersion: 'test' }
  );
const serverClosed = () =>
  new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
    code: 'P1017',
    clientVersion: 'test',
  });
const pg08P01 = () =>
  Object.assign(new Error('server login has been failing, try again later (server_login_retry)'), {
    code: '08P01',
    severity: 'FATAL',
  });
const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

/** A clock that only moves when the code under test sleeps, so a budget is reached exactly. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    opts: {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      random: () => 0.5, // jitter factor 1: each delay is exactly its base
    } satisfies ReadRetryOptions,
  };
}

/** A query that throws `failures` in order, then answers `value`; capped so a loop cannot run away. */
function scriptedQuery(failures: unknown[], value: unknown = [{ id: 1 }]) {
  const calls: unknown[] = [];
  const query = vi.fn(async (args: unknown) => {
    calls.push(args);
    if (calls.length > 50) throw new Error('runaway: more than 50 attempts');
    const failure = failures.shift();
    if (failure) throw failure;
    return value;
  });
  return { query, calls };
}

const outside = { transaction: undefined };

describe('retryRead', () => {
  it('retries a read that failed with 08P01, then returns its answer', async () => {
    const clock = fakeClock();
    const { query, calls } = scriptedQuery([pg08P01()]);
    await expect(retryRead(() => query({}), clock.opts)).resolves.toEqual([{ id: 1 }]);
    expect(calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([100]);
  });

  it('backs off exponentially, capped, and gives up once the next attempt would pass the budget', async () => {
    const clock = fakeClock();
    const onResult = vi.fn();
    const { query, calls } = scriptedQuery(Array.from({ length: 49 }, serverClosed));
    await expect(retryRead(() => query({}), { ...clock.opts, onResult })).rejects.toMatchObject({
      code: 'P1017',
    });
    // Sleeps end at 100, 300, 700, 1500, 2500, 3500, 4500 ms; one more 1000 ms would end at 5500,
    // past the 5000 ms budget, so the eighth failure is thrown.
    expect(clock.sleeps).toEqual([100, 200, 400, 800, 1000, 1000, 1000]);
    expect(calls).toHaveLength(8);
    expect(onResult).toHaveBeenCalledExactlyOnceWith('exhausted', 7);
  });

  it('scales each delay by 0.5 + random()', async () => {
    const clock = fakeClock();
    const { query } = scriptedQuery([serverClosed(), serverClosed()]);
    await retryRead(() => query({}), { ...clock.opts, random: () => 0.9 });
    expect(clock.sleeps).toEqual([140, 280]);
  });

  it('a smaller budget stops sooner', async () => {
    const clock = fakeClock();
    const { query, calls } = scriptedQuery(Array.from({ length: 49 }, serverClosed));
    await expect(retryRead(() => query({}), { ...clock.opts, budgetMs: 350 })).rejects.toThrow();
    expect(clock.sleeps).toEqual([100, 200]);
    expect(calls).toHaveLength(3);
  });

  it('does not retry an error that is not a lost connection', async () => {
    const clock = fakeClock();
    const { query, calls } = scriptedQuery([uniqueViolation()]);
    await expect(retryRead(() => query({}), clock.opts)).rejects.toMatchObject({ code: 'P2002' });
    expect(calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('stops at the first non-connection error after a retry, and reports it', async () => {
    const clock = fakeClock();
    const onResult = vi.fn();
    const { query, calls } = scriptedQuery([serverClosed(), uniqueViolation()]);
    await expect(retryRead(() => query({}), { ...clock.opts, onResult })).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(calls).toHaveLength(2);
    expect(onResult).toHaveBeenCalledExactlyOnceWith('failed', 1);
  });
});

const hook = (opts: ReadRetryOptions) => readRetryHook(opts);
const run = (
  h: ReturnType<typeof readRetryHook>,
  params: Omit<QueryHookParams, 'query'>,
  query: QueryHookParams['query']
) => h({ ...params, query });

describe('readRetryHook', () => {
  it.each(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'])(
    'retries %s outside a transaction',
    async (operation) => {
      const clock = fakeClock();
      const { query, calls } = scriptedQuery([poolerLoginFailing()]);
      await expect(
        run(hook(clock.opts), { operation, args: {}, __internalParams: outside }, query)
      ).resolves.toEqual([{ id: 1 }]);
      expect(calls).toHaveLength(2);
    }
  );

  it.each([
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'upsert',
    '$executeRaw',
    '$executeRawUnsafe',
  ])('never retries %s', async (operation) => {
    const clock = fakeClock();
    const { query, calls } = scriptedQuery([poolerLoginFailing()]);
    await expect(
      run(hook(clock.opts), { operation, args: {}, __internalParams: outside }, query)
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['an interactive transaction', { transaction: { kind: 'itx', id: 't1' } }],
    ['a batch transaction', { transaction: { kind: 'batch', id: 1, index: 0 } }],
    ['no internal params at all (an unknown Prisma version)', undefined],
  ])('never retries a read inside %s', async (_label, internal) => {
    const clock = fakeClock();
    const { query, calls } = scriptedQuery([poolerLoginFailing()]);
    await expect(
      run(hook(clock.opts), { operation: 'findMany', args: {}, __internalParams: internal }, query)
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(calls).toHaveLength(1);
  });

  it('retries a raw SELECT given as a Sql object, and a raw unsafe SELECT', async () => {
    for (const [operation, args] of [
      ['$queryRaw', Prisma.sql`SELECT id FROM "Model" WHERE id = ${1}`],
      ['$queryRawUnsafe', ['SELECT id FROM "Model" WHERE id = $1', 1]],
    ] as const) {
      const clock = fakeClock();
      const { query, calls } = scriptedQuery([serverClosed()]);
      await run(hook(clock.opts), { operation, args, __internalParams: outside }, query);
      expect(calls, operation).toHaveLength(2);
    }
  });

  it('does not retry a raw query that writes', async () => {
    const clock = fakeClock();
    const { query, calls } = scriptedQuery([serverClosed()]);
    await expect(
      run(
        hook(clock.opts),
        {
          operation: '$queryRaw',
          args: Prisma.sql`UPDATE "Model" SET name = ${'x'} RETURNING id`,
          __internalParams: outside,
        },
        query
      )
    ).rejects.toMatchObject({ code: 'P1017' });
    expect(calls).toHaveLength(1);
  });
});

describe('isRetryableRead / isReadOnlySql', () => {
  it.each([
    'SELECT id FROM "Model" WHERE id = $1',
    '  select count(*) from "Image"',
    '/* log:redact */ SELECT "id" FROM "User" WHERE "id" = ANY($1::int[])',
    '-- the feed\nWITH x AS (SELECT id FROM "Post") SELECT COALESCE(max(id), 0) FROM x',
    "SELECT jsonb_build_object('a', 1) AS o, row_number() OVER (PARTITION BY a) FROM t",
    'SELECT id FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.id IN (1, 2))',
  ])('reads: %s', (sql) => {
    expect(isReadOnlySql(sql)).toBe(true);
  });

  it.each([
    ['an UPDATE', 'UPDATE "Model" SET name = $1'],
    ['an INSERT', 'INSERT INTO t (a) VALUES (1)'],
    ['a DELETE', 'DELETE FROM t'],
    ['a data-modifying CTE', 'WITH d AS (DELETE FROM t RETURNING id) SELECT id FROM d'],
    ['an INSERT in a CTE', 'WITH i AS (INSERT INTO t (a) VALUES (1) RETURNING a) SELECT a FROM i'],
    ['SELECT INTO', 'SELECT * INTO backup FROM t'],
    ['a locking read', 'SELECT id FROM t FOR UPDATE'],
    ['nextval', "SELECT nextval('t_id_seq')"],
    ['an advisory lock', 'SELECT pg_advisory_lock(1)'],
    ['a user-defined function', 'SELECT refresh_user_stats($1)'],
    ['a schema-qualified function', 'SELECT public.recalc(1)'],
    ['a quoted function name', 'SELECT "doThing"(1)'],
    ['a comment between a function name and its parenthesis', "SELECT nextval/* x */('s')"],
    ['a set-returning user function', 'SELECT * FROM rebuild_index_for($1)'],
    ['a statement that is not a SELECT', 'VACUUM t'],
    ['an empty string', ''],
  ])('does not read: %s', (_label, sql) => {
    expect(isReadOnlySql(sql)).toBe(false);
  });

  it('a raw query whose text cannot be found is not retried', () => {
    expect(isRetryableRead('$queryRaw', {})).toBe(false);
    expect(isRetryableRead('$queryRawUnsafe', [42])).toBe(false);
  });
});
