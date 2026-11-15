import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * The per-process L1 in front of the shared home block entry (`home-block-server-cache`).
 *
 * The viewer gates run in `getHomeBlockById` before `getHomeBlockCached` is reached (pinned in
 * home-block-collection-audience.test.ts), so what differs per viewer HERE is the row: each viewer
 * has their own clone of a system block (own id, owner and position) pointing at one source. A hit
 * must return each viewer their own row over the shared content, exactly what the uncached path
 * returns them.
 */

const { getHomeBlockData } = vi.hoisted(() => ({ getHomeBlockData: vi.fn() }));
vi.mock('~/server/services/home-block.service', () => ({
  getHomeBlockData,
  resolveHomeBlockMetadata: vi.fn(async () => ({})),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import {
  getHomeBlockCached,
  homeBlockCacheBust,
  homeBlockCacheKey,
  resetHomeBlockL1ForTests,
} from '~/server/services/home-block-cache.service';

// A fake Redis: values go through a JSON round trip, as a real store's encode/decode would.
const store = new Map<string, string>();
const packedGet = redisMock.redis.packed.get;
const packedSet = redisMock.redis.packed.set;

let builds = 0;
const VIEWER_A = { id: 11, userId: 1, index: 0, sourceId: 5 };
const VIEWER_B = { id: 12, userId: 2, index: 3, sourceId: 5 };
const leaderboard = (row: typeof VIEWER_A) => ({
  ...row,
  type: HomeBlockType.Leaderboard,
  metadata: {},
});

function setFlag(on: boolean) {
  resetHomeBlockL1ForTests(() => on);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  builds = 0;
  packedGet.mockImplementation(async (key: string) =>
    store.has(key) ? JSON.parse(store.get(key) as string) : null
  );
  packedSet.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  });
  redisMock.redis.del.mockImplementation(async (key: string) => (store.delete(key) ? 1 : 0));
  // Content depends on the domain and on how many builds ran, so a wrong share is visible.
  getHomeBlockData.mockImplementation(async ({ input }: { input: { domain?: string } }) => {
    builds++;
    return { leaderboards: [{ id: `board-${input.domain ?? 'none'}-${builds}` }] };
  });
  setFlag(false);
});

async function serveBothViewers() {
  const a1 = await getHomeBlockCached(leaderboard(VIEWER_A) as never, undefined, {});
  const b = await getHomeBlockCached(leaderboard(VIEWER_B) as never, undefined, {});
  const a2 = await getHomeBlockCached(leaderboard(VIEWER_A) as never, undefined, {});
  return [a1, b, a2];
}

const EXPECTED_A = {
  id: 11,
  userId: 1,
  index: 0,
  sourceId: 5,
  type: 'Leaderboard',
  metadata: {},
  leaderboards: [{ id: 'board-none-1' }],
};
const EXPECTED_B = { ...EXPECTED_A, id: 12, userId: 2, index: 3 };

