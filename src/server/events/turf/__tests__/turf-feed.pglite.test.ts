import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TurfWatch from '~/server/events/turf/turf-watch';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { eventPointKeys, eventSeasonKeys } from '~/server/events/points/keys';
import { turfConfigKey } from '~/server/events/turf/config';
import { turfKeys, turfRankScore } from '~/server/events/turf/turf-map';

/**
 * The feed's Hat Turf indexes, kept by the turf write against real sticker rows, and the reads the
 * feed sorts and Show filters make of them. Ids and numbers are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const START = new Date('2026-11-01T00:00:00Z');
const HOUR = 3600_000;
const TEAMS = ['Blue', 'Pink', 'Green', 'Gold'];
const COSMETIC: Record<string, number> = { Blue: 11, Pink: 12, Green: 13, Gold: 14 };
// Blue 1-3 and 8, Pink 4-6. User 8 joined after the start below the tier: shown, never counted.
const teamOf = (userId: number) => (userId <= 3 || userId === 8 ? 'Blue' : 'Pink');
const EVENT = {
  name: 'e',
  startDate: START,
  endDate: new Date('2099-12-01T00:00:00Z'),
  teams: TEAMS,
  scoring: { finalizeAfterMs: 0 },
  turf: {
    mode: 'live',
    testerFlag: 'e-turf',
    supply: [{ from: START, perHour: 5, cap: 50 }],
    creditedPlayers: [{ from: START, players: 25 }],
    renderLimit: 12,
    mapMaxEntries: 100,
  },
  getUserTeam: vi.fn(async (userId: number) => teamOf(userId)),
  getTeamCosmetic: async (team: string) => COSMETIC[team],
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
// getTurfStock and getTurfSummaries read through Kysely, not Prisma's `$queryRaw`: both Kysely
// clients' statements go to the same PGlite (see beforeEach).
const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('~/server/db/kyselyDb.lazy', async () =>
  (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
);
vi.mock('~/server/events/turf/turf-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfWatch>()),
  pushTurfCounts: async () => undefined,
}));

const { getTurfEvent, getTurfStock, reconcileTurf, syncTurfImages } = await import(
  '~/server/events/turf/turf.service'
);
const { fillTurfPage, getHatTurfFeedEvent, readMyTurfPage, readTurfRankPage, turfHiddenIds } =
  await import('~/server/events/turf/turf-feed');

const OWNER = 7;
const keys = turfKeys('e');
const teamBase = eventSeasonKeys('e', 'live').base('team');

let db: PGlite;
let redis: LuaRedis;
let override: string | null = null;
let clock = new Date('2026-11-10T00:00:00Z').getTime();
const later = () => new Date((clock += 10 * 60_000));
let nextImage = 1000;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, settings jsonb, "bannedAt" timestamptz, "deletedAt" timestamptz,
      "createdAt" timestamptz DEFAULT '2020-01-01', meta jsonb, flags int NOT NULL DEFAULT 0
    );
    CREATE TABLE "CreatorMilestone" (key text PRIMARY KEY, threshold numeric);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamptz, availability text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, "postId" int, ingestion text DEFAULT 'Scanned',
      "tosViolation" boolean DEFAULT false, "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "Collection" (id int PRIMARY KEY, mode text);
    CREATE TABLE "CollectionItem" (id serial PRIMARY KEY, "collectionId" int, "imageId" int);
    -- contestEntry also reads running flag Crucibles.
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "Crucible" (id int PRIMARY KEY, status "CrucibleStatus", "eventTags" text[]);
    CREATE TABLE "CrucibleEntry" (id serial PRIMARY KEY, "crucibleId" int, "imageId" int);
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "EventTurfSticker" (
      id bigserial PRIMARY KEY, event text, "imageId" int, "userId" int, team text,
      "cosmeticId" int, data jsonb, "createdAt" timestamptz DEFAULT now(), "removedAt" timestamptz,
      UNIQUE (event, "imageId", "userId")
    );
    INSERT INTO "User" (id, settings) VALUES (${OWNER}, '{}'),
      ${[1, 2, 3, 4, 5, 6].map((id) => `(${id}, '{"eventTurfOptIn": {"e": "true"}}')`).join(',')};
    INSERT INTO "User" (id, settings, "createdAt") VALUES
      (8, '{"eventTurfOptIn": {"e": "true"}}', '2026-11-05');
    INSERT INTO "Post" VALUES (1, '2026-10-01', 'Public');
    INSERT INTO "Collection" VALUES (1, 'Contest');
  `);
});
afterAll(async () => db.close());

beforeEach(async () => {
  await db.exec(`DELETE FROM "EventTurfSticker"; DELETE FROM "CollectionItem"`);
  override = null;
  redis = createLuaRedis(0);
  const raw = pgliteRaw(db);
  kysely.read.mockReset().mockImplementation(raw.queryRaw);
  kysely.write.mockReset().mockImplementation(raw.queryRaw);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  redisMock.sysRedis.get.mockImplementation((async (key: string) =>
    key === turfConfigKey('e') ? override : null) as never);
  redisMock.sysRedis.hmGet.mockImplementation((async (key: string, fields: string[]) =>
    key === teamBase
      ? fields.map(() => '1000')
      : fields.map((field) => redis.hash(key)?.[field] ?? null)) as never);
  redisMock.sysRedis.smIsMember.mockImplementation((async (key: string, members: string[]) => {
    const set = new Set(redis.set(key) ?? []);
    return members.map((m) => set.has(m));
  }) as never);
  redisMock.sysRedis.sMembers.mockImplementation(
    (async (key: string) => redis.set(key) ?? []) as never
  );
  redisMock.sysRedis.zRange.mockImplementation((async (key: string) =>
    Object.keys(redis.zset(key) ?? {})) as never);
  redisMock.sysRedis.eval.mockImplementation(redis.eval as never);
  redisMock.sysRedis.incr.mockImplementation((async () => (clock += 1)) as never);
  redisMock.sysRedis.hGetAll.mockImplementation(
    (async (key: string) => redis.hash(key) ?? {}) as never
  );
  redisMock.sysRedis.xAdd.mockResolvedValue('0-1' as never);
});

const newImage = async () => {
  const id = nextImage++;
  await db.query(`INSERT INTO "Image" (id, "userId", "postId") VALUES ($1, $2, 1)`, [id, OWNER]);
  return id;
};
const sticker = (imageId: number, userId: number, createdAt = new Date(clock - HOUR)) =>
  db.query(
    `INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data, "createdAt")
     VALUES ('e', $1, $2, $3, $4, '{"x": 0.1, "y": 0.1, "scale": 0.2, "rotation": 0}', $5)`,
    [imageId, userId, teamOf(userId), COSMETIC[teamOf(userId)], createdAt]
  );
const event = async (now = later()) => (await getTurfEvent('e', now))!;
const sync = async (...imageIds: number[]) => {
  const now = later();
  await syncTurfImages(await event(now), imageIds, now);
};
const total = () => redis.zset(keys.rankTotal) ?? {};
const team = (name: string) => redis.zset(keys.rankTeam(name)) ?? {};
const hatted = () => (redis.set(keys.hatted) ?? []).map(Number).sort();
/** An image with `blue` and `pink` counted stickers from players 1-3 and 4-6. */
const imageWith = async (blue: number, pink: number) => {
  const id = await newImage();
  for (let i = 0; i < blue; i++) await sticker(id, 1 + i);
  for (let i = 0; i < pink; i++) await sticker(id, 4 + i);
  return id;
};

