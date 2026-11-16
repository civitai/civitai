import { afterEach, describe, expect, it } from 'vitest';
import type { AugmentedPool } from './db-helpers';
import { createPool } from './db-helpers';

/**
 * `maxLifetimeSeconds` must reach the pg Pool: pg-pool reads it from the options it was built with
 * (and treats a missing value as 0, "never"), so these read the constructed pool's own `options`.
 * A pg Pool connects lazily, so nothing here opens a connection.
 */
type BuiltOptions = { maxLifetimeSeconds: number };
const built = (pool: AugmentedPool) => (pool as unknown as { options: BuiltOptions }).options;

const URL = 'postgres://user:pw@db.example.test:5432/app';
const pools: AugmentedPool[] = [];
const make = (options: Partial<Parameters<typeof createPool>[0]>) => {
  const pool = createPool({ connectionString: URL, ssl: false, ...options });
  pools.push(pool);
  return pool;
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

describe('createPool max connection lifetime', () => {
  it('passes the configured lifetime to the pool', () => {
    // 437: not pg's default, not a round number any other option uses.
    expect(built(make({ maxLifetimeSeconds: 437 })).maxLifetimeSeconds).toBe(437);
  });

  it('leaves recycling off when unset', () => {
    expect(built(make({})).maxLifetimeSeconds).toBe(0);
  });
});
