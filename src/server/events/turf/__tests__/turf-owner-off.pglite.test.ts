import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TurfWatch from '~/server/events/turf/turf-watch';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type { Prisma } from '@prisma/client';
import { UserFlag } from '~/shared/constants/user-flags.constants';

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
// getTurfStock and getTurfSummaries read through Kysely, not Prisma's `$queryRaw`: both Kysely
// clients' statements go to the same PGlite (see beforeEach).
const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('~/server/db/kyselyDb.lazy', async () =>
  (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
);
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
// Never chose: not in Hat Turf (only an explicit opt-in counts).
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
      "excludeFromLeaderboards" boolean DEFAULT false, flags int NOT NULL DEFAULT 0
    );
    CREATE TABLE "CreatorMilestone" (key text PRIMARY KEY, threshold numeric);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamptz, availability text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, "postId" int, ingestion text DEFAULT 'Scanned',
      "tosViolation" boolean DEFAULT false, "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "Collection" (id int PRIMARY KEY, mode text);
    CREATE TABLE "CollectionItem" (id serial PRIMARY KEY, "collectionId" int, "imageId" int);
    -- contestEntry also reads running flag Crucibles and today's flags.
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "Crucible" (id int PRIMARY KEY, status "CrucibleStatus", "eventTags" text[]);
    CREATE TABLE "CrucibleEntry" (id serial PRIMARY KEY, "crucibleId" int, "imageId" int);
    CREATE TABLE "FlagDay" (id serial PRIMARY KEY, event text, "startsAt" timestamp(3), "imageIds" int[]);
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
  kysely.read.mockReset().mockImplementation(raw.queryRaw);
  kysely.write.mockReset().mockImplementation(raw.queryRaw);
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
  // Turned off, an owner's images show and count no turf, and nothing is deleted, so turning it back
  // on restores what was there.
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

  it('turning it back on restores what was there', async () => {
    await setTurfOwnerOff('e', OFF, false);
    expect(await drawnOn(IMAGES[1])).toBe(1);
    expect(await countedImages()).toEqual([`Image:${IMAGES[0]}`, `Image:${IMAGES[1]}`]);
  });
});

