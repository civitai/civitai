import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Who is in Hat Turf, run on a real Postgres through the service's own SQL: only an explicit opt-in
 * counts, so the fixture includes hat placers who never chose, to prove they stay out. Joining is
 * for players only: any owner's image is turf, opted in or not.
 */

const START = new Date('2026-11-01T00:00:00Z');
const EVENT = {
  name: 'e',
  startDate: START,
  endDate: new Date('2026-12-01T00:00:00Z'),
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

const { getTurfStock, getTurfSummaries, placeTurfSticker, setTurfOptIn } = await import(
  '~/server/events/turf/turf.service'
);

const pg = new PGlite();
const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = Prisma.sql(strings, ...values);
  return pg.query(sql.text, sql.values as unknown[]);
};

const NEVER_SET = 1;
const OPTED_OUT = 2;
const OPTED_IN = 3;
const NO_HAT = 4;
const BANNED = 5;
const DELETED = 6;

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, settings jsonb, "bannedAt" timestamptz, "deletedAt" timestamptz
    );
    CREATE TABLE "EventCosmeticPlacement" (
      id serial PRIMARY KEY, event text NOT NULL, "userId" int NOT NULL, "endedAt" timestamp
    );
    CREATE INDEX ON "EventCosmeticPlacement" ("userId", event);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp, availability text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, ingestion text,
      "tosViolation" boolean, "needsReview" text, "blockedFor" text
    );
    -- Read by getTurfStock's count of the player's live hats; empty here.
    CREATE TABLE "EventTurfSticker" (
      id bigserial PRIMARY KEY, event text, "imageId" int, "userId" int, team text,
      "cosmeticId" int, data jsonb, "createdAt" timestamptz DEFAULT now(), "removedAt" timestamptz
    );
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int);
    -- Read by the contest-entry rule; empty, so no image here is a contest entry.
    CREATE TABLE "Collection" (id int PRIMARY KEY, mode text);
    CREATE TABLE "CollectionItem" (id serial PRIMARY KEY, "collectionId" int, "imageId" int);
    -- contestEntry also reads running flag Crucibles and today's flags.
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "Crucible" (id int PRIMARY KEY, status "CrucibleStatus", "eventTags" text[]);
    CREATE TABLE "CrucibleEntry" (id serial PRIMARY KEY, "crucibleId" int, "imageId" int);
    CREATE TABLE "FlagDay" (id serial PRIMARY KEY, event text, "startsAt" timestamp(3), "imageIds" int[]);
    INSERT INTO "Cosmetic" VALUES (11, 'ContentDecoration', '{"event":"e","team":"Blue"}');
  `);
});
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`
    TRUNCATE "User", "EventCosmeticPlacement", "Post", "Image", "UserCosmetic";
    INSERT INTO "User" VALUES
      (1, NULL),
      (2, '{"eventTurfOptIn":{"e":false}}'),
      (3, '{"eventTurfOptIn":{"e":true}}'),
      (4, '{"eventTurfOptIn":{"other":true}}');
    INSERT INTO "User" (id, "bannedAt") VALUES (5, now());
    INSERT INTO "User" (id, "deletedAt") VALUES (6, now());
    -- Hats placed: an ended one still counts; a hat of another event does not.
    INSERT INTO "EventCosmeticPlacement" (event, "userId", "endedAt") VALUES
      ('e', 1, now()), ('e', 2, NULL), ('other', 4, NULL);
    INSERT INTO "Post" VALUES (1, now() - interval '1 day', 'Public');
    INSERT INTO "Image" SELECT 100 + id, id, 1, 'Scanned', false, NULL, NULL FROM "User";
    INSERT INTO "UserCosmetic" SELECT id, 11 FROM "User";
  `);
  dbMock.dbRead.$queryRaw.mockImplementation(
    (async (s: TemplateStringsArray, ...v: unknown[]) => (await run(s, ...v)).rows) as never
  );
  kysely.read
    .mockReset()
    .mockImplementation(
      async (s: readonly string[], ...v: unknown[]) => (await run(s as never, ...v)).rows
    );
  kysely.write
    .mockReset()
    .mockImplementation(
      async (s: readonly string[], ...v: unknown[]) => (await run(s as never, ...v)).rows
    );
  dbMock.dbWrite.$queryRaw.mockImplementation(
    (async (s: TemplateStringsArray, ...v: unknown[]) => (await run(s, ...v)).rows) as never
  );
  // Past every check, placing opens its transaction: stop there.
  dbMock.dbWrite.$transaction.mockRejectedValue(new Error('passed the checks') as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (s: TemplateStringsArray, ...v: unknown[]) =>
      (await run(s, ...v)).affectedRows ?? 0) as never
  );
  dbMock.dbRead.eventTurfStock.findUnique.mockResolvedValue(null as never);
});

const inTurf = async (userId: number) => (await getTurfStock('e', userId)).optedIn;

describe('the stock and summary reads', () => {
  it('run through Kysely, one statement each, and never reach the Prisma query engine', async () => {
    kysely.read.mockClear();
    dbMock.dbRead.$queryRaw.mockClear();
    dbMock.dbWrite.$queryRaw.mockClear();

    const stock = await getTurfStock('e', OPTED_IN);
    expect({
      optedIn: stock.optedIn,
      left: stock.left,
      ownerOff: stock.ownerOff,
      liveHats: stock.liveHats,
    }).toEqual({ optedIn: true, left: false, ownerOff: false, liveHats: 0 });

    const { open, mine, hidden, images } = await getTurfSummaries('e', [101, 105, 106], OPTED_IN);
    expect({ open, mine, hidden, images }).toEqual({
      open: { 101: true, 105: false, 106: false },
      mine: { 101: false, 105: false, 106: false },
      hidden: {},
      images: {},
    });

    expect(kysely.read).toHaveBeenCalledTimes(2);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('who is in Hat Turf', () => {
  // Deliberate: Hat Turf is opt-in only. Making placing a hat count as joining is a product
  // decision for the event owner, not a code cleanup.
  it('placing a hat never opts anyone in: never chosen, with a hat placed, is out', async () => {
    expect(await inTurf(NEVER_SET)).toBe(false);
  });

  it('never chosen for this event, no hat of this event placed: out', async () => {
    expect(await inTurf(NO_HAT)).toBe(false);
  });

  it('opted out, with a hat placed: out', async () => {
    expect(await inTurf(OPTED_OUT)).toBe(false);
  });

  it('opted in, with no hat placed: in', async () => {
    expect(await inTurf(OPTED_IN)).toBe(true);
  });

  // The detail invite opens by itself only for someone who never joined; a leaver is not nagged.
  it('only someone who joined and then left is a leaver', async () => {
    const left = async (userId: number) => (await getTurfStock('e', userId)).left;
    expect(await left(OPTED_OUT)).toBe(true);
    expect(await left(NEVER_SET)).toBe(false);
    expect(await left(OPTED_IN)).toBe(false);
    expect(await left(NO_HAT)).toBe(false);
  });

  // Deliberate: turf is played on anyone's image; an owner need not join. Gating on the owner again
  // is a product decision for the event owner, not a code cleanup.
  it('every visible image is open, whatever its owner chose', async () => {
    const { open } = await getTurfSummaries('e', [101, 102, 103, 104]);
    expect(open).toEqual({ 101: true, 102: true, 103: true, 104: true });
  });

  it("a banned or deleted owner's images are closed", async () => {
    const { open } = await getTurfSummaries('e', [101, 105, 106]);
    expect(open).toEqual({ 101: true, 105: false, 106: false });
  });

  it('turning it on writes an explicit true, and turning it off takes the user out again', async () => {
    expect((await setTurfOptIn('e', NEVER_SET, true)).changed).toBe(true);
    expect(await inTurf(NEVER_SET)).toBe(true);
    expect((await setTurfOptIn('e', NEVER_SET, false)).changed).toBe(true);
    expect(await inTurf(NEVER_SET)).toBe(false);
    const { rows } = await pg.query<{ v: unknown }>(
      `SELECT settings -> 'eventTurfOptIn' -> 'e' AS v FROM "User" WHERE id = 1`
    );
    expect(rows[0].v).toBe(false);
  });
});

describe('placing a hat sticker', () => {
  const NOW = new Date('2026-11-05T12:00:00Z');
  const place = (userId: number, imageId: number) =>
    placeTurfSticker(
      {
        event: 'e',
        userId,
        imageId,
        cosmeticId: 11,
        data: { x: 0.5, y: 0.5, scale: 1, rotation: 0, flip: false },
      },
      NOW
    );

  it('a placer who opted in may place', async () => {
    await expect(place(OPTED_IN, 103)).rejects.toThrow('passed the checks');
  });

  it('a placer who placed hats but never opted in may not', async () => {
    await expect(place(NEVER_SET, 103)).rejects.toThrow('Join Hat Turf');
  });

  it('a placer who opted out may not', async () => {
    await expect(place(OPTED_OUT, 102)).rejects.toThrow('Join Hat Turf');
  });

  it('an owner who never opted in still takes stickers from someone in', async () => {
    await expect(place(OPTED_IN, 101)).rejects.toThrow('passed the checks');
  });

  it('an owner who opted out still takes stickers from someone in', async () => {
    await expect(place(OPTED_IN, 102)).rejects.toThrow('passed the checks');
  });

  it("a banned or deleted owner's image takes none", async () => {
    await expect(place(OPTED_IN, 100 + BANNED)).rejects.toThrow("can't put hat stickers");
    await expect(place(OPTED_IN, 100 + DELETED)).rejects.toThrow("can't put hat stickers");
  });
});