describe('the turf write keeps the feed indexes', () => {
  it('ranks an image by its counted hats, overall and per team, and marks it hatted', async () => {
    const image = await imageWith(2, 1);
    await sync(image);
    expect(total()).toEqual({ [image]: turfRankScore(3, image) });
    expect(team('Blue')).toEqual({ [image]: turfRankScore(2, image) });
    expect(team('Pink')).toEqual({ [image]: turfRankScore(1, image) });
    expect(team('Green')).toEqual({});
    expect(hatted()).toEqual([image]);
  });

  it('drops a team that no longer counts on the image, and the image once it has none', async () => {
    const image = await imageWith(1, 1);
    await sync(image);
    await db.query(`UPDATE "EventTurfSticker" SET "removedAt" = now() WHERE "userId" = 4`);
    await sync(image);
    expect(team('Pink')).toEqual({});
    expect(total()).toEqual({ [image]: turfRankScore(1, image) });
    await db.query(`UPDATE "EventTurfSticker" SET "removedAt" = now() WHERE "userId" = 1`);
    await sync(image);
    expect(total()).toEqual({});
    expect(team('Blue')).toEqual({});
    expect(hatted()).toEqual([]);
  });

  it('marks an image with only uncounted hats hatted, but never ranks it', async () => {
    const image = await newImage();
    await sticker(image, 8);
    await sync(image);
    expect(hatted()).toEqual([image]);
    expect(total()).toEqual({});
    expect(team('Blue')).toEqual({});
  });

  it('leaves a contest entry out of every index, though its counts are kept', async () => {
    const image = await imageWith(2, 0);
    await db.query(`INSERT INTO "CollectionItem" ("collectionId", "imageId") VALUES (1, $1)`, [
      image,
    ]);
    await sync(image);
    expect(redis.hash(keys.counts)?.[`Image:${image}`]).toBeDefined();
    expect(total()).toEqual({});
    expect(team('Blue')).toEqual({});
    expect(hatted()).toEqual([]);
  });

  it('a reconcile builds the indexes from nothing, and clears an image whose hats expired', async () => {
    override = JSON.stringify({ ttlHours: 48, rolloutAt: '2026-01-01T00:00:00Z' });
    const live = await imageWith(1, 2);
    const gone = await newImage();
    await sticker(gone, 1, new Date(clock - 50 * HOUR));
    // As the indexes stood before `gone`'s hat expired.
    redis.setHash(keys.counts, {
      [`Image:${gone}`]: JSON.stringify({ shown: { Blue: 1 }, counted: { Blue: 1 } }),
    });
    redis.setSet(keys.hatted, [String(gone)]);
    const now = later();
    await reconcileTurf(await event(now), now);
    expect(total()).toEqual({ [live]: turfRankScore(3, live) });
    expect(team('Pink')).toEqual({ [live]: turfRankScore(2, live) });
    expect(hatted()).toEqual([live]);
  });

  it('a reconcile clears index entries left with no counts, as an older write script leaves them', async () => {
    const live = await imageWith(1, 0);
    const orphan = await newImage();
    redis.setSet(keys.hatted, [String(orphan)]);
    await redis.eval("redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])", {
      keys: [keys.rankTotal],
      arguments: [String(turfRankScore(4, orphan)), String(orphan)],
    });
    const now = later();
    await reconcileTurf(await event(now), now);
    expect(total()).toEqual({ [live]: turfRankScore(1, live) });
    expect(hatted()).toEqual([live]);
  });

  it('a stale write changes no index', async () => {
    const image = await imageWith(1, 0);
    await sync(image);
    // A later ticket already landed for the image.
    redis.setHash(keys.stamp, { [`Image:${image}`]: String(Number.MAX_SAFE_INTEGER) });
    await sticker(image, 2);
    await sync(image);
    expect(total()).toEqual({ [image]: turfRankScore(1, image) });
  });
});

