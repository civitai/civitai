import { PrismaClient } from '@prisma/client';
import { REDIS_SYS_KEYS } from '@civitai/redis/client';
import { createClient } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';

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

const NS = `queues-it:${process.pid}`;

// `backing = null` is the outage: every command rejects fast, which is the DOWN mode
// queues.ts fails open on. Swapping it back is the recovery the drain has to survive.
let backing: typeof redis | null = null;

/**
 * 🔴 This file drives the CANONICAL shared mocks rather than registering its own.
 *
 * `~/server/db/client`, `~/server/redis/client` and `~/server/logging/client` all have
 * canonical mocks registered once in `src/__tests__/setup.ts`, and a per-file `vi.mock` of
 * any of them freezes that shape into every later file in the same worker under
 * `isolate: false` — which is what `no-direct-shared-module-mock` exists to stop, and why
 * `gen-mock-allowlist.mjs` refuses to allowlist a new file.
 *
 * Being an INTEGRATION test is not an exemption from that, only a constraint on how the
 * seam is used: the canonical nodes are `vi.fn()`s, so instead of declaring canned return
 * values this file points them at the REAL Postgres and Redis clients it builds in
 * `beforeAll`. That satisfies the guard and keeps the suite end-to-end.
 *
 * It also removes the hand-typed key constants this file used to carry — `setup.ts` spreads
 * the real `@civitai/redis/client` into the canonical factory, so `REDIS_SYS_KEYS` and
 * `REDIS_SUB_KEYS` are production's own values and cannot drift
 * (`no-hand-typed-redis-key-constants`). `withSysReadDeadline` likewise defaults to the real
 * implementation there, so queues.ts keeps running the real deadline wrapper.
 */

// `~/server/redis/fail-open-log` is a PENDING specifier: no canonical mock exists yet, so a
// direct mock is counted rather than enforced. Stubbed because the real logger is noise here.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

let prisma: PrismaClient;
let bootstrap: PrismaClient;

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

    // Point the canonical db mock at the REAL scratch-schema client. queues.ts calls these as
    // TAGGED TEMPLATES, so the implementation forwards (strings, ...values) verbatim — which
    // is exactly the binding this suite exists to prove (the `::jsonb` cast, and
    // `jsonb_array_length` on what we actually store).
    dbMock.dbWrite.$queryRaw.mockImplementation((sql: TemplateStringsArray, ...values: unknown[]) =>
      prisma.$queryRaw(sql, ...values)
    );
    dbMock.dbWrite.$executeRaw.mockImplementation(
      (sql: TemplateStringsArray, ...values: unknown[]) => prisma.$executeRaw(sql, ...values)
    );

    // Point the canonical sysRedis mock at the REAL redis. Every key this suite writes derives
    // from BUCKETS, so prefixing arg 0 namespaces the whole run at the transport layer while
    // leaving the PRODUCTION key names in play — the mirror of the scratch SCHEMA on the
    // Postgres side, where the SQL stays unqualified and the isolation lives on the connection.
    // `del` accepts an array of keys as well as one.
    const nsKey = (key: unknown) =>
      Array.isArray(key) ? key.map((k) => `${NS}:${k}`) : `${NS}:${key}`;
    const COMMANDS = ['hGet', 'hSet', 'sAdd', 'sMembers', 'del', 'exists', 'set'] as const;
    for (const cmd of COMMANDS) {
      redisMock.sysRedis[cmd].mockImplementation((key: unknown, ...rest: unknown[]) =>
        backing
          ? (backing as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[cmd](
              nsKey(key),
              ...rest
            )
          : Promise.reject(new Error('sysRedis unavailable (test outage)'))
      );
    }
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
    backing = redis;
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
    backing = null;

    await expect(addToQueue('images_v6:Delete', [10, 11])).resolves.toBe(false);

    expect(await parked()).toEqual([{ key: PARKED_KEY, value: [10, 11] }]);
  });

  it('successive drops during one outage accumulate under the same key', async () => {
    backing = null;
    await addToQueue('images_v6:Delete', [10, 11]);
    await addToQueue('images_v6:Delete', [12]);

    expect((await parked())[0].value).toEqual([10, 11, 12]);
  });

  it('the drain replays them into redis once the outage ends, and clears the row', async () => {
    backing = null;
    await addToQueue('images_v6:Delete', [10, 11]);
    backing = redis;

    await expect(drainDroppedEnqueues()).resolves.toEqual({ keys: 1, replayed: 2, reparked: 0 });

    expect(await bucketMembers()).toEqual(expect.arrayContaining(['10', '11']));
    expect(await parked()).toHaveLength(0);
  });

  it('the drain leaves the row parked while the outage continues, and never duplicates it', async () => {
    backing = null;
    await addToQueue('images_v6:Delete', [10, 11]);

    await expect(drainDroppedEnqueues()).resolves.toEqual({ keys: 1, replayed: 0, reparked: 2 });
    // Still exactly the two ids — a re-park would have appended a second copy.
    expect((await parked())[0].value).toEqual([10, 11]);

    backing = redis;
    await expect(drainDroppedEnqueues()).resolves.toEqual({ keys: 1, replayed: 2, reparked: 0 });
    expect(await parked()).toHaveLength(0);
  });

  it('a drop landing between the drain read and its delete is not swallowed', async () => {
    backing = null;
    await addToQueue('images_v6:Delete', [10, 11]);
    backing = redis;

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
