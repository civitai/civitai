import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * `getHomeBlockCached` tells its caller where each answer came from (`onTier`), which is what
 * `home_block_get_total` counts. The real cache over a fake Redis, with the L1 flag on and off.
 */

const { getHomeBlockData } = vi.hoisted(() => ({ getHomeBlockData: vi.fn() }));
vi.mock('~/server/services/home-block.service', () => ({
  getHomeBlockData,
  resolveHomeBlockMetadata: vi.fn(async () => ({})),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import {
  getHomeBlockCached,
  resetHomeBlockL1ForTests,
} from '~/server/services/home-block-cache.service';
import * as homeBlockSource from '~/server/services/home-block.service';

const store = new Map<string, string>();
const leaderboard = {
  id: 11,
  userId: 1,
  sourceId: 5,
  type: HomeBlockType.Leaderboard,
  metadata: {},
};

async function tiersOf(calls: number, block: object = leaderboard, metadata: object = {}) {
  const tiers: string[] = [];
  for (let i = 0; i < calls; i++)
    await getHomeBlockCached(block as never, undefined, metadata as never, homeBlockSource, (t) =>
      tiers.push(t)
    );
  return tiers;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  redisMock.redis.packed.get.mockImplementation(async (key: string) =>
    store.has(key) ? JSON.parse(store.get(key) as string) : null
  );
  redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  });
  getHomeBlockData.mockResolvedValue({ leaderboards: [{ id: 'board' }] });
  resetHomeBlockL1ForTests(() => false);
});

describe('getHomeBlockCached onTier', () => {
  it('L1 off: a cold call is a miss, the next ones are Redis hits', async () => {
    expect(await tiersOf(3)).toEqual(['miss', 'redis', 'redis']);
  });

  it('L1 on: a cold call is a miss, the next ones are L1 hits', async () => {
    resetHomeBlockL1ForTests(() => true);
    expect(await tiersOf(3)).toEqual(['miss', 'l1', 'l1']);
  });

  it('L1 on: an entry already in Redis is a Redis hit first, then L1', async () => {
    store.set('packed:home-blocks:Leaderboard:5:unscoped', JSON.stringify({ leaderboards: [] }));
    resetHomeBlockL1ForTests(() => true);
    expect(await tiersOf(2)).toEqual(['redis', 'l1']);
  });

  it('a block that builds to nothing is still a miss (built from source, nothing stored)', async () => {
    getHomeBlockData.mockResolvedValue(null);
    expect(await tiersOf(2)).toEqual(['miss', 'miss']);
  });

  it('a row with no identifier reports no_identifier and reads nothing', async () => {
    const shop = { id: 12, type: HomeBlockType.CosmeticShop, metadata: {} };
    expect(await tiersOf(1, shop)).toEqual(['no_identifier']);
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
  });

  it('reports exactly once per call', async () => {
    resetHomeBlockL1ForTests(() => true);
    expect((await tiersOf(5)).length).toBe(5);
  });
});