describe('reading the ranks', () => {
  /** Images with hats [3, 1, 2, 1, 1] Blue, so 1 is tied three ways. */
  const seed = async () => {
    const ids = [await imageWith(3, 0), await imageWith(1, 0), await imageWith(2, 0)];
    ids.push(await imageWith(1, 0), await imageWith(1, 0));
    await sync(...ids);
    return ids;
  };
  const readAll = async (sort: 'most' | 'fewest', limit: number, teams?: string[]) => {
    const e = await event();
    const out: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await readTurfRankPage({ event: e, sort, teams, cursor, limit });
      out.push(...page.ids);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
  };

  it('most hats first, ties newest image first; fewest the reverse, paged without gaps or repeats', async () => {
    const [three, oneA, two, oneB, oneC] = await seed();
    expect(await readAll('most', 2)).toEqual([three, two, oneC, oneB, oneA]);
    expect(await readAll('fewest', 2)).toEqual([oneA, oneB, oneC, two, three]);
  });

  it('a page holds at most the limit and the last page carries no cursor', async () => {
    await seed();
    const page = await readTurfRankPage({ event: await event(), sort: 'most', limit: 5 });
    expect(page.ids).toHaveLength(5);
    expect(page.nextCursor).toBeUndefined();
  });

  it("one team ranks by that team's hats; several by their sum", async () => {
    const blueHeavy = await imageWith(3, 0);
    const mixed = await imageWith(1, 3);
    const pinkOnly = await imageWith(0, 1);
    await sync(blueHeavy, mixed, pinkOnly);
    expect(await readAll('most', 10, ['Blue'])).toEqual([blueHeavy, mixed]);
    expect(await readAll('most', 10, ['pink'])).toEqual([mixed, pinkOnly]);
    expect(await readAll('most', 10, ['Blue', 'Pink'])).toEqual([mixed, blueHeavy, pinkOnly]);
    expect(await readAll('fewest', 1, ['Blue', 'Pink'])).toEqual([pinkOnly, blueHeavy, mixed]);
  });

  it('a cursor of another shape starts from the top', async () => {
    const [three] = await seed();
    const page = await readTurfRankPage({
      event: await event(),
      sort: 'most',
      cursor: '1724677401898',
      limit: 1,
    });
    expect(page.ids).toEqual([three]);
  });
});

