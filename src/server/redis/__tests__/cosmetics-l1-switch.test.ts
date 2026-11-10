import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { letLruClockClear } from '@civitai/redis/__tests__/helpers/lru-clock';
import { NsfwLevel } from '~/server/common/enums';
import type * as PlacementQueries from '@civitai/db-queries/placement';
import type * as FliptClient from '~/server/flipt/client';
import { CosmeticFlag } from '~/shared/constants/cosmetic-flags.constants';

/**
 * The `cosmetics2` catalog cache (cosmeticCache) behind COSMETICS_L1, through the real cache
 * definition with the cache cluster faked as a store. Off, it has no L1 (as before); on, a 60s
 * per-pod L1. Admin edits still refresh Redis, and the kept-off sticker check and the day-long
 * event-decoration cache read past the L1. The frame cache's per-wearer `lights` never land on
 * the shared catalog entry.
 *
 * The cache is one module-level instance for the whole file, so each case uses its own cosmetic
 * ids. The L1 clock is a mocked `performance.now` (see letLruClockClear); the Redis fake reads
 * `Date.now`, left alone, so a jump here ages only the L1.
 */

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { approvedRows } = vi.hoisted(() => ({ approvedRows: vi.fn() }));
vi.mock('@civitai/db-queries/placement', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementQueries>()),
  listApprovedPlacementRows: approvedRows,
}));

const { isFliptSync } = await import('~/server/flipt/client');
const { cosmeticCache, cosmeticEntityCaches, eventDecorationEntityCaches } = await import(
  '~/server/redis/caches'
);
const { resetL1SwitchesForTests } = await import('~/server/redis/l1-switches');
const { setStickerPlacementRating } = await import('~/server/services/cosmetic.service');
const { getStickerPlacementCounts } = await import('~/server/services/sticker-placement.service');

const PREFIX = 'packed:caches:cosmetics2:';
let clock = 0;
const advance = async (seconds: number) => {
  clock += seconds * 1000;
  await letLruClockClear();
};
// Redis reads of a catalog entry (not the cosmetics2:* sub-caches that share the prefix).
const catalogReads = () =>
  redisMock.redis.packed.mGet.mock.calls.filter(([keys]) =>
    (keys as string[]).some((k) => /^packed:caches:cosmetics2:\d+$/.test(k))
  ).length;

let flag: boolean | null = null;
// What the database holds per cosmetic id: the flags column.
let flagsInDb = new Map<number, number>();
const rowsFor = (ids: number[]) =>
  ids.map((id) => ({
    id,
    name: `cosmetic-${id}`,
    type: 'Sticker',
    data: { url: `u-${id}` },
    source: 'Trophy',
    flags: flagsInDb.get(id) ?? 0,
  }));

let fs: ReturnType<typeof installFakeCacheRedis>;

