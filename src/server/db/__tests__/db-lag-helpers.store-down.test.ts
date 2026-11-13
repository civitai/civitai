import { describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The main app's replication-lag check stays bounded even though the @civitai/db package default is
 * now unbounded: db-lag-helpers sends the flag read through the cluster-cache guard at
 * REPLICATION_LAG_CHECK_TIMEOUT_MS (200ms), so a flag store that never answers routes the read to
 * the replica instead of holding the page.
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

async function load() {
  // The tracker reads REPLICATION_LAG_DELAY when the module is evaluated.
  setEnv({ REPLICATION_LAG_DELAY: 5, REPLICATION_LAG_CHECK_TIMEOUT_MS: 200 });
  vi.resetModules();
  const helpers = await import('~/server/db/db-lag-helpers');
  const { dbRead, dbWrite } = await import('~/server/db/client');
  return { ...helpers, dbRead, dbWrite };
}

describe('getDbWithoutLag with the flag store unavailable', () => {
  it('a flag read that never answers routes to the replica within 450ms', async () => {
    const { getDbWithoutLag, dbRead } = await load();
    redisMock.redis.get.mockImplementation(() => new Promise(() => undefined));

    const started = Date.now();
    const db = await within(getDbWithoutLag('model', 1), 2000);

    expect(db).toBe(dbRead);
    expect(Date.now() - started).toBeLessThan(450);
  });

  it('positive control: a flagged entity still routes to the primary', async () => {
    const { getDbWithoutLag, dbWrite } = await load();
    redisMock.redis.get.mockResolvedValue('true');

    expect(await getDbWithoutLag('model', 1)).toBe(dbWrite);
  });
});