describe("reading the viewer's own hats", () => {
  const VIEWER = 1;
  beforeEach(() => {
    redisMock.sysRedis.zmScore.mockImplementation((async (key: string, members: string[]) =>
      members.map((m) => redis.zset(key)?.[m] ?? null)) as never);
  });
  const readMine = async (limit: number, sort?: 'most' | 'fewest', teams?: string[]) => {
    const now = later();
    const e = await event(now);
    const out: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await readMyTurfPage({
        event: e,
        userId: VIEWER,
        sort,
        teams,
        cursor,
        limit,
        now,
      });
      out.push(...page.ids);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
  };
  const readRanked = async (sort: 'most' | 'fewest', teams?: string[]) => {
    const e = await event();
    const out: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await readTurfRankPage({ event: e, sort, teams, cursor, limit: 2 });
      out.push(...page.ids);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
  };

  it('lists only their live hats, soonest to expire first, paged without gaps or repeats', async () => {
    override = JSON.stringify({ ttlHours: 48, rolloutAt: '2026-01-01T00:00:00Z' });
    const [old, mid, fresh, removed, expired, theirs] = [
      await newImage(),
      await newImage(),
      await newImage(),
      await newImage(),
      await newImage(),
      await newImage(),
    ];
    const oldAt = new Date(clock - 40 * HOUR);
    await sticker(fresh, VIEWER, new Date(clock - 1 * HOUR));
    await sticker(old, VIEWER, oldAt);
    await sticker(mid, VIEWER, new Date(clock - 10 * HOUR));
    await sticker(removed, VIEWER, new Date(clock - 5 * HOUR));
    await db.query(`UPDATE "EventTurfSticker" SET "removedAt" = now() WHERE "imageId" = $1`, [
      removed,
    ]);
    await sticker(expired, VIEWER, new Date(clock - 50 * HOUR));
    await sticker(theirs, 2, new Date(clock - 20 * HOUR));
    expect(await readMine(1)).toEqual([old, mid, fresh]);
    expect(await readMine(2)).toEqual([old, mid, fresh]);
    const now = later();
    const page = await readMyTurfPage({ event: await event(now), userId: VIEWER, limit: 3, now });
    expect(page.nextCursor).toBeUndefined();
    expect(page.placedAt.get(old)).toEqual(oldAt);
  });

  it('under a Hat Turf sort, ranks them as the feed ranks every image, leaving out one never ranked', async () => {
    const three = await imageWith(3, 0);
    const one = await imageWith(1, 0);
    const mixed = await imageWith(1, 1);
    const notMine = await imageWith(0, 3);
    // A contest entry: the viewer's hat on it is live, but drawn nowhere and ranked by no sort.
    const contest = await imageWith(1, 0);
    await db.query(`INSERT INTO "CollectionItem" ("collectionId", "imageId") VALUES (1, $1)`, [
      contest,
    ]);
    await sync(three, one, mixed, notMine, contest);
    expect(await readMine(2, 'most')).toEqual([three, mixed, one]);
    expect(await readMine(10)).not.toContain(contest);
    const mine = new Set([three, one, mixed]);
    for (const [sort, teams] of [
      ['most', undefined],
      ['fewest', undefined],
      ['most', ['Pink']],
      ['fewest', ['Blue', 'Pink']],
    ] as const) {
      const ranked = (await readRanked(sort, teams ? [...teams] : undefined)).filter((id) =>
        mine.has(id)
      );
      expect(await readMine(1, sort, teams ? [...teams] : undefined)).toEqual(ranked);
    }
  });

  it('leaves out a hat no feed draws: its owner turned Hat Turf off, or the image is hidden', async () => {
    const [kept, held] = [await newImage(), await newImage()];
    await sticker(kept, VIEWER);
    await sticker(held, VIEWER);
    await db.query(`UPDATE "Image" SET "needsReview" = 'poi' WHERE id = $1`, [held]);
    expect(await readMine(10)).toEqual([kept]);
    await db.query(`UPDATE "User" SET settings = $2 WHERE id = $1`, [
      OWNER,
      JSON.stringify({ eventTurfOwnerOff: { e: 'true' } }),
    ]);
    try {
      expect(await readMine(10)).toEqual([]);
      const now = later();
      expect((await getTurfStock('e', VIEWER, now)).liveHats).toBe(0);
    } finally {
      await db.query(`UPDATE "User" SET settings = '{}' WHERE id = $1`, [OWNER]);
    }
    expect((await getTurfStock('e', VIEWER, later())).liveHats).toBe(1);
  });

  // Own hats share drawnStickers with getTurfStickersForImages: a hat the feed draws nowhere is not live.
  it("a banned viewer's hats are drawn nowhere, so none is live", async () => {
    const image = await newImage();
    await sticker(image, VIEWER);
    expect(await readMine(10)).toEqual([image]);
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [VIEWER]);
    try {
      expect(await readMine(10)).toEqual([]);
      expect((await getTurfStock('e', VIEWER, later())).liveHats).toBe(0);
    } finally {
      await db.query(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [VIEWER]);
    }
  });

  it('a viewer with no live hats gets an empty page and no cursor', async () => {
    await sticker(await newImage(), 2);
    const page = await readMyTurfPage({ event: await event(), userId: VIEWER, limit: 5 });
    expect(page).toMatchObject({ ids: [], nextCursor: undefined });
  });
});

