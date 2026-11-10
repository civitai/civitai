import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { letLruClockClear } from '@civitai/redis/__tests__/helpers/lru-clock';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The `tag-ids-for-images` cache (tagIdsForImagesCache) behind TAG_IDS_FOR_IMAGES_L1_LARGE, through
 * the real cache definition, with the cache cluster faked as a store and the database mocked. Off,
 * its per-pod L1 keeps what it always had: 180s and 50,000 entries. On: 600s and 200,000 entries.
 *
 * The capacity cases are the point of the switch (a process can fill the off tier faster than it
 * ages out, so it is capacity-bound, not TTL-bound), so they read 50,001 distinct ids and then the first one again, all inside the TTL: off,
 * the first was evicted and Redis is read; on, it is still held.
 *
 * The L1 clock is a mocked `performance.now` (see letLruClockClear); the Redis fake reads `Date.now`,
 * which is left alone, so a jump here ages only the L1. Each case uses its own image ids, because the
 * cache (and its L1) is one module-level instance for the whole file.
 */

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { isFliptSync } = await import('~/server/flipt/client');
const { tagIdsForImagesCache } = await import('~/server/redis/caches');
const { resetL1SwitchesForTests, tagIdsForImagesLocalLimits } = await import(
  '~/server/redis/l1-switches'
);

const PREFIX = 'packed:caches:tag-ids-for-images:';
const MB = 1024 * 1024;
// Every image carries this one tag, so the tag lookup the cache makes is one id however many images.
const TAG_ID = 777;

let clock = 0;
const advance = async (seconds: number) => {
  clock += seconds * 1000;
  await letLruClockClear();
};
// How many Redis reads asked for this image's key.
const redisReadsOf = (imageId: number) =>
  redisMock.redis.packed.mGet.mock.calls.filter(([keys]) =>
    (keys as string[]).includes(`${PREFIX}${imageId}`)
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
    key === 'tag-ids-for-images-l1-large' ? flag : null
  );
  // getImageTagRows: `$queryRaw` tagged template, the id array is its first value.
  dbMock.dbRead.$queryRaw.mockImplementation((async (_strings: unknown, ids: number[]) =>
    ids.map((imageId) => ({ imageId, tagId: TAG_ID, source: 'User' }))) as never);
  dbMock.dbRead.tag.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) =>
    args.where.id.in.map((id) => ({
      id,
      name: `tag-${id}`,
      nsfwLevel: 1,
      type: 'UserGenerated',
      unlisted: false,
    }))) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const expected = (...ids: number[]) =>
  Object.fromEntries(ids.map((imageId) => [imageId, { imageId, tags: [TAG_ID] }]));

async function readMany(first: number, count: number) {
  const ids = Array.from({ length: count }, (_, i) => first + i);
  for (let i = 0; i < ids.length; i += 5000)
    await tagIdsForImagesCache.fetch(ids.slice(i, i + 5000));
}

describe('tagIdsForImagesCache L1: TAG_IDS_FOR_IMAGES_L1_LARGE', () => {
  it('the two tiers, as literal values', () => {
    expect(tagIdsForImagesLocalLimits(180)).toEqual({ max: 50_000, maxBytes: 30 * MB });
    expect(tagIdsForImagesLocalLimits(600)).toEqual({ max: 200_000, maxBytes: 96 * MB });
  });

  it('off (flag absent): the L1 keeps 180s — served inside it, Redis read again past it', async () => {
    flag = null;
    expect(await tagIdsForImagesCache.fetch([1101])).toEqual(expected(1101));
    expect(redisReadsOf(1101)).toBe(1);

    await advance(179);
    expect(await tagIdsForImagesCache.fetch([1101])).toEqual(expected(1101));
    expect(redisReadsOf(1101)).toBe(1);

    await advance(2); // 181s
    expect(await tagIdsForImagesCache.fetch([1101])).toEqual(expected(1101));
    expect(redisReadsOf(1101)).toBe(2);
  });

  it('on: the L1 keeps 600s — served past the old 180s, Redis read again past 600s', async () => {
    flag = true;
    expect(await tagIdsForImagesCache.fetch([1202, 1203])).toEqual(expected(1202, 1203));
    expect(redisReadsOf(1202)).toBe(1);

    await advance(181);
    expect(await tagIdsForImagesCache.fetch([1202, 1203])).toEqual(expected(1202, 1203));
    await advance(418); // 599s
    expect(await tagIdsForImagesCache.fetch([1202])).toEqual(expected(1202));
    expect(redisReadsOf(1202)).toBe(1);

    await advance(2); // 601s
    expect(await tagIdsForImagesCache.fetch([1202])).toEqual(expected(1202));
    expect(redisReadsOf(1202)).toBe(2);
    // One global switch: read with no entity and no context.
    expect(vi.mocked(isFliptSync).mock.calls).toContainEqual(['tag-ids-for-images-l1-large']);
  });

  it(
    'off: 50,001 distinct ids evict the first (the 50,000-entry cap)',
    { timeout: 120_000 },
    async () => {
      flag = false;
      await readMany(1_000_000, 50_001);
      expect(redisReadsOf(1_000_000)).toBe(1);
      await tagIdsForImagesCache.fetch([1_000_000]);
      expect(redisReadsOf(1_000_000)).toBe(2);
    }
  );

  it(
    'on: the same 50,001 ids all stay, so the first is served from the L1',
    { timeout: 120_000 },
    async () => {
      flag = true;
      await readMany(2_000_000, 50_001);
      expect(redisReadsOf(2_000_000)).toBe(1);
      await tagIdsForImagesCache.fetch([2_000_000]);
      expect(redisReadsOf(2_000_000)).toBe(1);
    }
  );

  it("on: a bust still rewrites Redis, and this pod's next read goes to Redis", async () => {
    flag = true;
    await tagIdsForImagesCache.fetch([1405]);
    await tagIdsForImagesCache.fetch([1405]);
    expect(redisReadsOf(1405)).toBe(1);

    redisMock.redis.packed.set.mockClear();
    await tagIdsForImagesCache.bust(1405);
    // The SWR bust (invalidate) reads the entry and writes it back backdated.
    expect(redisMock.redis.packed.set.mock.calls.map(([key]) => key)).toEqual([`${PREFIX}1405`]);

    const readsAfterBust = redisReadsOf(1405);
    await tagIdsForImagesCache.fetch([1405]);
    expect(redisReadsOf(1405)).toBe(readsAfterBust + 1);
  });
});
