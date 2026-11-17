import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as TurfWatch from '~/server/events/turf/turf-watch';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';
import { turfKeys } from '~/server/events/turf/turf-map';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Contest entries show no Hat Turf: the reads and the placement against real rows, one image in a
 * contest collection beside one in a bookmark collection. Ids are invented.
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
  getUserTeam: vi.fn(async (_userId: number, _opts?: { strict?: boolean }) => 'Blue'),
  getTeamCosmetic: async () => 11,
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
// getTurfStock and getTurfSummaries read through Kysely, not Prisma's `$queryRaw`: both Kysely
// clients' statements go to the same PGlite (see beforeEach).
const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('~/server/db/kyselyDb.lazy', async () =>
  (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
);
const pushTurfCounts = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/events/turf/turf-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfWatch>()),
  pushTurfCounts,
}));
vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace: async () => undefined,
}));

const {
  getTurfEvent,
  getTurfSummaries,
  getMyStickerHats,
  getTurfStickers,
  getTurfStickersForImages,
  placeTurfSticker,
  reconcileTurf,
  syncTurfImages,
} = await import('~/server/events/turf/turf.service');

const OWNER = 7;
const PLACER = 5;
const CONTEST_ENTRY = 900;
const BOOKMARKED = 901;
const OTHER = 902;
const LOWERCASE_PLAYER = 903;
const counts = JSON.stringify({ shown: { Blue: 1 }, counted: { Blue: 1 }, leader: 'Blue' });

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
    CREATE TABLE "FlagDay" (id serial PRIMARY KEY, event text, "startsAt" timestamp(3), "closesAt" timestamp(3), "imageIds" int[]);
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int);
    CREATE TABLE "EventCosmeticPlacement" (
      id serial PRIMARY KEY, event text NOT NULL, "userId" int NOT NULL, "endedAt" timestamp
    );
    CREATE TABLE "EventTurfSticker" (
      id bigserial PRIMARY KEY, event text, "imageId" int, "userId" int, team text,
      "cosmeticId" int, data jsonb, "createdAt" timestamptz DEFAULT now(), "removedAt" timestamptz
    );

    INSERT INTO "User" (id, settings) VALUES
      (${OWNER}, '{"eventTurfOptIn": {"e": "true"}}'),
      (${PLACER}, '{"eventTurfOptIn": {"e": "true"}}');
    INSERT INTO "Post" VALUES (1, '2026-10-01', 'Public');
    INSERT INTO "Image" (id, "userId", "postId") VALUES
      (${CONTEST_ENTRY}, ${OWNER}, 1), (${BOOKMARKED}, ${OWNER}, 1);
    INSERT INTO "Collection" VALUES (1, 'Contest'), (2, 'Bookmark');
    INSERT INTO "CollectionItem" ("collectionId", "imageId") VALUES
      (1, ${CONTEST_ENTRY}), (2, ${BOOKMARKED});
    INSERT INTO "Cosmetic" VALUES
      (11, 'ContentDecoration',
        '{"event": "e", "team": "Blue", "url": "blue-cap-art",
          "fit": {"canvas": [128, 160], "bounds": [20, 40, 108, 150], "outline": [[1, 2]]}}'),
      (12, 'ContentDecoration', '{"event": "e", "team": "Pink", "url": "pink-cap-art"}'),
      (13, 'ContentDecoration', '{"event": "e", "team": "blue"}');
    INSERT INTO "UserCosmetic" VALUES
      (${PLACER}, 11), (${PLACER}, 12), (${LOWERCASE_PLAYER}, 13);
    INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data) VALUES
      ('e', ${CONTEST_ENTRY}, ${PLACER}, 'Blue', 11, '{}'),
      ('e', ${BOOKMARKED}, ${PLACER}, 'Blue', 11, '{}');
  `);
});
afterAll(async () => db.close());

beforeEach(() => {
  const raw = pgliteRaw(db);
  kysely.read.mockReset().mockImplementation(raw.queryRaw);
  kysely.write.mockReset().mockImplementation(raw.queryRaw);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  redisMock.sysRedis.hmGet.mockImplementation((async (_key: string, fields: string[]) =>
    fields.map(() => counts)) as never);
});

describe('Hat Turf on contest entries', () => {
  it('summaries: a contest entry is hidden and closed, with no counts; a bookmarked image is not', async () => {
    const summary = await getTurfSummaries('e', [CONTEST_ENTRY, BOOKMARKED], PLACER);
    expect(summary.hidden).toEqual({ [CONTEST_ENTRY]: true });
    expect(summary.open).toEqual({ [CONTEST_ENTRY]: false, [BOOKMARKED]: true });
    expect(Object.keys(summary.images)).toEqual([String(BOOKMARKED)]);
  });

  it('summaries: a hatted image names the team of the hat that protects it', async () => {
    const hat = JSON.stringify({ ownerId: 7, cosmeticId: 11, claimKey: 'k', team: 'Pink' });
    redisMock.sysRedis.hmGet.mockImplementation((async (key: string, fields: string[]) =>
      fields.map((field) =>
        key.endsWith(':hats') ? (field === `Image:${BOOKMARKED}` ? hat : null) : counts
      )) as never);
    const { images } = await getTurfSummaries('e', [BOOKMARKED, OTHER], PLACER);
    expect(images[BOOKMARKED]).toMatchObject({ hatted: true, hattedTeam: 'Pink' });
    expect(images[OTHER]).toMatchObject({ hatted: false, hattedTeam: null });
  });

  it('no stickers are drawn on a contest entry on image detail', async () => {
    expect((await getTurfStickers('e', CONTEST_ENTRY, PLACER)).stickers).toEqual([]);
    expect((await getTurfStickers('e', BOOKMARKED, PLACER)).stickers).toHaveLength(1);
  });

  // The hat's own art is the sticker: every read that draws one carries it.
  it('a sticker carries its hat art on image detail, feed cards and pushes', async () => {
    const art = { url: 'blue-cap-art', canvas: [128, 160], bounds: [20, 40, 108, 150] };
    // The fit's outline is not needed to draw, so it does not ride along.
    expect((await getTurfStickers('e', BOOKMARKED, PLACER)).stickers[0]?.art).toEqual(art);
    const feed = await getTurfStickersForImages('e', [BOOKMARKED], 5);
    expect(feed[BOOKMARKED]?.[0]?.art).toEqual(art);
    redisMock.sysRedis.eval.mockImplementation(createLuaRedis(0).eval as never);
    redisMock.sysRedis.incr.mockResolvedValue(1 as never);
    redisMock.sysRedis.hGetAll.mockResolvedValue({} as never);
    pushTurfCounts.mockClear();
    await syncTurfImages((await getTurfEvent('e'))!, [BOOKMARKED]);
    const pushed = pushTurfCounts.mock.calls.flatMap((call) => (call as unknown[])[1] as never[]);
    const push = pushed.find((p: { imageId: number }) => p.imageId === BOOKMARKED) as
      | { stickers: { art: unknown }[] }
      | undefined;
    expect(push?.stickers[0]?.art).toEqual(art);
  });

  // Placing refuses another team's hat, so the picker offers only the player's own team's.
  it("a player's hats to place are their current team's only", async () => {
    const hats = await getMyStickerHats('e', PLACER);
    expect(hats.map((hat) => hat.cosmeticId)).toEqual([11]);
    expect(hats[0].art?.url).toBe('blue-cap-art');
  });

  it("a hat whose team is spelled in another case is still the player's, and art-less hats carry no art", async () => {
    const hats = await getMyStickerHats('e', LOWERCASE_PLAYER);
    expect(hats.map((hat) => [hat.cosmeticId, hat.art])).toEqual([[13, null]]);
  });

  // Deliberate: strict like placing. A non-strict lookup turns a failed team read into a guessed
  // team, offering hats placing would then refuse.
  it("the picker reads the player's team strictly, and a failed read errors rather than guessing", async () => {
    await getMyStickerHats('e', PLACER);
    expect(EVENT.getUserTeam).toHaveBeenLastCalledWith(PLACER, { strict: true });
    EVENT.getUserTeam.mockRejectedValueOnce(new Error('team read failed'));
    await expect(getMyStickerHats('e', PLACER)).rejects.toThrow('team read failed');
  });

  it('feed cards get no stickers for a contest entry', async () => {
    const feed = await getTurfStickersForImages('e', [CONTEST_ENTRY, BOOKMARKED], 5);
    expect(Object.keys(feed)).toEqual([String(BOOKMARKED)]);
  });

  it.each([
    ['a sync', async () => syncTurfImages((await getTurfEvent('e'))!, [CONTEST_ENTRY, BOOKMARKED])],
    ['a reconcile', async () => reconcileTurf((await getTurfEvent('e'))!)],
  ])('%s pushes nothing about a contest entry', async (_, run) => {
    redisMock.sysRedis.eval.mockImplementation(createLuaRedis(0).eval as never);
    redisMock.sysRedis.incr.mockResolvedValue(1 as never);
    redisMock.sysRedis.hGetAll.mockResolvedValue({} as never);
    pushTurfCounts.mockClear();
    await run();
    const pushed = pushTurfCounts.mock.calls.flatMap((call) => (call as unknown[])[1] as never[]);
    const of = (id: number) =>
      pushed.find((push: { imageId: number }) => push.imageId === id) as
        | { counts: unknown; stickers: unknown[] | null }
        | undefined;
    expect(of(BOOKMARKED)?.counts).not.toBeNull();
    expect(of(BOOKMARKED)?.stickers).toHaveLength(1);
    expect(of(CONTEST_ENTRY)).toEqual({ imageId: CONTEST_ENTRY, counts: null, stickers: [] });
  });

  it("today's flag shows no Turf anywhere until the next swap; an image that isn't a flag keeps its hats", async () => {
    const flag = BOOKMARKED;
    const control = 903;
    await db.exec(`
      INSERT INTO "Image" (id, "userId", "postId") VALUES (${control}, ${OWNER}, 1);
      INSERT INTO "EventTurfSticker" (event, "imageId", "userId", team, "cosmeticId", data)
        VALUES ('e', ${control}, ${PLACER}, 'Blue', 11, '{}');
      INSERT INTO "FlagDay" (event, "startsAt", "closesAt", "imageIds")
        VALUES ('e', '2026-11-01', '2099-01-01', '{${flag}}');
    `);
    try {
      expect((await getTurfStickers('e', flag, PLACER)).stickers).toEqual([]);
      expect(Object.keys(await getTurfStickersForImages('e', [flag, control], 5))).toEqual([
        String(control),
      ]);
      expect((await getTurfSummaries('e', [flag, control], PLACER)).hidden).toEqual({
        [flag]: true,
      });

      // Nothing earns on it either: a sync pushes it with no counts and leaves it off the turf map.
      const lua = createLuaRedis(0);
      redisMock.sysRedis.eval.mockImplementation(lua.eval as never);
      redisMock.sysRedis.incr.mockResolvedValue(1 as never);
      pushTurfCounts.mockClear();
      await syncTurfImages((await getTurfEvent('e'))!, [flag, control]);
      // The turf map is what reactions pay from: the flag has no entry there, the control does.
      const map = lua.hash(turfKeys('e').map) ?? {};
      expect(Object.keys(map)).toContain(`Image:${control}`);
      expect(Object.keys(map)).not.toContain(`Image:${flag}`);
      const pushed = pushTurfCounts.mock.calls.flatMap((call) => (call as unknown[])[1] as never[]);
      const of = (id: number) =>
        pushed.find((push: { imageId: number }) => push.imageId === id) as
          | { counts: unknown; stickers: unknown[] | null }
          | undefined;
      expect(of(flag)).toEqual({ imageId: flag, counts: null, stickers: [] });
      expect(of(control)?.counts).not.toBeNull();

      // The next swap moves the flags on: the old flag's hats come back.
      await db.exec(
        `INSERT INTO "FlagDay" ("closesAt", event, "startsAt", "imageIds") VALUES ('2099-01-01', 'e', '2026-11-02', '{${OTHER}}')`
      );
      expect((await getTurfStickers('e', flag, PLACER)).stickers).toHaveLength(1);

      // A day that has closed hides nothing, even with no swap after it (the race is over).
      await db.exec(
        `INSERT INTO "FlagDay" ("closesAt", event, "startsAt", "imageIds") VALUES ('2000-01-01', 'e', '2026-11-03', '{${flag}}')`
      );
      expect((await getTurfStickers('e', flag, PLACER)).stickers).toHaveLength(1);
    } finally {
      await db.exec(`
        DELETE FROM "FlagDay";
        DELETE FROM "EventTurfSticker" WHERE "imageId" = ${control};
        DELETE FROM "Image" WHERE id = ${control};
      `);
    }
  });

  it('placing on a contest entry is refused', async () => {
    await expect(
      placeTurfSticker({
        event: 'e',
        userId: PLACER,
        imageId: CONTEST_ENTRY,
        cosmeticId: 11,
        data: { x: 0.5, y: 0.5, scale: 1, rotation: 0, flip: false },
      })
    ).rejects.toThrow("Hat stickers don't go on contest entries");
  });
});
