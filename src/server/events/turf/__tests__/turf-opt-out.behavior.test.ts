import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Who is in Hat Turf, run on a real Postgres through the service's own SQL: Hat Turf is opt-OUT for
 * anyone who has placed one of the event's hats, so the rule lives in a CASE over a jsonb setting and
 * an EXISTS, which a mocked query cannot evaluate.
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

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, settings jsonb);
    CREATE TABLE "EventCosmeticPlacement" (
      id serial PRIMARY KEY, event text NOT NULL, "userId" int NOT NULL, "endedAt" timestamp
    );
    CREATE INDEX ON "EventCosmeticPlacement" ("userId", event);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp, availability text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, ingestion text,
      "tosViolation" boolean, "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int);
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

describe('who is in Hat Turf', () => {
  it('never chosen, with a hat placed (even one since taken off): in', async () => {
    expect(await inTurf(NEVER_SET)).toBe(true);
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

  it('an owner who placed a hat has open images; an owner who opted out does not', async () => {
    const { open } = await getTurfSummaries('e', [101, 102, 103, 104]);
    expect(open).toEqual({ 101: true, 102: false, 103: true, 104: false });
  });

  it('turning it off writes an explicit false, which beats a placed hat', async () => {
    expect((await setTurfOptIn('e', NEVER_SET, false)).changed).toBe(true);
    expect(await inTurf(NEVER_SET)).toBe(false);
    const { rows } = await pg.query<{ v: unknown }>(
      `SELECT settings -> 'eventTurfOptIn' -> 'e' AS v FROM "User" WHERE id = 1`
    );
    expect(rows[0].v).toBe(false);
    expect((await setTurfOptIn('e', NEVER_SET, true)).changed).toBe(true);
    expect(await inTurf(NEVER_SET)).toBe(true);
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

  it('a placer in by default may place', async () => {
    await expect(place(NEVER_SET, 101)).rejects.toThrow('passed the checks');
  });

  it('a placer who opted out may not', async () => {
    await expect(place(OPTED_OUT, 102)).rejects.toThrow('Turn on "accept team hat stickers"');
  });

  it("an owner who opted out doesn't take stickers, even from someone in", async () => {
    await expect(place(NEVER_SET, 102)).rejects.toThrow("This creator doesn't accept");
  });
});
