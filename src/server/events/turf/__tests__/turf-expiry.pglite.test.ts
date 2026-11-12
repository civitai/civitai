import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as TurfWatch from '~/server/events/turf/turf-watch';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { eventSeasonKeys } from '~/server/events/points/keys';
import { turfConfigKey } from '~/server/events/turf/config';
import { decodeTurfEntry, turfKeys, type TurfCounts } from '~/server/events/turf/turf-map';

/**
 * Sticker lifetime and team-relative credit through the service, against real sticker rows: what
 * the map credits and counts, what is drawn, and what placing again does. Ids and numbers are
 * invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const START = new Date('2026-11-01T00:00:00Z');
const HOUR = 3600_000;
const TEAMS = ['Blue', 'Pink', 'Green', 'Gold'];
const COSMETIC: Record<string, number> = { Blue: 11, Pink: 12, Green: 13, Gold: 14 };
// Blue 1-3, Pink 4-6.
const teamOf = (userId: number) => (userId <= 3 ? 'Blue' : 'Pink');
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
    mapMaxEntries: 10,
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
vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace: async () => undefined,
}));

const {
  getTurfEvent,
  getTurfStickers,
  getTurfStickersForImages,
  getTurfStock,
  getTurfSummaries,
  placeTurfSticker,
  reconcileTurf,
  syncTurfImages,
  turfCreditedByTeam,
} = await import('~/server/events/turf/turf.service');

const OWNER = 7;
const keys = turfKeys('e');
const teamBase = eventSeasonKeys('e', 'live').base('team');
// Blue 25% under the mean of 1000, Pink 25% over, the others at it.
const POINTS = { Blue: '750', Pink: '1250', Green: '1000', Gold: '1000' };

let db: PGlite;
let redis: LuaRedis;
let override: string | null = null;
// The config and team totals are cached per server for up to a minute: each step reads later.
let clock = new Date('2026-11-10T00:00:00Z').getTime();
const later = () => new Date((clock += 10 * 60_000));
const hoursBefore = (now: Date, hours: number) => new Date(now.getTime() - hours * HOUR);
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
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int);
    CREATE TABLE "EventTurfStock" (
      event text, "userId" int, stock double precision, "refilledAt" timestamptz,
      PRIMARY KEY (event, "userId")
    );
    CREATE TABLE "EventTurfSticker" (
      id bigserial PRIMARY KEY, event text, "imageId" int, "userId" int, team text,
      "cosmeticId" int, data jsonb, "createdAt" timestamptz DEFAULT now(), "removedAt" timestamptz,
      UNIQUE (event, "imageId", "userId")
    );
    INSERT INTO "User" (id, settings) VALUES (${OWNER}, '{}'),
      ${[1, 2, 3, 4, 5, 6].map((id) => `(${id}, '{"eventTurfOptIn": {"e": "true"}}')`).join(',')};
    INSERT INTO "Post" VALUES (1, '2026-10-01', 'Public');
    INSERT INTO "Cosmetic" VALUES
      (11, 'ContentDecoration', '{"event": "e", "team": "Blue"}'),
      (12, 'ContentDecoration', '{"event": "e", "team": "Pink"}');
    INSERT INTO "UserCosmetic" VALUES (1, 11), (2, 11), (3, 11), (4, 12), (5, 12), (6, 12);
  `);
});
afterAll(async () => db.close());

beforeEach(async () => {
  await db.exec(`DELETE FROM "EventTurfSticker"; DELETE FROM "EventTurfStock"`);
  override = null;
  redis = createLuaRedis(0);
  const raw = pgliteRaw(db);
  kysely.read.mockReset().mockImplementation(raw.queryRaw);
  kysely.write.mockReset().mockImplementation(raw.queryRaw);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  // Prisma's create, with the unique key refusing as Prisma reports it.
  dbMock.dbWrite.eventTurfSticker.create.mockImplementation((async ({
    data,
  }: {
    data: Record<string, unknown>;
  }) => {
    try {
      await db.query(
        `INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data, "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          data.event,
          data.imageId,
          data.userId,
          data.team,
          data.cosmeticId,
          JSON.stringify(data.data),
          data.createdAt,
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      throw error;
    }
    return {};
  }) as never);
  dbMock.dbRead.eventTurfStock.findUnique.mockResolvedValue(null as never);
  redisMock.sysRedis.get.mockImplementation((async (key: string) =>
    key === turfConfigKey('e') ? override : null) as never);
  redisMock.sysRedis.hmGet.mockImplementation((async (key: string, fields: string[]) =>
    key === teamBase
      ? fields.map((field) => POINTS[field as keyof typeof POINTS] ?? null)
      : fields.map(() => null)) as never);
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
const sticker = (imageId: number, userId: number, createdAt: Date, removedAt?: Date) =>
  db.query(
    `INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data, "createdAt", "removedAt")
     VALUES ('e', $1, $2, $3, $4, '{"x": 0.1, "y": 0.1, "scale": 0.2, "rotation": 0}', $5, $6)`,
    [imageId, userId, teamOf(userId), COSMETIC[teamOf(userId)], createdAt, removedAt ?? null]
  );
const sync = async (imageId: number, now: Date) => {
  await syncTurfImages((await getTurfEvent('e', now))!, [imageId], now);
  const field = `Image:${imageId}`;
  const entry = redis.hash(keys.map)?.[field];
  const counts = redis.hash(keys.counts)?.[field];
  return {
    entry: entry ? decodeTurfEntry(entry) : undefined,
    counts: counts ? (JSON.parse(counts) as TurfCounts) : undefined,
  };
};
const place = (userId: number, imageId: number, now: Date) =>
  placeTurfSticker(
    {
      event: 'e',
      userId,
      imageId,
      cosmeticId: COSMETIC[teamOf(userId)],
      data: { x: 0.5, y: 0.5, scale: 0.2, rotation: 0, flip: false },
    },
    now
  );
const rowsOf = async (imageId: number) =>
  (
    await db.query<{ id: string; userId: number; createdAt: Date; data: { x: number } }>(
      `SELECT id::text, "userId", "createdAt", data FROM "EventTurfSticker" WHERE "imageId" = $1`,
      [imageId]
    )
  ).rows;
const stockOf = async (userId: number) =>
  (
    await db.query<{ stock: number }>(`SELECT stock FROM "EventTurfStock" WHERE "userId" = $1`, [
      userId,
    ])
  ).rows[0]?.stock;
// A rollout long past, so each sticker's own placement time decides (the override needs one).
const ttl = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ttlHours: 48, rolloutAt: '2026-01-01T00:00:00Z', ...extra });

describe('Hat Turf sticker lifetime', () => {
  // Pink's sticker went on first, so with both counting Pink leads a 1-1 image.
  const pinkFirstBlueSecond = async (now: Date) => {
    const image = await newImage();
    await sticker(image, 4, hoursBefore(now, 50));
    await sticker(image, 1, hoursBefore(now, 1));
    return image;
  };

  it('a sticker past its lifetime neither counts, leads, nor is credited; one inside it does', async () => {
    override = ttl();
    const now = later();
    const image = await pinkFirstBlueSecond(now);
    const { entry, counts } = await sync(image, now);
    expect(counts).toMatchObject({ shown: { Blue: 1 }, counted: { Blue: 1 }, leader: 'Blue' });
    expect(entry).toMatchObject({ team: 'Blue', players: [1] });
  });

  it('with no lifetime configured, no sticker expires', async () => {
    const now = later();
    const image = await pinkFirstBlueSecond(now);
    const { entry, counts } = await sync(image, now);
    expect(counts).toMatchObject({ counted: { Blue: 1, Pink: 1 }, leader: 'Pink' });
    expect(entry).toMatchObject({ team: 'Pink', players: [4] });
  });

  it('a sticker from before rolloutAt counts for a full lifetime from rolloutAt', async () => {
    const rolloutAt = new Date(clock);
    override = ttl({ rolloutAt: rolloutAt.toISOString() });
    const image = await newImage();
    // Placed 100h before rollout: long past 48h of its own, inside 48h of rollout.
    await sticker(image, 4, hoursBefore(rolloutAt, 100));
    clock = rolloutAt.getTime() + 47 * HOUR;
    expect((await sync(image, later())).entry).toMatchObject({ team: 'Pink', players: [4] });
    clock = rolloutAt.getTime() + 49 * HOUR;
    expect((await sync(image, later())).entry).toBeUndefined();
  });

  it('the reconcile clears an image left with only expired stickers, and keeps a live one', async () => {
    override = ttl();
    const now = later();
    const gone = await newImage();
    const live = await newImage();
    await sticker(gone, 4, hoursBefore(now, 50));
    await sticker(live, 1, hoursBefore(now, 1));
    // As the map stood before the sticker expired.
    redis.setHash(keys.map, {
      [`Image:${gone}`]: JSON.stringify({ team: 'Pink', cosmeticId: 12, players: [4], lastAt: 1 }),
    });
    redis.setHash(keys.counts, {
      [`Image:${gone}`]: JSON.stringify({ shown: { Pink: 1 }, counted: { Pink: 1 } }),
    });
    await reconcileTurf((await getTurfEvent('e', now))!, now);
    expect(Object.keys(redis.hash(keys.map) ?? {})).toEqual([`Image:${live}`]);
    expect(Object.keys(redis.hash(keys.counts) ?? {})).toEqual([`Image:${live}`]);
  });

  // Deliberate: a reconcile batch reads expiry at the time of its own ticket, not when the run
  // began. A sync that dropped a sticker as it expired writes under an earlier ticket, so a batch
  // reading with the run's start time would win and put the sticker back.
  it('a reconcile batch reads expiry at its own ticket time, not the time the run began', async () => {
    override = ttl();
    const now = later();
    const image = await newImage();
    // Expires 90s into the run.
    await sticker(image, 4, new Date(now.getTime() - 48 * HOUR + 90_000));
    let fakeNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    // A minute reading the counts snapshot before the first batch, a minute more to its ticket.
    redisMock.sysRedis.hGetAll.mockImplementation((async (key: string) => {
      fakeNow += 60_000;
      return redis.hash(key) ?? {};
    }) as never);
    redisMock.sysRedis.incr.mockImplementation((async () => {
      fakeNow += 60_000;
      return (clock += 1);
    }) as never);
    try {
      await reconcileTurf((await getTurfEvent('e', now))!, now);
    } finally {
      spy.mockRestore();
    }
    expect(redis.hash(keys.map)?.[`Image:${image}`]).toBeUndefined();
  });

  it('a sticker stops counting exactly at its lifetime, and counts until then', async () => {
    override = ttl();
    const now = later();
    const [ends, lasts] = [await newImage(), await newImage()];
    await sticker(ends, 4, hoursBefore(now, 48));
    await sticker(lasts, 4, new Date(now.getTime() - 48 * HOUR + 1));
    expect((await sync(ends, now)).entry).toBeUndefined();
    expect((await sync(lasts, now)).entry).toMatchObject({ players: [4] });
  });

  it('an expired sticker is not drawn, on image detail or feed cards', async () => {
    override = ttl();
    const now = later();
    const image = await pinkFirstBlueSecond(now);
    const detail = await getTurfStickers('e', image, 4, undefined, now);
    expect(detail.stickers.map((s) => s.userId)).toEqual([1]);
    expect(detail.mine).toBeNull();
    const feed = await getTurfStickersForImages('e', [image], 5, now);
    expect(feed[image]?.map((s) => s.userId)).toEqual([1]);
  });

  it("summaries say a viewer's live or removed sticker blocks placing, and an expired one does not", async () => {
    override = ttl();
    const now = later();
    const [expired, live, removed] = [await newImage(), await newImage(), await newImage()];
    await sticker(expired, 4, hoursBefore(now, 50));
    await sticker(live, 4, hoursBefore(now, 1));
    await sticker(removed, 4, hoursBefore(now, 50), hoursBefore(now, 49));
    const { mine } = await getTurfSummaries('e', [expired, live, removed], 4, now);
    expect(mine).toEqual({ [expired]: false, [live]: true, [removed]: true });
  });

  it('placing again on an image where your sticker expired renews it in place and spends one', async () => {
    override = ttl();
    const now = later();
    const image = await newImage();
    await sticker(image, 4, hoursBefore(now, 50));
    const [before] = await rowsOf(image);
    await place(4, image, now);
    const after = await rowsOf(image);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, createdAt: now, data: { x: 0.5 } });
    // A first placement opens the bucket full at 50.
    expect(await stockOf(4)).toBe(49);
    expect((await sync(image, now)).entry).toMatchObject({ team: 'Pink', players: [4] });
  });

  it.each([
    ['live', undefined],
    ['removed by a moderator', 49],
  ])('placing again over a %s sticker is still refused, and spends nothing', async (_, removed) => {
    override = ttl();
    const now = later();
    const image = await newImage();
    const placedAt = removed ? hoursBefore(now, 50) : hoursBefore(now, 1);
    await sticker(image, 4, placedAt, removed ? hoursBefore(now, removed) : undefined);
    await expect(place(4, image, now)).rejects.toThrow(
      "You've already put a hat sticker on this image"
    );
    expect((await rowsOf(image))[0].createdAt).toEqual(placedAt);
    // The bucket opened full at 50 (the mocked transaction does not roll back), and none was spent.
    expect(await stockOf(4)).toBe(50);
  });
});

describe('Hat Turf team-relative credit', () => {
  const CREDIT = (players: number) =>
    JSON.stringify({
      creditedPlayers: [{ from: START.toISOString(), players }],
      creditedCatchUp: [{ from: START.toISOString(), max: 2, min: 0.4, gap: 0.25 }],
    });

  it('a team ahead credits fewer, one behind more, one level the base', async () => {
    override = CREDIT(5);
    const now = later();
    expect(await turfCreditedByTeam((await getTurfEvent('e', now))!, now)).toEqual({
      Blue: 10,
      Pink: 2,
      Green: 5,
      Gold: 5,
    });
  });

  it('with no creditedCatchUp, every team credits the base', async () => {
    override = JSON.stringify({ creditedPlayers: [{ from: START.toISOString(), players: 5 }] });
    const now = later();
    expect(await turfCreditedByTeam((await getTurfEvent('e', now))!, now)).toEqual({
      Blue: 5,
      Pink: 5,
      Green: 5,
      Gold: 5,
    });
  });

  it('never credits fewer than one', async () => {
    override = CREDIT(1);
    const now = later();
    // Pink: 1 x 0.4 rounds to 0.
    expect((await turfCreditedByTeam((await getTurfEvent('e', now))!, now)).Pink).toBe(1);
  });

  it("the map credits each leading team's own number", async () => {
    override = CREDIT(5);
    const now = later();
    const pink = await newImage();
    const blue = await newImage();
    for (const u of [4, 5, 6]) await sticker(pink, u, hoursBefore(now, 7 - u));
    for (const u of [1, 2, 3]) await sticker(blue, u, hoursBefore(now, 4 - u));
    expect((await sync(pink, now)).entry?.players).toEqual([4, 5]);
    expect((await sync(blue, now)).entry?.players).toEqual([1, 2, 3]);
  });

  it("the stock names every team's number, and the viewer's own as creditedPlayers", async () => {
    override = CREDIT(5);
    const stock = await getTurfStock('e', 4, later());
    expect(stock.creditedByTeam).toEqual({ Blue: 10, Pink: 2, Green: 5, Gold: 5 });
    expect(stock.creditedPlayers).toBe(2);
  });
});
