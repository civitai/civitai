import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TurfWatch from '~/server/events/turf/turf-watch';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * An owner's "keep Hat Turf off my images", against real rows: their images take no new stickers,
 * and those already placed are neither drawn nor counted, until they turn it back on. Ids are
 * invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const START = new Date('2026-11-01T00:00:00Z');
const EVENT = {
  name: 'e',
  startDate: START,
  endDate: new Date('2099-12-01T00:00:00Z'),
  teams: ['Blue', 'Pink'],
  scoring: { finalizeAfterMs: 0 },
  turf: {
    mode: 'live',
    testerFlag: 'e-turf',
    supply: [{ from: START, perHour: 5, cap: 50 }],
    creditedPlayers: [{ from: START, players: 25 }],
    renderLimit: 12,
    mapMaxEntries: 10,
  },
  getUserTeam: async () => 'Blue',
  getTeamCosmetic: async () => 11,
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
// Blocks and suspensions have their own tests; nobody here is blocked.
vi.mock('~/server/services/placement-moderation.service', () => ({
  assertCanPlace: () => Promise.resolve(),
}));
const pushTurfCounts = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/events/turf/turf-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfWatch>()),
  pushTurfCounts,
}));

const {
  getTurfEvent,
  getTurfStickers,
  getTurfStickersForImages,
  getTurfStock,
  getTurfSummaries,
  placeTurfSticker,
  reconcileTurf,
  setTurfOptIn,
  setTurfOwnerOff,
  syncTurfImages,
} = await import('~/server/events/turf/turf.service');
const { turfKeys } = await import('~/server/events/turf/turf-map');

