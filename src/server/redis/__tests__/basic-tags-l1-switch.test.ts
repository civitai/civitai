import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { letLruClockClear } from '@civitai/redis/__tests__/helpers/lru-clock';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The `basic-tags` cache (tagCache) behind BASIC_TAGS_L1_LONG_TTL, through the real cache
 * definition, with the cache cluster faked as a store. Off, its per-pod L1 keeps the 30s it always
 * had; on, 300s. Each case reads at two points inside the window and one past it, and uses its own
 * tag ids, because the cache (and its L1) is one module-level instance for the whole file.
 *
 * The L1 clock is a mocked `performance.now` (see letLruClockClear); the Redis fake reads `Date.now`,
 * which is left alone, so a jump here ages only the L1.
 */

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { isFliptSync } = await import('~/server/flipt/client');
const { tagCache } = await import('~/server/redis/caches');
const { resetL1SwitchesForTests } = await import('~/server/redis/l1-switches');

const PREFIX = 'packed:caches:basic-tags:';
let clock = 0;
const advance = async (seconds: number) => {
  clock += seconds * 1000;
  await letLruClockClear();
};
// How many Redis reads asked for one of this cache's keys.
const redisReads = () =>
  redisMock.redis.packed.mGet.mock.calls.filter(([keys]) =>
    (keys as string[]).some((k) => k.startsWith(PREFIX))
  ).length;

let flag: boolean | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  resetL1SwitchesForTests();
  clock = 5_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  await letLruClockClear();
  vi.mocked(isFliptSync).mockImplementation((key: string) =>
    key === 'basic-tags-l1-long-ttl' ? flag : null
  );
  dbMock.dbRead.tag.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) =>
    args.where.id.in.map((id) => ({
      id,
      name: `tag-${id}`,
      nsfwLevel: id % 5,
      type: 'UserGenerated',
      unlisted: false,
    }))) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const expected = (id: number) => ({
  [id]: { id, name: `tag-${id}`, nsfwLevel: id % 5, type: 'UserGenerated' },
});

describe('tagCache L1: BASIC_TAGS_L1_LONG_TTL', () => {
  it('off (flag absent): the L1 keeps 30s — served inside it, Redis read again past it', async () => {
    flag = null;
    expect(await tagCache.fetch([1101])).toEqual(expected(1101));
    expect(redisReads()).toBe(1);

    await advance(15);
    expect(await tagCache.fetch([1101])).toEqual(expected(1101));
    await advance(14); // 29s
    expect(await tagCache.fetch([1101])).toEqual(expected(1101));
    expect(redisReads()).toBe(1);

    await advance(2); // 31s
    expect(await tagCache.fetch([1101])).toEqual(expected(1101));
    expect(redisReads()).toBe(2);
    // Redis still held it, so the origin was read once.
    expect(dbMock.dbRead.tag.findMany).toHaveBeenCalledTimes(1);
  });

  it('off (flag false): the same 30s', async () => {
    flag = false;
    await tagCache.fetch([1202]);
    await advance(29);
    await tagCache.fetch([1202]);
    expect(redisReads()).toBe(1);
    await advance(2);
    await tagCache.fetch([1202]);
    expect(redisReads()).toBe(2);
  });

  it('on: the L1 keeps 300s — served inside it with no Redis call, Redis read again past it', async () => {
    flag = true;
    expect(await tagCache.fetch([1303, 1304])).toEqual({ ...expected(1303), ...expected(1304) });
    expect(redisReads()).toBe(1);

    await advance(31); // past the old 30s
    expect(await tagCache.fetch([1303, 1304])).toEqual({ ...expected(1303), ...expected(1304) });
    await advance(268); // 299s
    expect(await tagCache.fetch([1304])).toEqual(expected(1304));
    expect(redisReads()).toBe(1);

    await advance(2); // 301s
    expect(await tagCache.fetch([1303])).toEqual(expected(1303));
    expect(redisReads()).toBe(2);
    // The flag is read with no entity and no context: one global switch.
    expect(vi.mocked(isFliptSync).mock.calls).toContainEqual(['basic-tags-l1-long-ttl']);
  });

  it("on: a bust still rewrites the Redis entry, and this pod's next read goes to Redis", async () => {
    flag = true;
    await tagCache.fetch([1405]);
    await tagCache.fetch([1405]);
    expect(redisReads()).toBe(1);

    redisMock.redis.packed.set.mockClear();
    await tagCache.bust(1405);
    expect(redisMock.redis.packed.set.mock.calls.map(([key]) => key)).toEqual([`${PREFIX}1405`]);

    const readsAfterBust = redisReads();
    await tagCache.fetch([1405]);
    expect(redisReads()).toBe(readsAfterBust + 1);
  });
});