describe('the Show filters', () => {
  it('Turf hides images with any live Turf hat, Worn those wearing an event hat', async () => {
    const turfed = await imageWith(1, 0);
    const worn = await newImage();
    const bare = await newImage();
    await sync(turfed);
    redis.setHash(eventPointKeys('e').hats, { [`Image:${worn}`]: '{"team":"Blue"}' });
    const e = await event();
    const ids = [turfed, worn, bare];
    expect([...(await turfHiddenIds(e, ids, { turf: true }))]).toEqual([turfed]);
    expect([...(await turfHiddenIds(e, ids, { worn: true }))]).toEqual([worn]);
    expect([...(await turfHiddenIds(e, ids, { turf: true, worn: true }))].sort()).toEqual([
      turfed,
      worn,
    ]);
    expect([...(await turfHiddenIds(e, ids, {}))]).toEqual([]);
  });

  // Deliberate: the Show filters are a player's preference, not a safety gate, and the filter store
  // sends them on every images feed. A Redis failure must show the images, not fail the page.
  it('a failed read hides nothing instead of failing the feed', async () => {
    const turfed = await imageWith(1, 0);
    await sync(turfed);
    const e = await event();
    redisMock.sysRedis.smIsMember.mockRejectedValueOnce(new Error('redis down'));
    expect([...(await turfHiddenIds(e, [turfed], { turf: true, worn: true }))]).toEqual([]);
  });
});

