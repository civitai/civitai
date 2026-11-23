import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * The per-process L1 in front of the shared home block entry (`home-block-server-cache`).
 *
 * The viewer gates run in `getHomeBlockById` before `getHomeBlockCached` is reached (pinned in
 * home-block-collection-audience.test.ts), so what differs between callers HERE is the row: two
 * clones of a system block (own id, owner and position) pointing at one source. A hit must return
 * each row over the shared content, exactly what the uncached path returns for it.
 */

const { getHomeBlockData } = vi.hoisted(() => ({ getHomeBlockData: vi.fn() }));
vi.mock('~/server/services/home-block.service', () => ({
  getHomeBlockData,
  resolveHomeBlockMetadata: vi.fn(async () => ({})),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { cacheHitCounter, cacheMissCounter } from '@civitai/telemetry/client';
import { homeBlockL1EvictionCounter } from '~/server/prom/home-block-l1.metrics';
import {
  countHomeBlockItems,
  estimateHomeBlockBytes,
  getHomeBlockCached,
  HOME_BLOCK_L1_TTL_MS,
  homeBlockCacheBust,
  evictHomeBlocksForImages,
  evictRetryDelayMs,
  homeBlockCacheKey,
  resetHomeBlockL1ForTests,
} from '~/server/services/home-block-cache.service';
import { reportCsamImages, writeModeratorBlock } from '~/server/services/image.service';
import { blockBannedUserImages, blockUserImagesAsCsam } from '~/server/services/user.service';

type Readable = {
  get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }>;
};
/** The real counter's current value for this cache's series (0 before its first increment). */
async function counted(counter: unknown) {
  const { values } = await (counter as Readable).get();
  return values.find((v) => v.labels.cache_name === 'home-block-l1')?.value ?? 0;
}
async function counters() {
  return {
    hit: await counted(cacheHitCounter),
    miss: await counted(cacheMissCounter),
    evict: await counted(homeBlockL1EvictionCounter),
  };
}

// A fake Redis: values go through a JSON round trip, as a real store's encode/decode would.
const store = new Map<string, string>();
const packedGet = redisMock.redis.packed.get;
const packedSet = redisMock.redis.packed.set;

let builds = 0;
const ROW_A = { id: 11, userId: 1, index: 0, sourceId: 5 };
const ROW_B = { id: 12, userId: 2, index: 3, sourceId: 5 };
const leaderboard = (row: typeof ROW_A) => ({
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

async function serveBothRows() {
  const a1 = await getHomeBlockCached(leaderboard(ROW_A) as never, undefined, {});
  const b = await getHomeBlockCached(leaderboard(ROW_B) as never, undefined, {});
  const a2 = await getHomeBlockCached(leaderboard(ROW_A) as never, undefined, {});
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
    const out = await serveBothRows();
    expect(out).toEqual([EXPECTED_A, EXPECTED_B, EXPECTED_A]);
    expect(packedGet).toHaveBeenCalledTimes(3);
    expect(getHomeBlockData).toHaveBeenCalledTimes(1);
  });

  it('on: two clone rows of one source get the uncached output, each with its own row', async () => {
    const uncached = await serveBothRows();

    store.clear();
    builds = 0;
    vi.clearAllMocks();
    setFlag(true);
    const cached = await serveBothRows();

    expect(cached).toEqual(uncached);
    expect(cached).toEqual([EXPECTED_A, EXPECTED_B, EXPECTED_A]);
    // One Redis read (the cold miss), then both rows are served from the L1.
    expect(packedGet).toHaveBeenCalledTimes(1);
    expect(getHomeBlockData).toHaveBeenCalledTimes(1);
  });

  it('on: a Redis hit fills the L1, so the next call skips Redis', async () => {
    store.set(
      'packed:home-blocks:Leaderboard:5:unscoped',
      JSON.stringify({ id: 99, userId: 9, leaderboards: [{ id: 'from-redis' }] })
    );
    setFlag(true);
    const a = await getHomeBlockCached(leaderboard(ROW_A) as never, undefined, {});
    const b = await getHomeBlockCached(leaderboard(ROW_B) as never, undefined, {});
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
    const none = await getHomeBlockCached(leaderboard(ROW_A) as never, undefined, {});
    const red = await getHomeBlockCached(leaderboard(ROW_A) as never, 'red' as never, {});
    const green = await getHomeBlockCached(leaderboard(ROW_A) as never, 'green' as never, {});
    const otherSource = await getHomeBlockCached(
      leaderboard({ ...ROW_A, sourceId: 6 }) as never,
      undefined,
      {}
    );
    const otherType = await getHomeBlockCached(
      { ...ROW_A, type: HomeBlockType.Announcement, metadata: {} } as never,
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
    const again = await getHomeBlockCached(leaderboard(ROW_A) as never, 'red' as never, {});
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
    await getHomeBlockCached(leaderboard(ROW_A) as never, 'red' as never, {});
    await homeBlockCacheBust(HomeBlockType.Leaderboard, 5);
    const rebuilt = await getHomeBlockCached(leaderboard(ROW_A) as never, 'red' as never, {});
    expect(rebuilt?.leaderboards).toEqual([{ id: 'board-red-2' }]);
    expect(getHomeBlockData).toHaveBeenCalledTimes(2);
  });

  it('on: changing a served object does not change what the next row gets', async () => {
    setFlag(true);
    const served = await getHomeBlockCached(leaderboard(ROW_A) as never, undefined, {});
    const a = served as Record<string, unknown>;
    a.leaderboards = [];
    a.extra = true;
    const b = await getHomeBlockCached(leaderboard(ROW_B) as never, undefined, {});
    expect(b).toEqual(EXPECTED_B);
  });

  it('on: every L1 read is counted as a hit or a miss; off counts nothing', async () => {
    const before = await counters();
    await serveBothRows();
    expect(await counters()).toEqual(before);

    store.clear();
    setFlag(true);
    await serveBothRows();
    const after = await counters();
    expect(after.hit - before.hit).toBe(2);
    expect(after.miss - before.miss).toBe(1);
    expect(after.evict - before.evict).toBe(0);
  });

  it('on: an entry pushed out for room is counted as an eviction', async () => {
    // 1,000 items each: ~3.9MB by the estimate, so the third of three overflows the 10MB budget.
    getHomeBlockData.mockImplementation(async () => {
      builds++;
      return { leaderboards: Array.from({ length: 1000 }, (_, i) => ({ id: `b${builds}-${i}` })) };
    });
    setFlag(true);
    const before = await counters();
    for (const sourceId of [1, 2, 3]) {
      await getHomeBlockCached(leaderboard({ ...ROW_A, sourceId }) as never, undefined, {});
    }
    expect((await counters()).evict - before.evict).toBe(1);

    // The oldest one is the one that went: reading it again misses the L1 and goes to Redis.
    vi.clearAllMocks();
    await getHomeBlockCached(leaderboard({ ...ROW_A, sourceId: 1 }) as never, undefined, {});
    expect(packedGet).toHaveBeenCalledTimes(1);
    expect((await counters()).miss - before.miss).toBe(4);
  });

  it('sizes an entry by its item count, without serialising it', () => {
    const block = {
      metadata: {},
      collection: { items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] },
      leaderboards: [{ results: [7, 8] }, { results: [9] }],
    };
    // 3 collection items + 2 boards + 3 board results.
    expect(countHomeBlockItems(block)).toBe(8);
    expect(estimateHomeBlockBytes(block as never)).toBe(36_864);
  });

  it('keeps a copy for 10s, not the edge cache 60s (constant pin, see the STALENESS note)', () => {
    expect(HOME_BLOCK_L1_TTL_MS).toBe(10_000);
  });
});

describe('hiding an image refreshes the home blocks holding it', () => {
  const pg = { db: null as unknown as PGlite };
  const OWNER = 7;
  const COLLECTION = 40;
  const PRIVATE_COLLECTION = 41;
  const COVER_COLLECTION = 42;
  const UNLISTED_COVER_COLLECTION = 43;
  const PRIVATE_COVER_COLLECTION = 44;
  const FEATURED_BLOCK = 900;
  let lagged = false;

  // A tagged call passes the template; `$queryRaw(Prisma.sql`…`)` passes a built query.
  const sqlOn =
    (pick: (r: { rows: unknown[]; affectedRows?: number }) => unknown) =>
    async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      const flat = Array.isArray(strings)
        ? Prisma.sql(strings as TemplateStringsArray, ...(values as never[]))
        : (strings as Prisma.Sql);
      return pick(await pg.db.query(flat.text, flat.values as unknown[]));
    };
  const ingestionOf = async (id: number) =>
    (await pg.db.query<{ ingestion: string }>(`SELECT ingestion FROM "Image" WHERE id = $1`, [id]))
      .rows[0].ingestion;

  beforeAll(async () => {
    pg.db = new PGlite();
    await pg.db.exec(`
      CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
      CREATE TABLE "Image" (
        id int PRIMARY KEY,
        "userId" int NOT NULL,
        "postId" int,
        ingestion "ImageIngestionStatus" NOT NULL,
        "blockedFor" text,
        "nsfwLevel" int NOT NULL DEFAULT 0,
        "needsReview" text,
        "pHash" bigint,
        metadata jsonb,
        "updatedAt" timestamp(3)
      );
      CREATE TABLE "CsamQueueSetAside" ("imageId" int, outcome text);
      CREATE TABLE "Collection" (id int PRIMARY KEY, read text NOT NULL, "imageId" int);
      CREATE INDEX "Collection_imageId_idx" ON "Collection" ("imageId");
      CREATE TABLE "CollectionItem" ("collectionId" int NOT NULL, "imageId" int);
    `);
  }, 60_000);

  beforeEach(async () => {
    setFlag(true);
    lagged = false;
    const rows = sqlOn((r) => r.rows);
    dbMock.dbWrite.$queryRaw.mockImplementation(rows as never);
    dbMock.dbWrite.$executeRaw.mockImplementation(sqlOn((r) => r.affectedRows ?? 0) as never);
    dbMock.dbRead.$queryRaw.mockImplementation(rows as never);
    dbMock.dbWrite.image.updateMany.mockImplementation((async ({
      where,
      data,
    }: {
      where: { userId: number; id?: { in: number[] } };
      data: { ingestion: string; nsfwLevel: number; blockedFor: string; needsReview?: string };
    }) => {
      if (data.needsReview) {
        const flagged = await pg.db.query(
          `UPDATE "Image" SET "needsReview" = $1 WHERE id = ANY($2::int[])`,
          [data.needsReview, where.id?.in ?? []]
        );
        return { count: flagged.affectedRows ?? 0 };
      }
      const { affectedRows } = await pg.db.query(
        `UPDATE "Image" SET ingestion = $1, "nsfwLevel" = $2, "blockedFor" = $3 WHERE "userId" = $4`,
        [data.ingestion, data.nsfwLevel, data.blockedFor, where.userId]
      );
      return { count: affectedRows ?? 0 };
    }) as never);
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue([
      { id: FEATURED_BLOCK, metadata: { featuredCollections: { collectionIds: [COLLECTION] } } },
    ] as never);
    // Stands in for the collection read, which keeps only Scanned images.
    getHomeBlockData.mockImplementation(async () => {
      builds++;
      // A lagged replica does not have the block yet.
      const visible = lagged ? '' : `AND i.ingestion = 'Scanned' AND i."needsReview" IS NULL`;
      const { rows: items } = await pg.db.query<{ id: number }>(
        `SELECT i.id FROM "CollectionItem" ci JOIN "Image" i ON i.id = ci."imageId"
         WHERE ci."collectionId" = $1 ${visible} ORDER BY i.id`,
        [COLLECTION]
      );
      return { collection: { id: COLLECTION, read: 'Public', items } };
    });
    await pg.db.exec(`
      TRUNCATE "Image"; TRUNCATE "Collection"; TRUNCATE "CollectionItem";
      INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel") VALUES
        (1, ${OWNER}, 'Scanned', 1), (2, 99, 'Scanned', 1);
      INSERT INTO "Collection" (id, read, "imageId") VALUES
        (${COLLECTION}, 'Public', NULL), (${PRIVATE_COLLECTION}, 'Private', 1),
        (${COVER_COLLECTION}, 'Public', 1), (${UNLISTED_COVER_COLLECTION}, 'Unlisted', 1),
        (${PRIVATE_COVER_COLLECTION}, 'Private', 1);
      INSERT INTO "CollectionItem" ("collectionId", "imageId") VALUES
        (${COLLECTION}, 1), (${COLLECTION}, 2), (${PRIVATE_COLLECTION}, 1);
    `);
  });

  const readItems = async () => {
    const block = await getHomeBlockCached(
      { id: 500, type: HomeBlockType.Collection, metadata: {}, sourceId: null } as never,
      undefined,
      { collection: { id: COLLECTION } } as never
    );
    return (block as { collection: { items: { id: number }[] } }).collection.items.map((i) => i.id);
  };

  it('a moderator block: the next read no longer has the image', async () => {
    expect(await readItems()).toEqual([1, 2]);
    expect(await readItems()).toEqual([1, 2]);
    expect(builds).toBe(1); // read from the entry, so the next read would be too

    const atBust: string[] = [];
    redisMock.redis.del.mockImplementation(async (key: string) => {
      atBust.push(await ingestionOf(1));
      return store.delete(key) ? 1 : 0;
    });
    await writeModeratorBlock([1]);

    expect(atBust.length).toBeGreaterThan(0);
    expect(new Set(atBust)).toEqual(new Set(['Blocked'])); // refreshed after the write, not before
    expect(await readItems()).toEqual([2]);
    expect(builds).toBe(2);
  });

  it("a ban's media block: the next read no longer has the owner's image", async () => {
    expect(await readItems()).toEqual([1, 2]);

    await blockBannedUserImages(OWNER);

    expect(await readItems()).toEqual([2]);
  });

  // softDeleteUser's call to it: toggle-ban-search-index.test.ts.
  it("blockUserImagesAsCsam (the soft delete's media block): the next read no longer has the owner's image", async () => {
    expect(await readItems()).toEqual([1, 2]);

    await blockUserImagesAsCsam(OWNER);

    expect(await ingestionOf(1)).toBe('Blocked');
    expect(await readItems()).toEqual([2]);
  });

  it('refreshes the FeaturedCollections block that features the collection', async () => {
    const featuredKey = homeBlockCacheKey(HomeBlockType.FeaturedCollections, FEATURED_BLOCK);
    store.set(featuredKey, JSON.stringify({ pickedCollections: [{ items: [{ id: 1 }] }] }));

    await writeModeratorBlock([1]);

    expect(store.has(featuredKey)).toBe(false);
  });

  it('leaves collections no one else may read alone: they have no shared entry', async () => {
    await writeModeratorBlock([1]);

    const busted = redisMock.redis.del.mock.calls.map(([key]) => String(key));
    expect(busted).toContain(homeBlockCacheKey(HomeBlockType.Collection, COLLECTION));
    expect(busted.some((key) => key.includes(`:${PRIVATE_COLLECTION}`))).toBe(false);
  });

  const bustedKeys = () => redisMock.redis.del.mock.calls.map(([key]) => String(key));

  it('refreshes a collection whose cover is the image, though the image is not one of its items', async () => {
    await writeModeratorBlock([1]);

    expect(bustedKeys()).toContain(homeBlockCacheKey(HomeBlockType.Collection, COVER_COLLECTION));
  });

  it("a ban's media block refreshes the collections whose cover is the owner's image", async () => {
    await blockBannedUserImages(OWNER);

    expect(bustedKeys()).toContain(homeBlockCacheKey(HomeBlockType.Collection, COVER_COLLECTION));
    expect(bustedKeys()).toContain(
      homeBlockCacheKey(HomeBlockType.Collection, UNLISTED_COVER_COLLECTION)
    );
    expect(bustedKeys().some((key) => key.includes(`:${PRIVATE_COVER_COLLECTION}:`))).toBe(false);
  });

  it('a CSAM report: the next read no longer has the image', async () => {
    expect(await readItems()).toEqual([1, 2]);

    await reportCsamImages({ imageIds: [1], user: { id: 9001, isModerator: true } } as never);

    expect(await readItems()).toEqual([2]);
  });

  it('a CSAM report refreshes the collections holding that image, not those of another', async () => {
    await reportCsamImages({ imageIds: [2], user: { id: 9001, isModerator: true } } as never);

    expect(bustedKeys()).toContain(homeBlockCacheKey(HomeBlockType.Collection, COLLECTION));
    expect(bustedKeys()).not.toContain(
      homeBlockCacheKey(HomeBlockType.Collection, COVER_COLLECTION)
    );
  });

  // The cover lookup needs that index; without it the item lookup still runs.
  it('without the cover index, still refreshes the collections holding the image', async () => {
    await pg.db.exec(`DROP INDEX "Collection_imageId_idx"`);
    try {
      await writeModeratorBlock([1]);
    } finally {
      await pg.db.exec(`CREATE INDEX "Collection_imageId_idx" ON "Collection" ("imageId")`);
    }

    expect(bustedKeys()).toContain(homeBlockCacheKey(HomeBlockType.Collection, COLLECTION));
    expect(bustedKeys()).not.toContain(
      homeBlockCacheKey(HomeBlockType.Collection, COVER_COLLECTION)
    );
  });

  // A delete resolves its collections before the delete takes the items with it.
  it('given collection ids, refreshes the ones anyone may read', async () => {
    await evictHomeBlocksForImages({ collectionIds: [COLLECTION, PRIVATE_COLLECTION] });

    expect(bustedKeys()).toContain(homeBlockCacheKey(HomeBlockType.Collection, COLLECTION));
    expect(bustedKeys().some((key) => key.includes(`:${PRIVATE_COLLECTION}`))).toBe(false);
  });

  it('refreshes again once replicas catch up, clearing a refill read before they had', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(await readItems()).toEqual([1, 2]);
      lagged = true;
      await writeModeratorBlock([1]);
      expect(await readItems()).toEqual([1, 2]); // rebuilt from the lagged read
      lagged = false;

      await vi.advanceTimersByTimeAsync(evictRetryDelayMs());
      await new Promise((resolve) => setImmediate(resolve)); // the timer's refresh is not awaited

      expect(await readItems()).toEqual([2]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A floor, not the lag itself: REPLICATION_LAG_DELAY defaults to 0, and a refresh at 0 would run
  // before the replica it is waiting on.
  it('waits at least 5s before the second refresh', () => {
    expect(evictRetryDelayMs()).toBeGreaterThanOrEqual(5_000);
  });

  it('a failed refresh does not fail the block', async () => {
    redisMock.redis.del.mockRejectedValue(new Error('redis down'));
    await expect(writeModeratorBlock([1])).resolves.toBeDefined();
    expect(redisMock.redis.del).toHaveBeenCalled(); // the refresh ran and threw
    expect(await ingestionOf(1)).toBe('Blocked');
  });

  it('a failed lookup of the collections does not fail the block', async () => {
    dbMock.dbRead.$queryRaw.mockRejectedValue(new Error('replica down'));
    await expect(writeModeratorBlock([1])).resolves.toBeDefined();
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalled();
    expect(await ingestionOf(1)).toBe('Blocked');
  });
});
