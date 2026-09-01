import { PrismaClient } from '@prisma/client';
import { REDIS_SYS_KEYS } from '@civitai/redis/client';
import { createClient } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Top-level, not an inline `typeof import(...)` — that trips consistent-type-imports.
import type * as SysReadDeadline from '~/server/redis/sys-read-deadline';
import type * as RedisPackage from '@civitai/redis/client';

/**
 * End-to-end proof for the dropped-enqueue parking lot, against a REAL Postgres and a
 * REAL Redis. The unit suite beside this one mocks both clients, so it can prove the
 * control flow and prove nothing about the SQL: whether Prisma's tagged template binds
 * the `::jsonb` cast the way the statement expects, whether `jsonb_array_length` accepts
 * what we actually store, whether the length-guarded delete matches. Those only fail
 * against a database.
 *
 * Skipped unless both URLs are supplied, mirroring kysely-prisma-parity.test.ts — CI has
 * neither, and a suite that silently needs infrastructure is worse than one that skips.
 *
 *   QUEUES_IT_DATABASE_URL=postgresql://... \
 *   QUEUES_IT_REDIS_URL=redis://:redis@localhost:6379 \
 *   pnpm exec vitest run --project 'unit*' src/server/redis/__tests__/queues.integration.test.ts
 *
 * Touches nothing real: the table is created in a scratch schema that is dropped
 * afterwards, and every redis key is written under a run-unique prefix.
 */
const databaseUrl = process.env.QUEUES_IT_DATABASE_URL;
const redisUrl = process.env.QUEUES_IT_REDIS_URL;

const SCHEMA = 'queues_it';

// `backing = null` is the outage: every command rejects fast, which is the DOWN mode
// queues.ts fails open on. Swapping it back is the recovery the drain has to survive.
const { holder, NS } = vi.hoisted(() => ({
  holder: { backing: null as null | Record<string, (...args: never[]) => Promise<unknown>> },
  NS: `queues-it:${process.pid}`,
}));

vi.mock('~/server/redis/client', async () => {
  const { withSysReadDeadline } = await vi.importActual<typeof SysReadDeadline>(
    '~/server/redis/sys-read-deadline'
  );
  // The key CONSTANTS come from the package, never hand-typed: a literal copy drifts from
  // production silently, and this suite asserts against a real Redis, so a stale copy would
  // make it prove the wrong keys. Importing the package (not the `~/server/redis/client`
  // shim) gets the constants without constructing a real client -- the same split
  // `src/__tests__/setup.ts` relies on.
  const actual = await vi.importActual<typeof RedisPackage>('@civitai/redis/client');
  // Every key this suite writes derives from BUCKETS, so prefixing arg 0 of each command
  // namespaces the whole run at the transport layer. That keeps the production key names
  // in play -- the mirror of the scratch SCHEMA on the Postgres side, where the SQL stays
  // unqualified and the isolation lives on the connection.
  const nsKey = (key: unknown) =>
    Array.isArray(key) ? key.map((k) => `${NS}:${k}`) : `${NS}:${key}`;
  const call =
    (fn: string) =>
    (key: unknown, ...rest: never[]) =>
      holder.backing
        ? holder.backing[fn](nsKey(key) as never, ...rest)
        : Promise.reject(new Error('sysRedis unavailable (test outage)'));
  return {
    ...actual,
    sysRedis: {
      hGet: call('hGet'),
      hSet: call('hSet'),
      sAdd: call('sAdd'),
      sMembers: call('sMembers'),
      del: call('del'),
      exists: call('exists'),
      set: call('set'),
    },
    withSysReadDeadline,
  };
});

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(() => Promise.resolve()) }));

let prisma: PrismaClient;
let bootstrap: PrismaClient;
// A getter, not a value: the client cannot exist until beforeAll has the URL, and
// queues.ts captures the binding at import.
vi.mock('~/server/db/client', () => ({
  get dbWrite() {
    return prisma;
  },
  get dbRead() {
    return prisma;
  },
}));

const { addToQueue, drainDroppedEnqueues } = await import('~/server/redis/queues');

const PARKED_KEY = 'search-index-queue-fallback:images_v6:Delete';

let redis: ReturnType<typeof createClient>;

