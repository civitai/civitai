import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * `getHomeBlockCached` with the cluster cache unavailable: the block is built from its source and
 * returned, whether the cached-entry read rejects or was sent and never answered, instead of
 * failing the home page or holding it for the client's 15s backstop.
 */

const { getHomeBlockData } = vi.hoisted(() => ({
  getHomeBlockData: vi.fn(async () => ({ id: 31, leaderboards: [{ id: 'weekly' }] })),
}));
vi.mock('~/server/services/home-block.service', () => ({
  getHomeBlockData,
  resolveHomeBlockMetadata: vi.fn(async () => ({})),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { getHomeBlockCached } from '~/server/services/home-block-cache.service';

const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

const BLOCK = { id: 31, type: HomeBlockType.Leaderboard, metadata: {} };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getHomeBlockCached with the cache unavailable', () => {
  it('a rejecting cache read builds the block from its source', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cluster down'));

    const result = await within(getHomeBlockCached(BLOCK as never, undefined, {}), 2000);

    expect(result).not.toBe(HUNG);
    expect(result).toMatchObject({ id: 31, leaderboards: [{ id: 'weekly' }] });
    expect(getHomeBlockData).toHaveBeenCalledTimes(1);
  });

  it('a cache read that never answers builds the block within 750ms', async () => {
    redisMock.redis.packed.get.mockImplementation(() => new Promise(() => undefined));

    const started = Date.now();
    const result = await within(getHomeBlockCached(BLOCK as never, undefined, {}), 2000);

    expect(result).not.toBe(HUNG);
    expect(result).toMatchObject({ leaderboards: [{ id: 'weekly' }] });
    expect(Date.now() - started).toBeLessThan(750);
  });

  it('a cache write that never answers does not hold the block either', async () => {
    redisMock.redis.packed.get.mockResolvedValue(null);
    redisMock.redis.packed.set.mockImplementation(() => new Promise(() => undefined));

    const started = Date.now();
    const result = await within(getHomeBlockCached(BLOCK as never, undefined, {}), 2000);

    expect(result).not.toBe(HUNG);
    expect(Date.now() - started).toBeLessThan(750);
  });
});
