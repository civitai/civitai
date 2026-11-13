import { afterEach, describe, expect, it } from 'vitest';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

// A pg Pool connects lazily, so none of these pools ever opens a connection; the test reads the
// options the pool was BUILT with, which are what every connection it opens would use.
type BuiltOptions = { max: number; idleTimeoutMillis: number; connectionString: string };
const built = (pool: AugmentedPool) => (pool as unknown as { options: BuiltOptions }).options;

const APPDATA_URL = 'postgres://doc%40user:s3cr%2Ft@db-direct.example:5432/appstore?app=1';
const PRIMARY_URL = 'postgres://main:pw@primary.example:5432/main';

// Pairwise-distinct fixtures, none equal to the schema default (4) or DATABASE_POOL_MAX's (20), so a
// pool that took the wrong setting cannot pass by coincidence.
const SHARED = {
  ssl: false,
  poolMax: 17,
  poolIdleTimeout: 5678,
  databaseUrl: PRIMARY_URL,
} as const;

const pools: AugmentedPool[] = [];
const make = (opts: Parameters<typeof getClient>[0]) => {
  const pool = getClient(opts);
  pools.push(pool);
  return pool;
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

describe('document-store pool sizing', () => {
  it('sizes the appdata pool from its own setting, not DATABASE_POOL_MAX', () => {
    const pool = make({
      ...SHARED,
      instance: 'appdata',
      appdataUrl: APPDATA_URL,
      appdataPoolMax: 3,
    });
    expect(built(pool).max).toBe(3);
  });

  it('defaults the appdata pool to the small schema default when unset', () => {
    const pool = make({ ...SHARED, instance: 'appdata', appdataUrl: APPDATA_URL });
    expect(built(pool).max).toBe(4);
  });

  it.each(['primary', 'apps'] as const)('leaves the %s pool on DATABASE_POOL_MAX', (instance) => {
    const pool = make({
      ...SHARED,
      instance,
      appsUrl: PRIMARY_URL,
      appdataPoolMax: 3,
      appdataPoolIdleTimeout: 1234,
    });
    expect(built(pool).max).toBe(17);
    expect(built(pool).idleTimeoutMillis).toBe(5678);
  });

  it('uses the appdata idle timeout when set, and the shared one when not', () => {
    const own = make({
      ...SHARED,
      instance: 'appdata',
      appdataUrl: APPDATA_URL,
      appdataPoolIdleTimeout: 1234,
    });
    expect(built(own).idleTimeoutMillis).toBe(1234);

    const shared = make({
      ...SHARED,
      instance: 'appdata',
      appdataUrl: APPDATA_URL,
      appdataPoolIdleTimeout: undefined,
    });
    expect(built(shared).idleTimeoutMillis).toBe(5678);
  });
});

describe('document-store host override', () => {
  const connect = (overrides: Parameters<typeof getClient>[0]) =>
    new URL(
      built(
        make({ ...SHARED, instance: 'appdata', appdataUrl: APPDATA_URL, ...overrides })
      ).connectionString
    );

  it('replaces host and port and keeps user, password, database and query', () => {
    const url = connect({ appdataHost: 'pooler.example', appdataPort: 6432 });
    expect(url.hostname).toBe('pooler.example');
    expect(url.port).toBe('6432');
    expect(url.username).toBe('doc%40user');
    expect(url.password).toBe('s3cr%2Ft');
    expect(url.pathname).toBe('/appstore');
    expect(url.searchParams.get('app')).toBe('1');
  });

  it('replaces only the host when no port is given', () => {
    const url = connect({ appdataHost: 'pooler.example', appdataPort: undefined });
    expect(url.hostname).toBe('pooler.example');
    expect(url.port).toBe('5432');
  });

  it('replaces only the port when no host is given', () => {
    const url = connect({ appdataHost: undefined, appdataPort: 6432 });
    expect(url.hostname).toBe('db-direct.example');
    expect(url.port).toBe('6432');
  });

  it('leaves the connection string unchanged when neither is set', () => {
    const url = connect({ appdataHost: undefined, appdataPort: undefined });
    expect(url.toString()).toBe(new URL(APPDATA_URL).toString());
  });

  it('never reroutes another instance', () => {
    const pool = make({
      ...SHARED,
      instance: 'primary',
      appdataHost: 'pooler.example',
      appdataPort: 6432,
    });
    const url = new URL(built(pool).connectionString);
    expect(url.hostname).toBe('primary.example');
    expect(url.port).toBe('5432');
  });

  it('refuses a host the URL would silently truncate', () => {
    // `url.hostname = 'a/b'` yields host `a` without an error; the pool must not quietly connect there.
    expect(() =>
      getClient({ ...SHARED, instance: 'appdata', appdataUrl: APPDATA_URL, appdataHost: 'a/b' })
    ).toThrow(/APPDATA_DATABASE_HOST/);
  });
});
