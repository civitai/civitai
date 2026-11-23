import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withReadRetry } from '@civitai/db/read-retry';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';

/**
 * The read retry through a real PrismaClient and a real database, so what the hook sees is what
 * Prisma passes it: the operation names, the raw-query args, and whether the call is inside a
 * `$transaction` (which Prisma reports only through an undocumented parameter).
 *
 * A brief failover is stood in for by an inner extension, applied after the retry so it sits
 * between the retry and the engine: it fails the next `failures.length` calls with the error the
 * pooler produces, then lets them through to the database.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const poolerLoginFailing = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Error in connector: Error querying the database: FATAL: server login has been failing, cached error: connect failed (server_login_retry)',
    { clientVersion: 'test' }
  );

let h: Awaited<ReturnType<typeof startPglitePrisma>>;
const failures: unknown[] = [];
const attempts: string[] = [];

const makeClient = () =>
  withReadRetry(h.prisma, 'read', { onResult: () => undefined }).$extends({
    query: {
      async $allOperations({ operation, args, query }) {
        attempts.push(operation);
        if (attempts.length > 50) throw new Error('runaway: more than 50 attempts');
        const failure = failures.shift();
        if (failure) throw failure;
        return query(args);
      },
    },
  });
let db: ReturnType<typeof makeClient>;

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb NOT NULL);
    INSERT INTO "KeyValue" VALUES ('a', '1');
  `);
  db = makeClient();
});
afterAll(() => h?.stop());
beforeEach(() => {
  failures.length = 0;
  attempts.length = 0;
});

describe('reads are retried across a brief failover', () => {
  it('a findMany that hits the pooler login failure is retried and answers from the database', async () => {
    failures.push(poolerLoginFailing());
    const rows = await db.keyValue.findMany({ select: { key: true } });
    expect(rows).toEqual([{ key: 'a' }]);
    expect(attempts).toEqual(['findMany', 'findMany']);
  });

  it('a raw SELECT is retried', async () => {
    failures.push(poolerLoginFailing(), poolerLoginFailing());
    const rows = await db.$queryRaw<
      { key: string }[]
    >`SELECT key FROM "KeyValue" WHERE key = ${'a'}`;
    expect(rows).toEqual([{ key: 'a' }]);
    expect(attempts).toEqual(['$queryRaw', '$queryRaw', '$queryRaw']);
  });
});

describe('nothing else is retried', () => {
  it('a create fails at once, and writes nothing', async () => {
    failures.push(poolerLoginFailing());
    await expect(
      db.keyValue.create({ data: { key: 'b', value: 2 }, select: { key: true } })
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(attempts).toEqual(['create']);
    expect(await h.prisma.keyValue.count({ where: { key: 'b' } })).toBe(0);
  });

  it('a raw UPDATE fails at once', async () => {
    failures.push(poolerLoginFailing());
    await expect(
      db.$queryRaw`UPDATE "KeyValue" SET value = '3' WHERE key = 'a' RETURNING key`
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(attempts).toEqual(['$queryRaw']);
  });

  it('a read inside an interactive transaction fails at once', async () => {
    failures.push(poolerLoginFailing());
    await expect(
      db.$transaction(async (tx) => tx.keyValue.findMany({ select: { key: true } }))
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(attempts).toEqual(['findMany']);
  });

  it('a read inside a batch transaction fails at once', async () => {
    failures.push(poolerLoginFailing());
    await expect(
      db.$transaction([db.keyValue.findMany({ select: { key: true } })])
    ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(attempts).toEqual(['findMany']);
  });

  // Control for the two above: the same reads, unfailed, do run inside a transaction.
  it('the same reads succeed in a transaction when nothing fails', async () => {
    const [batch] = await db.$transaction([db.keyValue.findMany({ select: { key: true } })]);
    const itx = await db.$transaction(async (tx) =>
      tx.keyValue.findMany({ select: { key: true } })
    );
    expect(batch).toEqual([{ key: 'a' }]);
    expect(itx).toEqual([{ key: 'a' }]);
  });
});