describe('home-block-server-cache', () => {
  it('off: every call reads the shared Redis entry (the old path)', async () => {
    const out = await serveBothViewers();
    expect(out).toEqual([EXPECTED_A, EXPECTED_B, EXPECTED_A]);
    expect(packedGet).toHaveBeenCalledTimes(3);
    expect(getHomeBlockData).toHaveBeenCalledTimes(1);
  });

  it('on: a hit gives each viewer the same output as the uncached path, with their own row', async () => {
    const uncached = await serveBothViewers();

    store.clear();
    builds = 0;
    vi.clearAllMocks();
    setFlag(true);
    const cached = await serveBothViewers();

    expect(cached).toEqual(uncached);
    expect(cached).toEqual([EXPECTED_A, EXPECTED_B, EXPECTED_A]);
    // One Redis read (the cold miss), then both viewers are served from the L1.
    expect(packedGet).toHaveBeenCalledTimes(1);
    expect(getHomeBlockData).toHaveBeenCalledTimes(1);
  });

  it('on: a Redis hit fills the L1, so the next call skips Redis', async () => {
    store.set(
      'packed:home-blocks:Leaderboard:5:unscoped',
      JSON.stringify({ id: 99, userId: 9, leaderboards: [{ id: 'from-redis' }] })
    );
    setFlag(true);
    const a = await getHomeBlockCached(leaderboard(VIEWER_A) as never, undefined, {});
    const b = await getHomeBlockCached(leaderboard(VIEWER_B) as never, undefined, {});
    expect(a).toEqual({ ...EXPECTED_A, leaderboards: [{ id: 'from-redis' }] });
    expect(b).toEqual({ ...EXPECTED_B, leaderboards: [{ id: 'from-redis' }] });
    expect(packedGet).toHaveBeenCalledTimes(1);
    expect(getHomeBlockData).not.toHaveBeenCalled();
  });

  it('the key is the type, the identifier and the domain, and nothing else', () => {
    expect(homeBlockCacheKey(HomeBlockType.Leaderboard, 5, 'red' as never)).toBe(
      'packed:home-blocks:Leaderboard:5:red'
    );
    expect(homeBlockCacheKey(HomeBlockType.Collection, 70, undefined)).toBe(
      'packed:home-blocks:Collection:70:unscoped'
    );
  });

  it('on: each domain, identifier and type gets its own entry', async () => {
    setFlag(true);
    const none = await getHomeBlockCached(leaderboard(VIEWER_A) as never, undefined, {});
    const red = await getHomeBlockCached(leaderboard(VIEWER_A) as never, 'red' as never, {});
    const green = await getHomeBlockCached(leaderboard(VIEWER_A) as never, 'green' as never, {});
    const otherSource = await getHomeBlockCached(
      leaderboard({ ...VIEWER_A, sourceId: 6 }) as never,
      undefined,
      {}
    );
    const otherType = await getHomeBlockCached(
      { ...VIEWER_A, type: HomeBlockType.Announcement, metadata: {} } as never,
      undefined,
      {}
    );
    expect([none, red, green, otherSource, otherType].map((b) => b?.leaderboards)).toEqual([
      [{ id: 'board-none-1' }],
      [{ id: 'board-red-2' }],
      [{ id: 'board-green-3' }],
      [{ id: 'board-none-4' }],
      [{ id: 'board-none-5' }],
    ]);
    // And each is now held: a second round builds nothing and reads no Redis.
    vi.clearAllMocks();
    const again = await getHomeBlockCached(leaderboard(VIEWER_A) as never, 'red' as never, {});
    expect(again?.leaderboards).toEqual([{ id: 'board-red-2' }]);
    expect(packedGet).not.toHaveBeenCalled();
    expect(getHomeBlockData).not.toHaveBeenCalled();
  });

  it('on: a collection not everyone may read is never kept', async () => {
    getHomeBlockData.mockImplementation(async () => {
      builds++;
      return { collection: { read: 'Private', items: [builds] } };
    });
    setFlag(true);
    const row = { id: 9, type: HomeBlockType.Collection, metadata: { collection: { id: 90 } } };
    const first = await getHomeBlockCached(row as never, undefined, row.metadata as never);
    const second = await getHomeBlockCached(row as never, undefined, row.metadata as never);
    expect(first?.collection).toEqual({ read: 'Private', items: [1] });
    expect(second?.collection).toEqual({ read: 'Private', items: [2] });
    expect(packedSet).not.toHaveBeenCalled();
  });

  it('on: a bust drops this process’s entry along with the Redis one', async () => {
    setFlag(true);
    await getHomeBlockCached(leaderboard(VIEWER_A) as never, 'red' as never, {});
    await homeBlockCacheBust(HomeBlockType.Leaderboard, 5);
    const rebuilt = await getHomeBlockCached(leaderboard(VIEWER_A) as never, 'red' as never, {});
    expect(rebuilt?.leaderboards).toEqual([{ id: 'board-red-2' }]);
    expect(getHomeBlockData).toHaveBeenCalledTimes(2);
  });

  it('on: changing a served object does not change what the next viewer gets', async () => {
    setFlag(true);
    const served = await getHomeBlockCached(leaderboard(VIEWER_A) as never, undefined, {});
    const a = served as Record<string, unknown>;
    a.leaderboards = [];
    a.extra = true;
    const b = await getHomeBlockCached(leaderboard(VIEWER_B) as never, undefined, {});
    expect(b).toEqual(EXPECTED_B);
  });
});
