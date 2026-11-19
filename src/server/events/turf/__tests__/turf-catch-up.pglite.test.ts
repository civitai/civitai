import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as TurfWatch from '~/server/events/turf/turf-watch';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { eventSeasonKeys } from '~/server/events/points/keys';
import { turfConfigKey } from '~/server/events/turf/config';

/**
 * Catch-up supply through the service: the stock a player reads and spends, against real stock rows,
 * with the team totals read from the same sysRedis hashes the standings read. Ids and numbers are
 * invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const START = new Date('2026-11-01T00:00:00Z');
const TEAMS = ['Blue', 'Pink', 'Green', 'Gold'];
const TEAM_OF: Record<number, string> = { 5: 'Blue', 6: 'Pink' };
const EVENT = {
  name: 'e',
  startDate: START,
  endDate: new Date('2099-12-01T00:00:00Z'),
  teams: TEAMS,
  scoring: { finalizeAfterMs: 0 },
  turf: {
    mode: 'live',
    testerFlag: 'e-turf',
    supply: [{ from: START, perHour: 10, cap: 50 }],
    creditedPlayers: [{ from: START, players: 25 }],
    renderLimit: 12,
    mapMaxEntries: 10,
  },
  getUserTeam: vi.fn(async (userId: number) => TEAM_OF[userId]),
  getTeamCosmetic: async () => 11,
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

const { getTurfStock, placeTurfSticker } = await import('~/server/events/turf/turf.service');

const TRAILING = 5; // Blue: 800 against a mean of 1000, the full gap below
const LEADING = 6; // Pink: 1200, the full gap above
const IMAGE = 900;
const POINTS = { Blue: '800', Pink: '1200', Green: '1000', Gold: '1000' };
const CATCH_UP = JSON.stringify({
  catchUp: [{ from: '2026-11-01T00:00:00Z', max: 2, min: 0.5, gap: 0.2 }],
});
const teamBase = eventSeasonKeys('e', 'live').base('team');

let db: PGlite;
// The config and team totals are cached per server for up to a minute; each read starts later.
let clock = new Date('2026-11-05T00:00:00Z').getTime();
const later = () => new Date((clock += 10 * 60_000));
let override: string | null = null;
let teamPointsFail = false;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, settings jsonb, "bannedAt" timestamptz, "deletedAt" timestamptz
    );
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
    -- Read by getTurfStock's count of the player's live hats; empty here.
    CREATE TABLE "EventTurfSticker" (
      id bigserial PRIMARY KEY, event text, "imageId" int, "userId" int, team text,
      "cosmeticId" int, data jsonb, "createdAt" timestamptz DEFAULT now(), "removedAt" timestamptz
    );
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int);
    CREATE TABLE "EventTurfStock" (
      event text, "userId" int, stock double precision, "refilledAt" timestamptz,
      PRIMARY KEY (event, "userId")
    );
    INSERT INTO "User" (id, settings) VALUES
      (7, '{}'),
      (${TRAILING}, '{"eventTurfOptIn": {"e": "true"}}'),
      (${LEADING}, '{"eventTurfOptIn": {"e": "true"}}');
    INSERT INTO "Post" VALUES (1, '2026-10-01', 'Public');
    INSERT INTO "Image" (id, "userId", "postId") VALUES (${IMAGE}, 7, 1);
    INSERT INTO "Cosmetic" VALUES (11, 'ContentDecoration', '{"event": "e", "team": "Blue"}');
    INSERT INTO "Cosmetic" VALUES (12, 'ContentDecoration', '{"event": "e", "team": "Pink"}');
    INSERT INTO "UserCosmetic" VALUES (${TRAILING}, 11), (${LEADING}, 12);
  `);
});
afterAll(async () => db.close());

beforeEach(async () => {
  await db.exec(`DELETE FROM "EventTurfStock"`);
  override = null;
  teamPointsFail = false;
  EVENT.getUserTeam.mockClear();
  const raw = pgliteRaw(db);
  kysely.read.mockReset().mockImplementation(raw.queryRaw);
  kysely.write.mockReset().mockImplementation(raw.queryRaw);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  dbMock.dbRead.eventTurfStock.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { event_userId: { event: string; userId: number } };
  }) => {
    const { rows } = await db.query<{ stock: number; refilledAt: Date }>(
      `SELECT stock, "refilledAt" FROM "EventTurfStock" WHERE event = $1 AND "userId" = $2`,
      [where.event_userId.event, where.event_userId.userId]
    );
    return rows[0] ?? null;
  }) as never);
  redisMock.sysRedis.get.mockImplementation((async (key: string) =>
    key === turfConfigKey('e') ? override : null) as never);
  redisMock.sysRedis.hmGet.mockImplementation((async (key: string, fields: string[]) => {
    if (key !== teamBase) return fields.map(() => null);
    if (teamPointsFail) throw new Error('sysRedis down');
    return fields.map((field) => POINTS[field as keyof typeof POINTS] ?? null);
  }) as never);
});

const setStock = (userId: number, stock: number, refilledAt: Date) =>
  db.query(`INSERT INTO "EventTurfStock" VALUES ('e', $1, $2, $3)`, [userId, stock, refilledAt]);
const place = (userId: number, now: Date) =>
  placeTurfSticker(
    {
      event: 'e',
      userId,
      imageId: IMAGE,
      cosmeticId: userId === TRAILING ? 11 : 12,
      data: { x: 0.5, y: 0.5, scale: 1, rotation: 0, flip: false },
    },
    now
  );
const storedStock = async (userId: number) =>
  (
    await db.query<{ stock: number }>(`SELECT stock FROM "EventTurfStock" WHERE "userId" = $1`, [
      userId,
    ])
  ).rows[0]?.stock;

describe('Hat Turf catch-up supply', () => {
  it('with no catch-up configured, supply is the schedule as written and no team is read', async () => {
    const now = later();
    await setStock(TRAILING, 10, new Date(now.getTime() - 2 * 3600_000));
    const stock = await getTurfStock('e', TRAILING, now);
    // 10 + 2h at 10/h; the next sticker in 6 minutes.
    expect(stock).toMatchObject({ available: 30, perHour: 10, cap: 50, multiplier: 1 });
    expect(stock.nextAt).toEqual(new Date(now.getTime() + 6 * 60_000));
    expect(EVENT.getUserTeam).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hmGet).not.toHaveBeenCalledWith(teamBase, expect.anything());
  });

  it('a trailing team reads the raised rate, cap and next-sticker time', async () => {
    override = CATCH_UP;
    const now = later();
    await setStock(TRAILING, 10, new Date(now.getTime() - 2 * 3600_000));
    const stock = await getTurfStock('e', TRAILING, now);
    // 10 + 2h at 20/h; the next sticker in 3 minutes.
    expect(stock).toMatchObject({ available: 50, perHour: 20, cap: 100, multiplier: 2 });
    expect(stock.nextAt).toEqual(new Date(now.getTime() + 3 * 60_000));
  });

  it('a leading team reads the lowered cap, and keeps stock it already holds above it', async () => {
    override = CATCH_UP;
    const now = later();
    await setStock(LEADING, 45, new Date(now.getTime() - 3600_000));
    const stock = await getTurfStock('e', LEADING, now);
    expect(stock).toMatchObject({
      available: 45,
      perHour: 5,
      cap: 25,
      nextAt: null,
      multiplier: 0.5,
    });
  });

  it("a trailing team's first placement opens a bucket at the raised cap and spends from it", async () => {
    override = CATCH_UP;
    await place(TRAILING, later());
    expect(await storedStock(TRAILING)).toBe(99);
  });

  it("a trailing team's placement refills an existing bucket at the raised rate", async () => {
    override = CATCH_UP;
    const now = later();
    await setStock(TRAILING, 10, new Date(now.getTime() - 2 * 3600_000));
    await place(TRAILING, now);
    // 10 + 2h at 20/h (10/h x 2) - 1 placed.
    expect(await storedStock(TRAILING)).toBe(49);
  });

  it("a leading team's placement refills an existing bucket at the lowered rate and cap", async () => {
    override = CATCH_UP;
    let now = later();
    await setStock(LEADING, 10, new Date(now.getTime() - 2 * 3600_000));
    await place(LEADING, now);
    // 10 + 2h at 5/h (10/h x 0.5) - 1 placed.
    expect(await storedStock(LEADING)).toBe(19);

    now = later();
    await db.exec(`DELETE FROM "EventTurfStock"`);
    await setStock(LEADING, 20, new Date(now.getTime() - 4 * 3600_000));
    await place(LEADING, now);
    // 20 + 4h at 5/h = 40, held to the cap of 25 (50 x 0.5) - 1 placed.
    expect(await storedStock(LEADING)).toBe(24);
  });

  it('a later step takes over at its own minute, not before', async () => {
    const boundary = new Date('2026-11-15T00:00:00Z');
    override = JSON.stringify({
      catchUp: [
        { from: '2026-11-01T00:00:00Z', max: 2, min: 0.5, gap: 0.2 },
        { from: boundary.toISOString(), max: 4, min: 0.2, gap: 0.2 },
      ],
    });
    const before = new Date(boundary.getTime() - 60_000);
    const after = new Date(boundary.getTime() + 60_000);
    clock = after.getTime();
    await setStock(TRAILING, 0, before);
    expect(await getTurfStock('e', TRAILING, before)).toMatchObject({ perHour: 20, cap: 100 });
    expect(await getTurfStock('e', TRAILING, after)).toMatchObject({ perHour: 40, cap: 200 });
  });

  it('team totals that cannot be read leave supply as written', async () => {
    override = CATCH_UP;
    teamPointsFail = true;
    const now = later();
    await setStock(TRAILING, 10, new Date(now.getTime() - 2 * 3600_000));
    expect(await getTurfStock('e', TRAILING, now)).toMatchObject({
      available: 30,
      perHour: 10,
      cap: 50,
    });
  });

  it('team totals that cannot be read leave a placement at supply as written', async () => {
    override = CATCH_UP;
    teamPointsFail = true;
    const now = later();
    await setStock(TRAILING, 10, new Date(now.getTime() - 2 * 3600_000));
    await place(TRAILING, now);
    // 10 + 2h at 10/h - 1 placed.
    expect(await storedStock(TRAILING)).toBe(29);
  });
});