beforeEach(async () => {
  vi.clearAllMocks();
  fs = installFakeCacheRedis();
  resetL1SwitchesForTests();
  clock = 9_000_000;
  flagsInDb = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  await letLruClockClear();
  vi.mocked(isFliptSync).mockImplementation((key: string) =>
    key === 'cosmetics-l1' ? flag : null
  );
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.cosmetic.findMany.mockImplementation((async (args: { where: { id: { in: number[] } } }) =>
      rowsFor(args.where.id.in)) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('cosmeticCache L1: COSMETICS_L1', () => {
  it('off (flag absent): no L1 — every read goes to Redis, as before', async () => {
    flag = null;
    const first = await cosmeticCache.fetch([2101, 2102]);
    await advance(1);
    const second = await cosmeticCache.fetch([2101, 2102]);
    await cosmeticCache.fetch([2102]);

    expect(second).toEqual(first);
    expect(first[2101]).toEqual(expect.objectContaining({ id: 2101, flags: 0 }));
    expect(redisMock.redis.packed.mGet.mock.calls.map(([keys]) => keys)).toEqual([
      [`${PREFIX}2101`, `${PREFIX}2102`],
      [`${PREFIX}2101`, `${PREFIX}2102`],
      [`${PREFIX}2102`],
    ]);
    expect(dbMock.dbRead.cosmetic.findMany).toHaveBeenCalledTimes(1);
  });

  it('on: a second read inside 60s makes no Redis call; one past 60s reads Redis again', async () => {
    flag = true;
    const first = await cosmeticCache.fetch([2203]);
    expect(catalogReads()).toBe(1);

    await advance(30);
    expect(await cosmeticCache.fetch([2203])).toEqual(first);
    await advance(29); // 59s
    expect(await cosmeticCache.fetch([2203])).toEqual(first);
    expect(catalogReads()).toBe(1);

    await advance(2); // 61s
    expect(await cosmeticCache.fetch([2203])).toEqual(first);
    expect(catalogReads()).toBe(2);
    expect(vi.mocked(isFliptSync).mock.calls).toContainEqual(['cosmetics-l1']);
  });

  it("on: an admin edit still refreshes Redis, and the editing pod's next read has it", async () => {
    flag = true;
    await cosmeticCache.fetch([2304]);
    expect((await cosmeticCache.fetch([2304]))[2304].flags).toBe(0); // from the L1

    flagsInDb.set(2304, CosmeticFlag.SfwPlacementsOnly);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ flags: CosmeticFlag.SfwPlacementsOnly }]);
    await setStickerPlacementRating({ id: 2304, rating: 'sfwOnly' });

    expect(fs.peek(`${PREFIX}2304`)).toEqual(
      expect.objectContaining({ id: 2304, flags: CosmeticFlag.SfwPlacementsOnly })
    );
    expect((await cosmeticCache.fetch([2304]))[2304].flags).toBe(CosmeticFlag.SfwPlacementsOnly);
  });

  it('on: another pod keeps its copy up to 60s after an edit (the accepted lag)', async () => {
    flag = true;
    await cosmeticCache.fetch([2405]); // this pod's L1 holds flags 0
    // Another pod's edit: the refreshed entry lands in Redis without touching this pod's L1.
    fs.plant(
      `${PREFIX}2405`,
      { ...rowsFor([2405])[0], flags: CosmeticFlag.SfwPlacementsOnly, cachedAt: new Date() },
      3600
    );

    await advance(59);
    expect((await cosmeticCache.fetch([2405]))[2405].flags).toBe(0);
    await advance(2);
    expect((await cosmeticCache.fetch([2405]))[2405].flags).toBe(CosmeticFlag.SfwPlacementsOnly);
  });
});

