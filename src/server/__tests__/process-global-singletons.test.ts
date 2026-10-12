import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvOther from '~/env/other';
import type * as DbClientPkg from '@civitai/db/client';
import type * as RedisClientPkg from '@civitai/redis/client';
import type * as ClickhouseClientPkg from '@civitai/clickhouse/client';
import type * as DbHelpers from '~/server/db/db-helpers';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

/**
 * The production server evaluates each server module once per bundler module graph, all in one
 * Node process. `vi.resetModules()` + a re-import is the same event: a fresh module instance
 * over the same `globalThis`. Each shim below must hand the second evaluation the first one's
 * clients, and build them once — in production too, which is where the shims used to skip
 * the global and call their factory per evaluation.
 */

// The shims are globally replaced by the canonical mocks in setup.ts; this file is about the
// shims themselves.
vi.unmock('~/server/db/client');
vi.unmock('~/server/redis/client');

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvOther>()),
  isProd: true,
}));

// Each factory returns a FRESH object per call, so a second call is visible as a different
// instance, not only as a call count.
const factories = vi.hoisted(() => ({
  createPrismaClients: vi.fn(() => ({ dbRead: { db: 'read' }, dbWrite: { db: 'write' } })),
  createRedisClients: vi.fn(() => ({ redis: { r: 'cache' }, sysRedis: { r: 'sys' } })),
  createClickhouseClient: vi.fn(() => ({ ch: true })),
  getClient: vi.fn((options?: { instance?: string }) => ({ pool: options?.instance ?? 'primary' })),
}));

vi.mock('@civitai/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof DbClientPkg>()),
  createPrismaClients: factories.createPrismaClients,
}));
vi.mock('@civitai/redis/client', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisClientPkg>()),
  createRedisClients: factories.createRedisClients,
}));
vi.mock('@civitai/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClientPkg>()),
  createClickhouseClient: factories.createClickhouseClient,
}));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  getClient: factories.getClient,
}));
// The redis shim's failover policy closes over Flipt; the real module builds a client at load.
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { REDIS_CLUSTER_ENHANCED_FAILOVER: 'redis_cluster_enhanced_failover' },
  isFlipt: vi.fn(() => Promise.resolve(false)),
}));

const GLOBALS = [
  '__civitaiPrismaClients',
  '__civitaiRedisClients',
  'globalClickhouse',
  'globalPgWrite',
  'globalPgRead',
  'globalPgReadLong',
  'globalDatapacketDbRead',
  'globalAppsDb',
] as const;

function clearGlobals() {
  for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
}

/** Evaluates a module twice, as two module graphs would, and returns both instances. */
async function evaluateTwice<M>(load: () => Promise<M>): Promise<[M, M]> {
  vi.resetModules();
  const first = await load();
  vi.resetModules();
  const second = await load();
  return [first, second];
}

beforeEach(() => {
  clearGlobals();
  for (const f of Object.values(factories)) f.mockClear();
  resetEnv();
  setEnv({
    IS_BUILD: false,
    CLICKHOUSE_HOST: 'http://clickhouse.test',
    CLICKHOUSE_USERNAME: 'test',
    APPS_DATABASE_URL: 'postgres://user:pass@localhost:5432/apps',
    // Distinct, so pgDb builds three pools rather than aliasing read onto write.
    DATABASE_URL: 'postgres://user:pass@localhost:5432/primary',
    DATABASE_REPLICA_URL: 'postgres://user:pass@localhost:5432/replica',
  });
});

afterAll(() => {
  clearGlobals();
  resetEnv();
});

describe('process-global server singletons (production)', () => {
  it('evaluates env/other as production in this file', async () => {
    // Control for the isProd mock, which is what makes the cases below red on code that
    // branches on `isProd` (the pre-change shape). A shim branching on NODE_ENV directly would
    // NOT be caught here: vitest runs with NODE_ENV=test.
    const { isProd } = await import('~/env/other');
    expect(isProd).toBe(true);
  });

  it('Prisma clients: one set per process', async () => {
    const [a, b] = await evaluateTwice(() => import('~/server/db/client'));
    expect(factories.createPrismaClients).toHaveBeenCalledTimes(1);
    expect(b.dbWrite).toBe(a.dbWrite);
    expect(b.dbRead).toBe(a.dbRead);
  });

  it('Redis clients: one set per process', async () => {
    const [a, b] = await evaluateTwice(() => import('~/server/redis/client'));
    expect(factories.createRedisClients).toHaveBeenCalledTimes(1);
    expect(b.redis).toBe(a.redis);
    expect(b.sysRedis).toBe(a.sysRedis);
  });

  it('ClickHouse client: one per process', async () => {
    const [a, b] = await evaluateTwice(() => import('~/server/clickhouse/client'));
    expect(factories.createClickhouseClient).toHaveBeenCalledTimes(1);
    expect(a.clickhouse).toBeDefined();
    expect(b.clickhouse).toBe(a.clickhouse);
  });

  it('primary pg pools: one write/read/read-long set per process', async () => {
    const [a, b] = await evaluateTwice(() => import('~/server/db/pgDb'));
    expect(factories.getClient).toHaveBeenCalledTimes(3);
    expect(a.pgDbRead).not.toBe(a.pgDbWrite);
    expect(b.pgDbWrite).toBe(a.pgDbWrite);
    expect(b.pgDbRead).toBe(a.pgDbRead);
    expect(b.pgDbReadLong).toBe(a.pgDbReadLong);
  });

  it('primary pg pools: read and read-long alias the one write pool when replica == primary', async () => {
    setEnv({ DATABASE_REPLICA_URL: 'postgres://user:pass@localhost:5432/primary' });
    const [a, b] = await evaluateTwice(() => import('~/server/db/pgDb'));
    expect(factories.getClient).toHaveBeenCalledTimes(1);
    expect(a.pgDbRead).toBe(a.pgDbWrite);
    expect(a.pgDbReadLong).toBe(a.pgDbWrite);
    expect(b.pgDbWrite).toBe(a.pgDbWrite);
  });

  it('datapacket read pool: one per process', async () => {
    const [a, b] = await evaluateTwice(() => import('~/server/db/datapacketDb'));
    expect(factories.getClient).toHaveBeenCalledTimes(1);
    expect(b.datapacketDbRead).toBe(a.datapacketDbRead);
  });

  it('apps pool: one per process', async () => {
    const [a, b] = await evaluateTwice(() => import('~/server/db/appsDb'));
    expect(factories.getClient).toHaveBeenCalledTimes(1);
    expect(a.appsDb).not.toBeNull();
    expect(b.appsDb).toBe(a.appsDb);
  });
});
