import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool as PgPool, PoolConfig } from 'pg';

/**
 * Pool sizing on the connection-string path of `createKyselyClients`.
 *
 * The factory used to hand `poolConfig` straight to `new Pool(...)`, so a caller that passed only a
 * connection string inherited pg's own defaults — including `connectionTimeoutMillis: 0`, which
 * means "queue forever": an exhausted pool then hangs every subsequent caller instead of erroring.
 *
 * These assertions read the CONSTRUCTED pool's own `options`, not the factory's source. The mock
 * below is not a stand-in for `pg`: it re-exports the real module and only subclasses `Pool` to keep
 * a reference to each instance, so `options` is pg's own resolved config — what the pool would
 * actually use at connect time, with pg's defaults already applied to anything we left unset.
 * Constructing a Pool opens no socket (pg connects lazily on first query), so nothing here needs a
 * database.
 */
const { createdPools } = vi.hoisted(() => ({ createdPools: [] as PgPool[] }));

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  class RecordingPool extends actual.Pool {
    constructor(config?: PoolConfig) {
      super(config);
      createdPools.push(this);
    }
  }
  return { ...actual, Pool: RecordingPool };
});

const { createKyselyClients } = await import('./kysely');
const { Pool } = await import('pg');

type TestDB = { widget: { id: number } };

const PRIMARY_URL = 'postgresql://user:pass@primary.example.test:5432/appdb';
const REPLICA_URL = 'postgresql://user:pass@replica.example.test:5432/appdb';

// pg's own defaults, for reference: max 10, idleTimeoutMillis 10_000, connectionTimeoutMillis
// undefined (treated as 0 = no timeout). Every fixture value below is chosen to differ from BOTH
// those and our defaults, so no assertion can pass by landing on a value it did not come from.
beforeEach(() => {
  createdPools.length = 0;
});

describe('createKyselyClients applies pool defaults', () => {
  it('sets max, idle timeout and a finite connect timeout when the caller passes only a connection string', () => {
    createKyselyClients<TestDB>({ connectionString: PRIMARY_URL, singleClient: true });

    expect(createdPools).toHaveLength(1);
    const [pool] = createdPools;
    expect(pool.options.connectionString).toBe(PRIMARY_URL);
    expect(pool.options.max).toBe(20);
    expect(pool.options.idleTimeoutMillis).toBe(30_000);
    expect(pool.options.connectionTimeoutMillis).toBe(5_000);
  });

  it('lets an explicit caller value override each default', () => {
    createKyselyClients<TestDB>({
      connectionString: PRIMARY_URL,
      max: 3,
      idleTimeoutMillis: 1_234,
      connectionTimeoutMillis: 777,
      singleClient: true,
    });

    expect(createdPools).toHaveLength(1);
    const [pool] = createdPools;
    // Pins the SPREAD ORDER: caller config must be spread after the defaults, not before.
    expect(pool.options.max).toBe(3);
    expect(pool.options.idleTimeoutMillis).toBe(1_234);
    expect(pool.options.connectionTimeoutMillis).toBe(777);
  });

  it('applies the defaults to the replica pool as well as the primary', () => {
    createKyselyClients<TestDB>({
      connectionString: PRIMARY_URL,
      replicaConnectionString: REPLICA_URL,
    });

    expect(createdPools).toHaveLength(2);
    const [primary, replica] = createdPools;
    // Identify the pools by their connection string, so a replica assertion cannot be satisfied by
    // accidentally reading the primary.
    expect(primary.options.connectionString).toBe(PRIMARY_URL);
    expect(replica.options.connectionString).toBe(REPLICA_URL);

    expect(replica.options.max).toBe(20);
    expect(replica.options.idleTimeoutMillis).toBe(30_000);
    expect(replica.options.connectionTimeoutMillis).toBe(5_000);
  });

  it('leaves a pre-built pool untouched and builds no pool of its own', () => {
    // The main app takes this branch: it hands in its existing pools, so the defaults above must be
    // inert there. 7 is neither pg's default (10) nor ours (20), so "unchanged" is distinguishable
    // from either default having been written over it.
    const prebuilt = new Pool({ connectionString: PRIMARY_URL, max: 7 });
    createdPools.length = 0; // discard the fixture; count only what the factory constructs

    const { dbRead, dbWrite } = createKyselyClients<TestDB>({
      pool: prebuilt,
      readPool: prebuilt,
    });

    expect(createdPools).toHaveLength(0);
    expect(prebuilt.options.max).toBe(7);
    expect(prebuilt.options.connectionTimeoutMillis).toBeUndefined();
    expect(dbRead).toBeDefined();
    expect(dbWrite).toBeDefined();
  });

  it('forces sslmode=no-verify on both pools, and still applies the defaults', () => {
    // Pins an ORDER DEPENDENCY that the defaults object introduced. `config` snapshots
    // `poolConfig.connectionString`, so the sslNoVerify rewrite has to run BEFORE that snapshot.
    // Move it after and the primary pool connects without `sslmode=no-verify` — rejected by the
    // pooler's self-signed cert, i.e. dead in production — while every other test here stays green,
    // because no other case passes sslNoVerify at all.
    createKyselyClients<TestDB>({
      connectionString: PRIMARY_URL,
      replicaConnectionString: REPLICA_URL,
      sslNoVerify: true,
    });

    expect(createdPools).toHaveLength(2);
    const [primary, replica] = createdPools;

    // Assert host AND sslmode together: host alone cannot see a missing rewrite, and sslmode alone
    // could be satisfied by reading the wrong pool.
    expect(primary.options.connectionString).toContain('primary.example.test');
    expect(primary.options.connectionString).toContain('sslmode=no-verify');
    expect(replica.options.connectionString).toContain('replica.example.test');
    expect(replica.options.connectionString).toContain('sslmode=no-verify');

    // The SSL path must not bypass the defaults.
    expect(primary.options.max).toBe(20);
    expect(primary.options.connectionTimeoutMillis).toBe(5_000);
    expect(replica.options.max).toBe(20);
    expect(replica.options.connectionTimeoutMillis).toBe(5_000);
  });
});
