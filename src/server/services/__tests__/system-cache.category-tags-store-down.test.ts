import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `getCategoryTags` with the cluster cache unavailable. The category list is rebuilt from the
 * database (its source) when the cached blob cannot be read — whether the read rejects or was sent
 * and never answered — instead of failing the request or holding it for the client's 15s backstop.
 * The system-tags lookup it depends on degrades the same way.
 */

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

async function loadSystemCache() {
  vi.resetModules();
  return import('../system-cache');
}

const CATEGORY_TAG_ID = 501;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.tag.findMany.mockImplementation(async (args: { where?: { type?: string } }) => {
    // getSystemTags asks for System tags; the category query asks for children of the category tag.
    if (args?.where?.type) return [{ id: CATEGORY_TAG_ID, name: 'image category' }];
    return [{ id: 9, name: 'landscape', color: 'blue', adminOnly: false }];
  });
});

describe('getCategoryTags with the cache unavailable', () => {
  it('a rejecting cache read rebuilds the categories from the database', async () => {
    redisMock.redis.get.mockRejectedValue(new Error('cluster down'));
    const { getCategoryTags } = await loadSystemCache();

    const result = await within(getCategoryTags('image'), 2000);

    expect(result).not.toBe(HUNG);
    expect(result).toEqual([expect.objectContaining({ id: 9, name: 'landscape' })]);
  });

  it('a cache read that never answers rebuilds within 1000ms', async () => {
    redisMock.redis.get.mockImplementation(() => new Promise(() => {}));
    const { getCategoryTags } = await loadSystemCache();

    const started = Date.now();
    const result = await within(getCategoryTags('image'), 3000);

    expect(result).not.toBe(HUNG);
    expect(result).toEqual([expect.objectContaining({ id: 9 })]);
    // Two sequential guarded reads (categories, then system tags): 2 × 250ms plus slack.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