// Prisma's raw reads answered an id past int4 with no rows; through the pg pools the `int[]` bind is
// a range error that fails the whole batch. Such an id is dropped before the statement runs.
describe('an image id past int4 in the batch', () => {
  const PAST_INT4 = 2 ** 31;
  beforeEach(async () => {
    const { rejectPastInt4 } = await import('~/test-utils/kysely-raw-fake');
    const raw = pgliteRaw(db);
    kysely.read.mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
      rejectPastInt4(values);
      return raw.queryRaw(strings as TemplateStringsArray, ...values);
    });
  });

  it('answers the other ids, and leaves it out', async () => {
    const { open, mine } = await getTurfSummaries('e', [IMAGES[0], PAST_INT4, IMAGES[1]], PLACER);
    expect(open).toEqual({ [IMAGES[0]]: true, [IMAGES[1]]: false });
    expect(mine).toEqual({ [IMAGES[0]]: true, [IMAGES[1]]: true });
  });

  it('with no other id, answers empty without a statement', async () => {
    kysely.read.mockClear();
    await expect(getTurfSummaries('e', [PAST_INT4], PLACER)).resolves.toEqual({
      team: null,
      images: {},
      open: {},
      mine: {},
      hidden: {},
    });
    expect(kysely.read).not.toHaveBeenCalled();
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

describe("a placer's event-points exclusion", () => {
  // Decision: leaderboard exclusion and event-points exclusion are separate switches. Before you
  // put "excludeFromLeaderboards" back into the turf eligibility, note that it would stop every
  // leaderboard-only placer's stickers from counting.
  const countedOn = async (imageId: number) => {
    await syncTurfImages((await getTurfEvent('e'))!, [imageId]);
    const entry = lua.hash(turfKeys('e').counts)?.[`Image:${imageId}`];
    return entry ? JSON.parse(entry).counted : undefined;
  };

  it('a placer with the bit still shows, but counts for nothing', async () => {
    await db.exec(
      `UPDATE "User" SET flags = ${UserFlag.ExcludeFromEventPoints} WHERE id = ${PLACER}`
    );
    expect(await drawnOn(IMAGES[0])).toBe(1);
    expect(await countedOn(IMAGES[0])).toEqual({});
  });

  it('a placer excluded only from leaderboards counts', async () => {
    // DisablePayout rides along so a predicate testing the wrong bit is caught too.
    await db.exec(
      `UPDATE "User" SET "excludeFromLeaderboards" = true, flags = ${UserFlag.DisablePayout} WHERE id = ${PLACER}`
    );
    expect(await countedOn(IMAGES[0])).toEqual({ Blue: 1 });
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

  // The switch re-syncs the owner's images a batch (2000) at a time: an owner with more than one
  // batch gets all of them back, not only the first.
  it('an owner with more than one batch of stickered images gets every one back', async () => {
    const extra = 2_001;
    await db.exec(`
      INSERT INTO "Image" (id, "userId", "postId")
        SELECT 10000 + g, ${OUTSIDER}, 1 FROM generate_series(1, ${extra}) g;
      INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data)
        SELECT 'e', id, ${PLACER}, 'Blue', 11, '{}' FROM "Image" WHERE id > 10000;
    `);
    // A loop that stops advancing its cursor re-reads the first batch forever: cut it off, so the
    // failure is a missing image, not a hang.
    const raw = pgliteRaw(db);
    let batches = 0;
    dbMock.dbWrite.$queryRaw.mockImplementation(((
      sql: TemplateStringsArray | Prisma.Sql,
      ...values: unknown[]
    ) => {
      const text = Array.isArray(sql) ? sql.join('') : (sql as Prisma.Sql).sql;
      if (text.includes('i."userId" =') && text.includes('s."imageId" >') && ++batches > 5)
        return Promise.reject(new Error('owner sync did not advance'));
      return raw.queryRaw(sql, ...values);
    }) as never);
    await setTurfOwnerOff('e', OUTSIDER, true);
    await setTurfOwnerOff('e', OUTSIDER, false);
    const owners = counted().filter((key) => Number(key.slice('Image:'.length)) > 10000);
    expect(owners).toHaveLength(extra);
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

  // A join landing between the up-front check and the write: the write's own guard refuses it.
  it('a join racing the check is still refused by the write', async () => {
    const raw = pgliteRaw(db);
    // The up-front check says "not joined"; the user is joined (ALLOWS) when the write runs.
    const isCheck = (sql: TemplateStringsArray | Prisma.Sql) =>
      (Array.isArray(sql) ? sql.join('') : (sql as Prisma.Sql).sql).includes('AS "optedIn" FROM');
    dbMock.dbWrite.$queryRaw.mockImplementation(((
      sql: TemplateStringsArray | Prisma.Sql,
      ...values: unknown[]
    ) =>
      isCheck(sql)
        ? Promise.resolve([{ optedIn: false }])
        : raw.queryRaw(sql, ...values)) as never);
    expect((await setTurfOwnerOff('e', ALLOWS, true)).changed).toBe(false);
    expect((await getTurfStock('e', ALLOWS)).ownerOff).toBe(false);
  });

  // By the time the sync runs the switch is saved: a failed sync must not report a failed save,
  // which would leave the client stale and a retry with nothing to change.
  it('a failed sync after the switch is saved still reports the change', async () => {
    redisMock.sysRedis.eval.mockRejectedValue(new Error('redis down') as never);
    expect((await setTurfOwnerOff('e', OUTSIDER, true)).changed).toBe(true);
    expect((await getTurfStock('e', OUTSIDER)).ownerOff).toBe(true);
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