const PLACER = 5;
// Both owners are in Hat Turf, so only the owner switch can tell their images apart (an owner who
// is in cannot turn the switch off through the API; the row is written directly).
const ALLOWS = 7;
const OFF = 8;
// A user not in Hat Turf, free to use the switch.
const OUTSIDER = 9;
// Never chose: in Hat Turf once they place an event hat (the old default).
const NEVER_CHOSE = 10;
// Each owner's one image, id = owner + 900.
const IMAGES = [ALLOWS + 900, OFF + 900, OUTSIDER + 900];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, settings jsonb, "bannedAt" timestamptz, "deletedAt" timestamptz,
      "createdAt" timestamptz DEFAULT '2020-01-01', meta jsonb,
      "excludeFromLeaderboards" boolean DEFAULT false
    );
    CREATE TABLE "CreatorMilestone" (key text PRIMARY KEY, threshold numeric);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamptz, availability text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, "postId" int, ingestion text DEFAULT 'Scanned',
      "tosViolation" boolean DEFAULT false, "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "Collection" (id int PRIMARY KEY, mode text);
    CREATE TABLE "CollectionItem" (id serial PRIMARY KEY, "collectionId" int, "imageId" int);
    CREATE TABLE "EventCosmeticPlacement" (
      id serial PRIMARY KEY, event text NOT NULL, "userId" int NOT NULL, "endedAt" timestamp
    );
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int);
    CREATE TABLE "EventTurfSticker" (
      id bigserial PRIMARY KEY, event text, "imageId" int, "userId" int, team text,
      "cosmeticId" int, data jsonb, "createdAt" timestamptz DEFAULT now(), "removedAt" timestamptz
    );
    INSERT INTO "Post" VALUES (1, '2026-10-01', 'Public');
    INSERT INTO "Cosmetic" VALUES (11, 'ContentDecoration', '{"event":"e","team":"Blue"}');
  `);
});
afterAll(async () => db.close());

let lua: ReturnType<typeof createLuaRedis>;
beforeEach(async () => {
  await db.exec(`
    TRUNCATE "User", "Image", "EventCosmeticPlacement", "EventTurfSticker", "UserCosmetic";
    INSERT INTO "User" (id, settings) VALUES
      (${PLACER}, '{"eventTurfOptIn": {"e": true}}'),
      (${ALLOWS}, '{"eventTurfOptIn": {"e": true}}'),
      (${OFF}, '{"eventTurfOptIn": {"e": true}, "eventTurfOwnerOff": {"e": true}}'),
      (${OUTSIDER}, '{"eventTurfOptIn": {"e": false}}'),
      (${NEVER_CHOSE}, NULL);
    INSERT INTO "UserCosmetic" VALUES (${PLACER}, 11);
    INSERT INTO "Image" (id, "userId", "postId") VALUES
      (${IMAGES[0]}, ${ALLOWS}, 1), (${IMAGES[1]}, ${OFF}, 1), (${IMAGES[2]}, ${OUTSIDER}, 1);
    INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data)
      SELECT 'e', id, ${PLACER}, 'Blue', 11, '{}' FROM "Image";
  `);
  const raw = pgliteRaw(db);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  // Past every check, placing opens its transaction: stop there.
  dbMock.dbWrite.$transaction.mockRejectedValue(new Error('passed the checks') as never);
  dbMock.dbRead.eventTurfStock.findUnique.mockResolvedValue(null as never);
  lua = createLuaRedis(0);
  redisMock.sysRedis.eval.mockImplementation(lua.eval as never);
  redisMock.sysRedis.hmGet.mockImplementation((async (_k: string, keys: string[]) =>
    keys.map(() => null)) as never);
  let ticket = 0;
  redisMock.sysRedis.incr.mockImplementation((async () => ++ticket) as never);
  redisMock.sysRedis.hGetAll.mockImplementation(
    (async (key: string) => lua.hash(key) ?? {}) as never
  );
  pushTurfCounts.mockClear();
});

const drawnOn = async (imageId: number) => (await getTurfStickers('e', imageId)).stickers.length;
const countedImages = async () => {
  await syncTurfImages((await getTurfEvent('e'))!, IMAGES.slice(0, 2));
  return Object.keys(lua.hash(turfKeys('e').counts) ?? {}).sort();
};
const place = (imageId: number) =>
  placeTurfSticker({
    event: 'e',
    userId: PLACER,
    imageId,
    cosmeticId: 11,
    data: { x: 0.5, y: 0.5, scale: 0.22, rotation: 0, flip: false },
  });

describe("an owner's switch: keep Hat Turf off my images", () => {
  // Deliberate (event owner's call, 2026-11-04): turned off, an owner's images show and count no
  // turf, and nothing is deleted, so turning it back on restores what was there.
  it('image detail draws nothing on an image whose owner turned it off', async () => {
    expect(await drawnOn(IMAGES[0])).toBe(1);
    expect(await drawnOn(IMAGES[1])).toBe(0);
  });

  it('feed cards get nothing for it', async () => {
    const feed = await getTurfStickersForImages('e', IMAGES.slice(0, 2), 5);
    expect(Object.keys(feed)).toEqual([String(IMAGES[0])]);
  });

  it('its stickers count toward nothing', async () => {
    expect(await countedImages()).toEqual([`Image:${IMAGES[0]}`]);
  });

  it('the reconcile clears counts written before the owner turned it off', async () => {
    const was = JSON.stringify({ shown: { Blue: 1 }, counted: { Blue: 1 }, leader: 'Blue' });
    lua.setHash(
      turfKeys('e').counts,
      Object.fromEntries(IMAGES.slice(0, 2).map((id) => [`Image:${id}`, was]))
    );
    await reconcileTurf((await getTurfEvent('e'))!);
    // The outsider's image never had the switch off, so the reconcile counts it too.
    expect(Object.keys(lua.hash(turfKeys('e').counts) ?? {}).sort()).toEqual([
      `Image:${IMAGES[0]}`,
      `Image:${IMAGES[2]}`,
    ]);
  });

  it('it is closed to new stickers, and placing on it is refused', async () => {
    const { open } = await getTurfSummaries('e', IMAGES.slice(0, 2));
    expect(open).toEqual({ [IMAGES[0]]: true, [IMAGES[1]]: false });
    await expect(place(IMAGES[0])).rejects.toThrow('passed the checks');
    await expect(place(IMAGES[1])).rejects.toThrow('keeps Hat Turf off their images');
  });

  it('turning it back on restores what was there; turning it off again hides it', async () => {
    await setTurfOwnerOff('e', OFF, false);
    expect(await drawnOn(IMAGES[1])).toBe(1);
    expect(await countedImages()).toEqual([`Image:${IMAGES[0]}`, `Image:${IMAGES[1]}`]);
  });
});

describe("a banned or deleted owner's images", () => {
  // Stickers on an image whose owner is later banned or deleted stop counting and drawing.
  it.each([
    ['banned', '"bannedAt"'],
    ['deleted', '"deletedAt"'],
  ])('%s: draw and count nothing, and take no new stickers', async (_, column) => {
    await db.exec(`UPDATE "User" SET ${column} = now() WHERE id = ${ALLOWS}`);
    expect(await drawnOn(IMAGES[0])).toBe(0);
    expect(await countedImages()).toEqual([]);
    // Not blamed on the owner's switch, which they never touched.
    await expect(place(IMAGES[0])).rejects.toThrow("You can't put hat stickers on this image");
  });
});

describe('when the switch takes effect', () => {
  const counted = () => Object.keys(lua.hash(turfKeys('e').counts) ?? {}).sort();
  // Counts and the scoring map are rewritten by the switch itself, not by the next reconcile.
  it("turning it off drops the owner's images from the counts at once, and on brings them back", async () => {
    await syncTurfImages((await getTurfEvent('e'))!, IMAGES);
    expect(counted()).toContain(`Image:${IMAGES[2]}`);
    await setTurfOwnerOff('e', OUTSIDER, true);
    expect(counted()).not.toContain(`Image:${IMAGES[2]}`);
    await setTurfOwnerOff('e', OUTSIDER, false);
    expect(counted()).toContain(`Image:${IMAGES[2]}`);
  });
});

describe('who may use the switch', () => {
  it('someone not in Hat Turf may turn it off, and stock reports it', async () => {
    expect((await setTurfOwnerOff('e', OUTSIDER, true)).changed).toBe(true);
    expect((await getTurfStock('e', OUTSIDER)).ownerOff).toBe(true);
    expect(await drawnOn(IMAGES[2])).toBe(0);
  });

  it('someone in Hat Turf may not turn it off', async () => {
    await expect(setTurfOwnerOff('e', ALLOWS, true)).rejects.toThrow('Leave Hat Turf first');
    expect((await getTurfStock('e', ALLOWS)).ownerOff).toBe(false);
  });

  // The switch and joining each refuse the other, so both set at once only comes from a race or a
  // hand edit. The switch wins: a player cannot wall their own images off.
  it('a user whose settings say both joined and off is not in Hat Turf', async () => {
    await db.exec(
      `UPDATE "User" SET settings = '{"eventTurfOptIn":{"e":true},"eventTurfOwnerOff":{"e":true}}'
       WHERE id = ${NEVER_CHOSE}`
    );
    expect((await getTurfStock('e', NEVER_CHOSE)).optedIn).toBe(false);
    await expect(
      placeTurfSticker({
        event: 'e',
        userId: NEVER_CHOSE,
        imageId: IMAGES[0],
        cosmeticId: 11,
        data: { x: 0.5, y: 0.5, scale: 0.22, rotation: 0, flip: false },
      })
    ).rejects.toThrow('Join Hat Turf to place hat stickers');
  });

  it('with it off, joining is refused until it is back on', async () => {
    await setTurfOwnerOff('e', OUTSIDER, true);
    await expect(setTurfOptIn('e', OUTSIDER, true)).rejects.toThrow('to join');
    await setTurfOwnerOff('e', OUTSIDER, false);
    expect((await setTurfOptIn('e', OUTSIDER, true)).changed).toBe(true);
  });
});
