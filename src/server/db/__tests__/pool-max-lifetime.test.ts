import { afterEach, describe, expect, it } from 'vitest';
import { dbEnvSchema } from '@civitai/db';
import { serverSchema } from '~/env/server-schema';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

// A pg Pool connects lazily, so no pool here opens a connection; the test reads the options each was
// BUILT with, which pg-pool applies to every connection it opens.
type BuiltOptions = { maxLifetimeSeconds: number };
const built = (pool: AugmentedPool) => (pool as unknown as { options: BuiltOptions }).options;

const URL = 'postgres://main:pw@primary.example:5432/main';
const pools: AugmentedPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

describe('DATABASE_POOL_MAX_LIFETIME_SECONDS', () => {
  it.each(['primary', 'primaryRead', 'datapacketRead'] as const)(
    'reaches the %s pool',
    (instance) => {
      const pool = getClient({
        instance,
        ssl: false,
        databaseUrl: URL,
        replicaUrl: URL,
        datapacketReadUrl: URL,
        poolMaxLifetimeSeconds: 437,
      });
      pools.push(pool);
      expect(built(pool).maxLifetimeSeconds).toBe(437);
    }
  );

  // Validated by the app schema at boot and by @civitai/db's when getClient loads its config: both
  // must agree, or a value would pass boot and fail on the first query.
  describe.each([
    ['app server schema', serverSchema.shape.DATABASE_POOL_MAX_LIFETIME_SECONDS],
    ['@civitai/db schema', dbEnvSchema.shape.DATABASE_POOL_MAX_LIFETIME_SECONDS],
  ])('in the %s', (_name, field) => {
    it('defaults to 0 (off) and parses whole seconds', () => {
      expect(field.parse(undefined)).toBe(0);
      expect(field.parse('1800')).toBe(1800);
      expect(field.parse('0')).toBe(0);
    });

    it.each(['', '-1', '1.5', 'abc', ' 30'])('rejects %j', (input) => {
      expect(field.safeParse(input).success).toBe(false);
    });
  });
});