// The frame cache's appendFn puts each wearer's `lights` on the frame it reads from cosmetics2.
describe("cosmeticEntityCaches: a wearer's lights stay on that wearer", () => {
  // equippedToId -> the userData its UserCosmetic row holds.
  const wearing = (cosmeticId: number, userData: Record<number, unknown>) =>
    dbMock.dbWrite.$queryRaw.mockImplementation((async (
      _s: unknown,
      idList: { values: number[] }
    ) =>
      idList.values
        .filter((id) => id in userData)
        .map((id) => ({
          cosmeticId,
          equippedToId: id,
          userData: userData[id],
          createdById: null,
        }))) as never);

  // [switch, order, cosmetic id, first entity id]: every case its own ids (one module-level cache).
  const cases = [
    [true, 'lit first', 2601, 8_100],
    [true, 'unlit first', 2602, 8_200],
    [null, 'lit first', 2603, 8_300],
    [null, 'unlit first', 2604, 8_400],
  ] as const;

  it.each(cases)('switch %s, %s: each wearer gets its own lights', async (on, order, cid, base) => {
    flag = on;
    const [lit3, lit5, unlit, later] = [base + 1, base + 2, base + 3, base + 4];
    wearing(cid, { [lit3]: { lights: 3 }, [lit5]: { lights: 5 }, [unlit]: null, [later]: {} });
    const catalog = { url: `u-${cid}` };
    await cosmeticCache.fetch([cid]); // warm: with the switch on, the frame is now in the L1

    const ids = order === 'lit first' ? [lit3, lit5, unlit] : [unlit, lit5, lit3];
    const frames = await cosmeticEntityCaches.Image.fetch(ids);
    expect(frames[lit3].data).toEqual({ ...catalog, lights: 3 });
    expect(frames[lit5].data).toEqual({ ...catalog, lights: 5 });
    expect(frames[unlit].data).toEqual(catalog);
    // A later request, one wearer with no lights: nothing earlier left any on the frame.
    expect((await cosmeticEntityCaches.Image.fetch([later]))[later].data).toEqual(catalog);

    // The cached cosmetic itself is untouched, both this process's copy and Redis's.
    expect((await cosmeticCache.fetch([cid]))[cid].data).toEqual(catalog);
    expect((fs.peek(`${PREFIX}${cid}`) as { data: unknown }).data).toEqual(catalog);
    expect(dbMock.dbRead.cosmetic.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('eventDecorationEntityCaches with COSMETICS_L1 on', () => {
  it("builds a decoration from what Redis holds, not from this pod's older L1 copy", async () => {
    flag = true;
    const [cid, entity] = [2701, 8_501];
    const hat = (url: string) => ({
      id: cid,
      name: `cosmetic-${cid}`,
      type: 'ContentDecoration',
      data: { type: 'hat', event: 'test-event', url },
      source: 'Trophy',
      flags: 0,
    });
    fs.plant(`${PREFIX}${cid}`, { ...hat('old'), cachedAt: new Date() }, 3600);
    expect((await cosmeticCache.fetch([cid]))[cid].data).toMatchObject({ url: 'old' }); // L1 warm
    // Another pod's edit refreshed the Redis entry; this pod's L1 still holds 'old'.
    fs.plant(`${PREFIX}${cid}`, { ...hat('new'), cachedAt: new Date() }, 3600);
    expect((await cosmeticCache.fetch([cid]))[cid].data).toMatchObject({ url: 'old' });
    const readsBefore = catalogReads();

    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { cosmeticId: cid, equippedToId: entity, userId: 9 },
    ]);
    const worn = await eventDecorationEntityCaches.Image.fetch([entity]);

    expect(worn[entity].data).toMatchObject({ url: 'new' });
    expect(catalogReads()).toBe(readsBefore + 1);
    // And that is what the day-long entry holds.
    expect(fs.peek(`packed:caches:cosmetics2:event:v2:Image:${entity}`)).toMatchObject({
      data: { url: 'new' },
    });
  });
});

describe('kept-off sticker check with COSMETICS_L1 on', () => {
  const IMAGE = 7_001;
  const row = (id: number, cosmeticId: number) => ({
    id,
    targetId: IMAGE,
    status: 'approved',
    data: { cosmeticId, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
  });

  it("hides a sticker another pod's moderator just rated, though this pod's L1 has the old flags", async () => {
    flag = true;
    approvedRows.mockResolvedValue([row(1, 2506), row(2, 2507)]);
    dbMock.dbRead.image.findMany.mockResolvedValue([{ id: IMAGE, nsfwLevel: NsfwLevel.XXX }]);

    await cosmeticCache.fetch([2506, 2507]); // both unrated in this pod's L1
    expect(await getStickerPlacementCounts([IMAGE])).toEqual({ [IMAGE]: 2 });

    fs.plant(
      `${PREFIX}2506`,
      { ...rowsFor([2506])[0], flags: CosmeticFlag.SfwPlacementsOnly, cachedAt: new Date() },
      3600
    );
    // Display readers still see this pod's copy...
    expect((await cosmeticCache.fetch([2506]))[2506].flags).toBe(0);
    // ...but the kept-off check reads what Redis holds now.
    expect(await getStickerPlacementCounts([IMAGE])).toEqual({ [IMAGE]: 1 });
  });
});