describe('filling a filtered page', () => {
  const pages: Record<string, { items: { id: number }[]; nextCursor?: string }> = {
    a: { items: [{ id: 1 }, { id: 2 }], nextCursor: 'b' },
    b: { items: [{ id: 3 }, { id: 4 }], nextCursor: 'c' },
    c: { items: [{ id: 5 }, { id: 6 }], nextCursor: 'd' },
    d: { items: [{ id: 7 }, { id: 8 }], nextCursor: undefined },
  };
  const read = vi.fn(async (cursor?: string) => pages[cursor ?? 'a']);
  beforeEach(() => read.mockClear());

  it('reads on until the page fills, and returns the last read’s cursor', async () => {
    const odd = async (items: { id: number }[]) => items.filter((i) => i.id % 2);
    const page = await fillTurfPage('show', 2, undefined, read, odd);
    expect(page.items.map((i) => i.id)).toEqual([1, 3]);
    expect(page.nextCursor).toBe('c');
  });

  it('stops after three reads, short, with the cursor to go on from', async () => {
    const none = async (): Promise<{ id: number }[]> => [];
    const page = await fillTurfPage('show', 2, undefined, read, none);
    expect(read).toHaveBeenCalledTimes(3);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe('d');
  });

  it('stops at the end of the feed', async () => {
    const page = await fillTurfPage('show', 10, 'c', read, async (items) => items);
    expect(page.items.map((i) => i.id)).toEqual([5, 6, 7, 8]);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('who gets the Hat Turf feed', () => {
  const setUser = (id: number, settings: object) =>
    db.query(`UPDATE "User" SET settings = $2 WHERE id = $1`, [id, JSON.stringify(settings)]);
  const joined = { eventTurfOptIn: { e: 'true' } };

  it('a player with event cosmetics on gets the event', async () => {
    await setUser(1, joined);
    expect((await getHatTurfFeedEvent(1, later()))?.name).toBe('e');
    await setUser(1, { ...joined, showEventCosmetics: true });
    expect((await getHatTurfFeedEvent(1, later()))?.name).toBe('e');
  });

  it('nobody else does: cosmetics off, never joined, left, owner switch off, or signed out', async () => {
    await setUser(1, { ...joined, showEventCosmetics: false });
    expect(await getHatTurfFeedEvent(1, later())).toBeNull();
    await setUser(1, {});
    expect(await getHatTurfFeedEvent(1, later())).toBeNull();
    await setUser(1, { eventTurfOptIn: { e: 'false' } });
    expect(await getHatTurfFeedEvent(1, later())).toBeNull();
    await setUser(1, { ...joined, eventTurfOwnerOff: { e: 'true' } });
    expect(await getHatTurfFeedEvent(1, later())).toBeNull();
    expect(await getHatTurfFeedEvent(undefined, later())).toBeNull();
    await setUser(1, joined);
  });

  it('a failed lookup is no player, not an error, and is not remembered', async () => {
    await setUser(1, joined);
    dbMock.dbRead.$queryRaw.mockRejectedValueOnce(new Error('replica down') as never);
    expect(await getHatTurfFeedEvent(1, later())).toBeNull();
    expect((await getHatTurfFeedEvent(1, later()))?.name).toBe('e');
  });

  it('a player is remembered for a minute', async () => {
    await setUser(1, joined);
    const now = later();
    expect((await getHatTurfFeedEvent(1, now))?.name).toBe('e');
    await setUser(1, {});
    expect((await getHatTurfFeedEvent(1, new Date(now.getTime() + 59_000)))?.name).toBe('e');
    expect(await getHatTurfFeedEvent(1, new Date(now.getTime() + 60_000))).toBeNull();
  });

  it('nobody, when turf is off', async () => {
    await setUser(1, joined);
    override = JSON.stringify({ mode: 'off' });
    expect(await getHatTurfFeedEvent(1, later())).toBeNull();
  });
});
