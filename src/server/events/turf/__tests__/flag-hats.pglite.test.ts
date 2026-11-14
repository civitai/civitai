import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { UserFlag } from '~/shared/constants/user-flags.constants';

/**
 * Hats on today's flags, against real rows: a placement spends 1, 5 or 10 from the player's normal
 * stock, ignores the owner's Turf opt-out, and is refused off a flag or after the cut; a normal
 * sticker on a flag is refused; the shared summary hides the cut until it passes. Ids are invented.
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
    supply: [{ from: START, perHour: 0, cap: 20 }],
    creditedPlayers: [{ from: START, players: 25 }],
    renderLimit: 12,
    mapMaxEntries: 10,
  },
  getUserTeam: async () => 'Blue',
  getTeamCosmetic: async () => 11,
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('~/server/db/kyselyDb.lazy', async () =>
  (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
);
vi.mock('~/server/services/placement-moderation.service', () => ({
  assertCanPlace: () => Promise.resolve(),
}));
vi.mock('~/server/services/home-block-cache.service', () => ({
  homeBlockCacheBust: async () => undefined,
}));
// The tester gate asks Flipt about the placer; on by default, as for a tester.
const flipt = vi.hoisted(() => ({ on: true }));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: async () => flipt.on,
  ensureFliptInitialized: async () => undefined,
  getFliptClientSync: () => null,
}));

const { placeFlagHats, placeTurfSticker, getFlagSummary } = await import(
  '~/server/events/turf/turf.service'
);
const { flagRaceConfigKey } = await import('~/server/events/scoring/award-results');
const { flagSummaryKey, flagSummaryGenKey } = await import('~/server/events/turf/flag-day');

const PLACER = 5;
// Keeps Hat Turf off their own images: a flag takes hats anyway.
const OWNER_OFF = 7;
const FLAG = 901;
const NOT_FLAG = 902;
const CUT = new Date('2026-11-15T15:30:00Z');
const BEFORE = new Date(CUT.getTime() - 60_000);
const FLAGS = {
  on: true,
  homeCollectionId: 77,
  size: 10,
  pot: { steps: [{ from: START, perPerson: 100, upTo: 10, after: 50 }], cap: 10_000 },
  lean: 'none',
};

let db: PGlite;
let config: object | null;
let dayId: number;
const hatsLeft = async () =>
  (
    await db.query<{ stock: number }>(`SELECT stock FROM "EventTurfStock" WHERE "userId" = $1`, [
      PLACER,
    ])
  ).rows[0]?.stock;
const add = (count: number, imageId = FLAG, now = BEFORE) =>
  placeFlagHats({ event: 'e', userId: PLACER, imageId, cosmeticId: 11, count }, now);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
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
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int);
    CREATE TABLE "EventTurfStock" (
      event text, "userId" int, stock float8, "refilledAt" timestamptz, PRIMARY KEY (event, "userId")
    );
    INSERT INTO "Post" VALUES (1, '2026-10-01', 'Public');
    INSERT INTO "Cosmetic" VALUES (11, 'ContentDecoration', '{"event":"e","team":"Blue"}');
  `);
  for (const m of ['20270103120000_event_award_result', '20270104120000_flag_race_flags'])
    await db.exec(
      readFileSync(
        path.resolve(
          __dirname,
          `../../../../../packages/civitai-db-schema/prisma/migrations/${m}/migration.sql`
        ),
        'utf8'
      )
    );
});
afterAll(async () => db.close());

beforeEach(async () => {
  config = { flags: FLAGS };
  await db.exec(`
    TRUNCATE "User", "Image", "UserCosmetic", "EventTurfStock", "FlagDay", "EventTurfFlagSticker";
    INSERT INTO "User" (id, settings) VALUES
      (${PLACER}, '{"eventTurfOptIn": {"e": true}}'),
      (${OWNER_OFF}, '{"eventTurfOwnerOff": {"e": true}}');
    INSERT INTO "UserCosmetic" VALUES (${PLACER}, 11);
    INSERT INTO "Image" (id, "userId", "postId") VALUES (${FLAG}, ${OWNER_OFF}, 1), (${NOT_FLAG}, ${OWNER_OFF}, 1);
    INSERT INTO "FlagDay" (event, "crucibleId", "startsAt", "cutAt", "closesAt", "imageIds")
      VALUES ('e', 1, '2026-11-14T16:03:00Z', '${CUT.toISOString()}', '2026-11-15T16:00:00Z', ARRAY[${FLAG}]);
    DELETE FROM "EventAwardResult";
  `);
  dayId = (await db.query<{ id: number }>(`SELECT id FROM "FlagDay"`)).rows[0].id;
  const raw = pgliteRaw(db);
  kysely.read.mockReset().mockImplementation(raw.queryRaw);
  kysely.write.mockReset().mockImplementation(raw.queryRaw);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => {
    await db.exec('BEGIN');
    try {
      const out = await fn({ $queryRaw: raw.queryRaw, $executeRaw: raw.executeRaw });
      await db.exec('COMMIT');
      return out;
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }) as never);
  redisMock.sysRedis.get.mockImplementation((async (key: string) =>
    key === flagRaceConfigKey('e') && config ? JSON.stringify(config) : null) as never);
});

describe('hats on a flag', () => {
  it('spends the count from normal stock, even on an image whose owner keeps Turf off', async () => {
    const standing = await add(10);
    expect(standing).toMatchObject({ imageId: FLAG, hatsByTeam: { Blue: 10 }, players: 1 });
    expect(await hatsLeft()).toBe(10);
    await add(5);
    expect(await hatsLeft()).toBe(5);
  });

  it('takes any count from 1 to 10, so the picker can offer what the player has', async () => {
    await add(8);
    expect(await hatsLeft()).toBe(12);
    await add(3);
    expect(await hatsLeft()).toBe(9);
  });

  it('refuses 0, a negative, a fraction and more than 10, and spends none', async () => {
    for (const count of [0, -1, 2.5, 11])
      await expect(add(count)).rejects.toThrow(/Add 1 to 10 hats at a time/);
    expect(await hatsLeft()).toBeUndefined();
  });

  it('refuses more hats than the player has, and spends none', async () => {
    await add(10);
    await add(5);
    await expect(add(10)).rejects.toThrow(/5 hat stickers left/);
    expect(await hatsLeft()).toBe(5);
  });

  it('refuses an image that is not a flag today, after the cut, and with the switch off', async () => {
    await expect(add(1, NOT_FLAG)).rejects.toThrow(/isn't a flag today/);
    await expect(add(1, FLAG, CUT)).rejects.toThrow(/closed/);
    config = { flags: { ...FLAGS, on: false } };
    await expect(add(1)).rejects.toThrow(/isn't open/);
    expect(await hatsLeft()).toBeUndefined();
  });

  it('refuses a player the tester flag is off for, and spends none; a moderator still adds', async () => {
    flipt.on = false;
    try {
      await expect(add(1)).rejects.toThrow(/isn't open/);
      expect(await hatsLeft()).toBeUndefined();
      await placeFlagHats(
        { event: 'e', userId: PLACER, isModerator: true, imageId: FLAG, cosmeticId: 11, count: 1 },
        BEFORE
      );
      expect(await hatsLeft()).toBe(19);
    } finally {
      flipt.on = true;
    }
  });

  it('refuses a player whose hats would count for nobody, and spends none', async () => {
    await db.query(`UPDATE "User" SET flags = $1 WHERE id = $2`, [
      UserFlag.ExcludeFromEventPoints,
      PLACER,
    ]);
    await expect(add(1)).rejects.toThrow(/can't add hats to flags/);
    expect(await hatsLeft()).toBeUndefined();
  });

  it('refuses a normal sticker on a flag, so it cannot go around the cut', async () => {
    await expect(
      placeTurfSticker(
        {
          event: 'e',
          userId: PLACER,
          imageId: FLAG,
          cosmeticId: 11,
          data: { x: 0.5, y: 0.5, scale: 0.22, rotation: 0, flip: false },
        },
        BEFORE
      )
    ).rejects.toThrow(/is a flag today/);
  });
});

describe('the shared flag summary', () => {
  it('hides the cut until it passes, then names the winner', async () => {
    await add(5);
    const open = await getFlagSummary('e', BEFORE);
    expect(open).toMatchObject({ closed: false, cutAt: null, frozen: false });
    expect(open?.flags[0]).toMatchObject({ hatsByTeam: { Blue: 5 }, winners: [] });

    const closed = await getFlagSummary('e', CUT);
    expect(closed).toMatchObject({ closed: true, cutAt: CUT, frozen: false });
    expect(closed?.flags[0].winners).toEqual(['Blue']);
  });

  it('names the team the freeze paid, even if a later recount would differ', async () => {
    await add(5);
    await db.query(
      `INSERT INTO "EventAwardResult" (event, "sourceId", kind, team, points, at, inputs)
       VALUES ('e', $1, 'flag', NULL, 0, $2, '{}'), ('e', $3, 'flag', 'Pink', 10, $2, '{}')`,
      [`flag:${dayId}:${FLAG}`, CUT, `flag:${dayId}:${FLAG}:Pink`]
    );
    // The recount says Blue; the freeze paid Pink (say, before an exclusion): the badge says Pink.
    const closed = await getFlagSummary('e', new Date(CUT.getTime() + 3_600_000));
    expect(closed?.flags[0].winners).toEqual(['Pink']);
    // And the row's "Race complete" chips: the points each team was paid, from the frozen rows.
    expect(closed?.teamPoints).toEqual({ Pink: 10 });
    expect(closed?.frozen).toBe(true);
  });

  it('stops counting once the freeze runs, even on a day nobody placed a hat on', async () => {
    const { freezeFlagDays } = await import('~/server/events/turf/flag-freeze');
    const after = new Date(CUT.getTime() + 120_000);
    expect(await getFlagSummary('e', after)).toMatchObject({ closed: true, frozen: false });
    // The freeze writes a marker for every flag, won or not, so an empty day still reads as paid.
    expect(await freezeFlagDays({ name: 'e', startDate: START }, FLAGS, after)).toBeGreaterThan(0);
    const frozen = await getFlagSummary('e', after);
    expect(frozen).toMatchObject({ closed: true, frozen: true, teamPoints: {} });
    expect(frozen?.flags[0].winners).toEqual([]);
  });

  it('caches an open or unfrozen day for seconds, and a frozen day for longer', async () => {
    const lastTtl = () => (redisMock.sysRedis.set.mock.calls.at(-1)?.[2] as { EX: number }).EX;
    await add(5);
    await getFlagSummary('e', BEFORE);
    const open = lastTtl();
    await getFlagSummary('e', CUT);
    const unfrozen = lastTtl();
    await db.query(
      `INSERT INTO "EventAwardResult" (event, "sourceId", kind, team, points, at, inputs)
       VALUES ('e', $1, 'flag', NULL, 0, $2, '{}')`,
      [`flag:${dayId}:${FLAG}`, CUT]
    );
    await getFlagSummary('e', new Date(CUT.getTime() + 3_600_000));
    const frozen = lastTtl();
    // Until the freeze has run, a cached summary must not hide it for long.
    expect(open).toBeLessThanOrEqual(10);
    expect(unfrozen).toBeLessThanOrEqual(10);
    expect(frozen).toBeGreaterThan(unfrozen);
  });

  it('never serves a summary built before the latest swap', async () => {
    await add(5);
    await getFlagSummary('e', BEFORE);
    const cached = redisMock.sysRedis.set.mock.calls.at(-1)?.[1] as string;
    const serve = (gen: string | null) =>
      redisMock.sysRedis.get.mockImplementation((async (key: string) => {
        if (key === flagRaceConfigKey('e')) return JSON.stringify(config);
        if (key === flagSummaryKey('e')) return cached;
        if (key === flagSummaryGenKey('e')) return gen;
        return null;
      }) as never);
    serve(null);
    redisMock.sysRedis.set.mockClear();
    await getFlagSummary('e', BEFORE);
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
    // A swap since (the generation moved on): the cached day is rebuilt, not served.
    serve('1');
    await getFlagSummary('e', BEFORE);
    expect(redisMock.sysRedis.set).toHaveBeenCalledOnce();
  });
});