describe.skipIf(!databaseUrl || !redisUrl)('queues parking lot — real Postgres + Redis', () => {
  beforeAll(async () => {
    // A scratch schema, so this can be pointed at any database without touching its real
    // KeyValue. `?schema=` is what puts it on the session search_path, which is how the
    // unqualified "KeyValue" inside queues.ts resolves here — so the schema has to exist
    // before the client that uses it connects.
    bootstrap = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await bootstrap.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

    const scoped = new URL(databaseUrl as string);
    scoped.searchParams.set('schema', SCHEMA);
    prisma = new PrismaClient({ datasources: { db: { url: scoped.toString() } } });
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA}."KeyValue" ("key" text PRIMARY KEY, "value" jsonb NOT NULL)`
    );

    redis = createClient({ url: redisUrl });
    await redis.connect();
  }, 30000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (bootstrap) {
      await bootstrap.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await bootstrap.$disconnect();
    }
    if (redis?.isOpen) {
      const keys = await redis.keys(`${NS}*`);
      if (keys.length) await redis.del(keys);
      await redis.quit();
    }
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE ${SCHEMA}."KeyValue"`);
    const keys = await redis.keys(`${NS}*`);
    if (keys.length) await redis.del(keys);
    holder.backing = redis as never;
  });

  const parked = () =>
    prisma.$queryRawUnsafe<{ key: string; value: number[] }[]>(
      `SELECT "key","value" FROM ${SCHEMA}."KeyValue" ORDER BY "key"`
    );

  // Reads through the same `${NS}:` prefix the sysRedis stub applies, against the REAL
  // key names. The bucket NAME stored in the hash is a value, not a key, so it is
  // unprefixed on the way out and has to be prefixed again to be read back.
  const bucketMembers = async () => {
    const bucketsKey = `${NS}:${REDIS_SYS_KEYS.QUEUES.BUCKETS}`;
    const bucket = await redis.hGet(bucketsKey, 'images_v6:Delete');
    return bucket ? redis.sMembers(`${NS}:${bucket}`) : [];
  };

  it('a healthy enqueue reaches redis and writes nothing to Postgres', async () => {
    await expect(addToQueue('images_v6:Delete', [1, 2, 3])).resolves.toBe(true);

    expect(await bucketMembers()).toEqual(expect.arrayContaining(['1', '2', '3']));
    expect(await parked()).toHaveLength(0);
  });

  it('an outage parks the ids in Postgres instead of losing them', async () => {
    holder.backing = null;

    await expect(addToQueue('images_v6:Delete', [10, 11])).resolves.toBe(false);

    expect(await parked()).toEqual([{ key: PARKED_KEY, value: [10, 11] }]);
  });

  it('successive drops during one outage accumulate under the same key', async () => {
    holder.backing = null;
    await addToQueue('images_v6:Delete', [10, 11]);
    await addToQueue('images_v6:Delete', [12]);

    expect((await parked())[0].value).toEqual([10, 11, 12]);
  });

  it('the drain replays them into redis once the outage ends, and clears the row', async () => {
    holder.backing = null;
    await addToQueue('images_v6:Delete', [10, 11]);
    holder.backing = redis as never;

    await expect(drainDroppedEnqueues()).resolves.toEqual({ keys: 1, replayed: 2, reparked: 0 });

    expect(await bucketMembers()).toEqual(expect.arrayContaining(['10', '11']));
    expect(await parked()).toHaveLength(0);
  });

  it('the drain leaves the row parked while the outage continues, and never duplicates it', async () => {
    holder.backing = null;
    await addToQueue('images_v6:Delete', [10, 11]);

    await expect(drainDroppedEnqueues()).resolves.toEqual({ keys: 1, replayed: 0, reparked: 2 });
    // Still exactly the two ids — a re-park would have appended a second copy.
    expect((await parked())[0].value).toEqual([10, 11]);

    holder.backing = redis as never;
    await expect(drainDroppedEnqueues()).resolves.toEqual({ keys: 1, replayed: 2, reparked: 0 });
    expect(await parked()).toHaveLength(0);
  });

  it('a drop landing between the drain read and its delete is not swallowed', async () => {
    holder.backing = null;
    await addToQueue('images_v6:Delete', [10, 11]);
    holder.backing = redis as never;

    // The interleaving the length guard exists for: the drain has read [10,11] and is
    // about to delete when another pod parks id 12. The delete must refuse the grown row.
    await prisma.$executeRawUnsafe(
      `UPDATE ${SCHEMA}."KeyValue" SET "value" = "value" || '[12]'::jsonb WHERE "key" = $1`,
      PARKED_KEY
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${SCHEMA}."KeyValue" WHERE "key" = $1 AND jsonb_typeof("value") = 'array' AND jsonb_array_length("value") = $2`,
      PARKED_KEY,
      2
    );

    expect((await parked())[0].value).toEqual([10, 11, 12]);
  });

  it('a row whose value is not an array is dropped rather than retried forever', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${SCHEMA}."KeyValue" ("key","value") VALUES ($1, '{"not":"an array"}'::jsonb)`,
      PARKED_KEY
    );

    await expect(drainDroppedEnqueues()).resolves.toEqual({ keys: 1, replayed: 0, reparked: 0 });
    expect(await parked()).toHaveLength(0);
  });
});
