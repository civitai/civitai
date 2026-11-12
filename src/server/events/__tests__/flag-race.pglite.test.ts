import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { UserFlag } from '~/shared/constants/user-flags.constants';

/**
 * The Flag Race day: a finished flag Crucible's top places become the home row's flags (the swap),
 * and after the cut each flag's pot is frozen once to the team with the most hats on it. The tables
 * come from their own migrations; ids and amounts are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, clickhouseLongQueries: null }));
const homeBlockCacheBust = vi.fn(async () => undefined);
vi.mock('~/server/services/home-block-cache.service', () => ({ homeBlockCacheBust }));
const catchUp: Record<string, number> = {};
const catchUpAt: Date[] = [];
vi.mock('~/server/events/turf/turf.service', () => ({
  getTurfEvent: async () => ({ name: 'birthday2026' }),
  turfCatchUpAt: async (_event: unknown, team: string, at: Date) => {
    catchUpAt.push(at);
    return catchUp[team] ?? 1;
  },
}));

const { swapFlagDay, pickCutAt, flagPot } = await import('~/server/events/turf/flag-day');
const { freezeEventAwards, flagRaceConfigKey } = await import(
  '~/server/events/scoring/award-results'
);
const { loadTeamAwards } = await import('~/server/events/scoring/team-awards');
const { freezeFlagDays } = await import('~/server/events/turf/flag-freeze');

const EVENT = {
  name: 'birthday2026',
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-12-01T00:00:00Z'),
  teams: ['Blue', 'Pink'],
  join: { claimKey: 'claimed', design: 'basic' },
  scoring: { teamAwards: [] },
};
const TAG = 'birthday2026-flag';
const HOME = 77;
const END = new Date('2026-11-14T16:00:00Z');
const SWAP = new Date('2026-11-14T16:03:00Z');
// The settle after the next day's cut.
const SETTLE = new Date('2026-11-15T16:05:00Z');
const POT = {
  steps: [{ from: new Date('2026-11-01T00:00:00Z'), perPerson: 100, upTo: 2, after: 50 }],
  cap: 1_000,
};
const FLAGS = { on: true, homeCollectionId: HOME, size: 3, pot: POT, lean: 'none' as const };

let db: PGlite;
let config: string | null;
const setFlags = (flags: object) => {
  config = JSON.stringify({ flags });
};

async function crucible(
  id: number,
  status: string,
  tags: string[],
  entries: [image: number, position: number, nsfw: number][]
) {
  await db.query(`INSERT INTO "Crucible" VALUES ($1, $2::"CrucibleStatus", $3, $4)`, [
    id,
    status,
    END,
    tags,
  ]);
  for (const [image, position, nsfw] of entries) {
    await db.query(`INSERT INTO "Image" (id, "nsfwLevel") VALUES ($1, $2)`, [image, nsfw]);
    await db.query(
      `INSERT INTO "CrucibleEntry" ("crucibleId", "imageId", position) VALUES ($1, $2, $3)`,
      [id, image, position]
    );
  }
}
const homeItems = async () =>
  (
    await db.query<{ imageId: number }>(
      `SELECT "imageId" FROM "CollectionItem" WHERE "collectionId" = $1 ORDER BY "createdAt" DESC`,
      [HOME]
    )
  ).rows.map((r) => r.imageId);
async function hats(
  flagDayId: number,
  imageId: number,
  userId: number,
  team: string,
  count: number,
  at: Date
) {
  await db.query(
    `INSERT INTO "EventTurfFlagSticker" (event, "flagDayId", "imageId", "userId", team, "cosmeticId", count, "createdAt")
     VALUES ('birthday2026', $1, $2, $3, $4, 1, $5, $6)`,
    [flagDayId, imageId, userId, team, count, at]
  );
}
const totals = async () => {
  const byTeam: Record<string, number> = {};
  for (const a of await loadTeamAwards(EVENT, new Date('2026-11-30T00:00:00Z')))
    byTeam[a.team] = (byTeam[a.team] ?? 0) + a.points;
  return byTeam;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
    CREATE TABLE "User" (
      id int PRIMARY KEY, "bannedAt" timestamptz, "deletedAt" timestamptz,
      "createdAt" timestamptz DEFAULT '2020-01-01', meta jsonb, flags int NOT NULL DEFAULT 0
    );
    CREATE TABLE "CreatorMilestone" (key text PRIMARY KEY, threshold numeric);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamptz, availability text);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int DEFAULT 1, "userId" int DEFAULT 1, "nsfwLevel" int,
      ingestion text DEFAULT 'Scanned', "tosViolation" boolean DEFAULT false, "needsReview" text,
      "blockedFor" text
    );
    CREATE TABLE "Crucible" (id int PRIMARY KEY, status "CrucibleStatus", "endAt" timestamptz, "eventTags" text[]);
    CREATE TABLE "CrucibleEntry" (id serial PRIMARY KEY, "crucibleId" int, "imageId" int, position int);
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int, "imageId" int, status "CollectionItemStatus",
      "createdAt" timestamptz
    );
    INSERT INTO "User" (id) VALUES (1), (2), (201), (202), (203), (204), (205);
    INSERT INTO "Post" VALUES (1, '2026-11-01', 'Public'), (2, NULL, 'Public'), (3, '2026-11-01', 'Private');
  `);
  for (const m of ['20270103120000_event_award_result', '20270104120000_flag_race_flags'])
    await db.exec(
      readFileSync(
        path.resolve(
          __dirname,
          `../../../../packages/civitai-db-schema/prisma/migrations/${m}/migration.sql`
        ),
        'utf8'
      )
    );
});
afterAll(async () => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  config = null;
  for (const k of Object.keys(catchUp)) delete catchUp[k];
  catchUpAt.length = 0;
  await db.exec(`
    DELETE FROM "EventAwardResult"; DELETE FROM "EventTurfFlagSticker"; DELETE FROM "FlagDay";
    DELETE FROM "CollectionItem"; DELETE FROM "CrucibleEntry"; DELETE FROM "Crucible";
    DELETE FROM "Image"; UPDATE "User" SET "bannedAt" = NULL, "deletedAt" = NULL, flags = 0;
    INSERT INTO "CollectionItem" ("collectionId", "imageId", status, "createdAt")
      VALUES (${HOME}, 999, 'ACCEPTED', '2026-11-13T16:00:00Z');
  `);
  const raw = pgliteRaw(db);
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
    key === flagRaceConfigKey(EVENT.name) ? config : null) as never);
});

describe('the swap', () => {
  it("makes the finished flag Crucible's top places the home row, in rank order, once", async () => {
    await crucible(
      1,
      'Completed',
      [TAG],
      [
        [11, 2, 1],
        [12, 1, 2],
        [13, 3, 1],
        [14, 4, 1],
      ]
    );
    const day = await swapFlagDay(EVENT, FLAGS, SWAP);
    expect(day?.imageIds).toEqual([12, 11, 13]);
    expect(await homeItems()).toEqual([12, 11, 13]);
    expect(homeBlockCacheBust).toHaveBeenCalledOnce();

    expect(await swapFlagDay(EVENT, FLAGS, new Date(SWAP.getTime() + 5 * 60_000))).toBeUndefined();
    expect(await homeItems()).toEqual([12, 11, 13]);
  });

  it('leaves out a place re-rated past PG-13 since it entered, without filling its slot from below', async () => {
    await crucible(
      1,
      'Completed',
      [TAG],
      [
        [11, 1, 1],
        [12, 2, 4],
        [13, 3, 2],
        [14, 4, 1],
      ]
    );
    expect((await swapFlagDay(EVENT, FLAGS, SWAP))?.imageIds).toEqual([11, 13]);
  });

  it('ignores a Crucible without the flag tag, one still running, and the switch off', async () => {
    await crucible(1, 'Completed', ['other'], [[11, 1, 1]]);
    await crucible(2, 'Active', [TAG], [[12, 1, 1]]);
    expect(await swapFlagDay(EVENT, FLAGS, SWAP)).toBeUndefined();
    await crucible(3, 'Completed', [TAG], [[13, 1, 1]]);
    expect(await swapFlagDay(EVENT, { ...FLAGS, on: false }, SWAP)).toBeUndefined();
    expect(await homeItems()).toEqual([999]);
  });
});

describe('what the swap may raise as a flag', () => {
  it('only an image anyone may see, from an active owner; a failing place is left empty', async () => {
    await crucible(
      1,
      'Completed',
      [TAG],
      [
        [21, 1, 1],
        [22, 2, 1],
        [23, 3, 1],
        [24, 4, 1],
        [25, 5, 1],
        [26, 6, 1],
        [27, 7, 1],
        [28, 8, 1],
        [29, 9, 1],
      ]
    );
    await db.exec(`
      UPDATE "Image" SET "postId" = 2 WHERE id = 21;
      UPDATE "Image" SET "postId" = 3 WHERE id = 22;
      UPDATE "Image" SET ingestion = 'Pending' WHERE id = 23;
      UPDATE "Image" SET "tosViolation" = true WHERE id = 24;
      UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 25;
      UPDATE "Image" SET "blockedFor" = 'tos' WHERE id = 26;
      UPDATE "Image" SET "userId" = 2 WHERE id IN (27, 28);
      UPDATE "User" SET "bannedAt" = now() WHERE id = 2;
    `);
    await db.exec(
      `UPDATE "Image" SET "userId" = 205 WHERE id = 28; UPDATE "User" SET "deletedAt" = now() WHERE id = 205`
    );
    expect((await swapFlagDay(EVENT, { ...FLAGS, size: 10 }, SWAP))?.imageIds).toEqual([29]);
  });

  it('records the cut inside the hour before the day closes', async () => {
    await crucible(1, 'Completed', [TAG], [[11, 1, 1]]);
    const day = await swapFlagDay(EVENT, FLAGS, SWAP);
    expect(day?.closesAt.toISOString()).toBe('2026-11-15T16:00:00.000Z');
    expect(day!.cutAt < day!.closesAt).toBe(true);
    expect(day!.cutAt.getTime()).toBeGreaterThanOrEqual(day!.closesAt.getTime() - 3_600_000);
  });

  it('takes no Crucible that ended over a day ago, none yet to end, and none after the event', async () => {
    await db.query(`INSERT INTO "Crucible" VALUES (1, 'Completed', $1, $2)`, [
      new Date(SWAP.getTime() - 25 * 3_600_000),
      [TAG],
    ]);
    await db.query(`INSERT INTO "Crucible" VALUES (2, 'Completed', $1, $2)`, [
      new Date(SWAP.getTime() + 60_000),
      [TAG],
    ]);
    expect(await swapFlagDay(EVENT, FLAGS, SWAP)).toBeUndefined();
    await crucible(3, 'Completed', [TAG], [[11, 1, 1]]);
    expect(await swapFlagDay({ ...EVENT, endDate: SWAP }, FLAGS, SWAP)).toBeUndefined();
  });

  it('never goes back to an older Crucible once a newer one is showing', async () => {
    await crucible(2, 'Completed', [TAG], [[12, 1, 1]]);
    await db.query(`INSERT INTO "Crucible" VALUES (1, 'Completed', $1, $2)`, [
      new Date(END.getTime() - 2 * 3_600_000),
      [TAG],
    ]);
    await db.query(`INSERT INTO "Image" (id, "nsfwLevel") VALUES (11, 1)`);
    await db.query(
      `INSERT INTO "CrucibleEntry" ("crucibleId", "imageId", position) VALUES (1, 11, 1)`
    );
    expect((await swapFlagDay(EVENT, FLAGS, SWAP))?.crucibleId).toBe(2);
    expect(await swapFlagDay(EVENT, FLAGS, new Date(SWAP.getTime() + 300_000))).toBeUndefined();
    expect(await homeItems()).toEqual([12]);
  });
});

describe('the cut', () => {
  it('falls in the hour before the next swap, or before the event ends', () => {
    const latest = pickCutAt(END, EVENT.endDate, () => 0);
    const earliest = pickCutAt(END, EVENT.endDate, (n) => n - 1);
    expect(latest.toISOString()).toBe('2026-11-15T15:59:59.999Z');
    expect(earliest.toISOString()).toBe('2026-11-15T15:00:00.000Z');
    const lastDay = pickCutAt(new Date('2026-11-30T16:00:00Z'), EVENT.endDate, () => 0);
    expect(lastDay < EVENT.endDate).toBe(true);
    expect(lastDay > new Date('2026-11-30T23:00:00Z')).toBe(true);
  });
});

describe('the pot', () => {
  it('pays per person up to the step, then the lower rate, under the cap', () => {
    expect(flagPot(POT, 2, END).pot).toBe(200);
    expect(flagPot(POT, 5, END).pot).toBe(350);
    expect(flagPot(POT, 100, END).pot).toBe(1_000);
  });
  it('uses the step live at the cut, so a later step leaves earlier flags alone', () => {
    const steps = {
      ...POT,
      steps: [
        ...POT.steps,
        { from: new Date('2026-11-20T00:00:00Z'), perPerson: 300, upTo: 2, after: 50 },
      ],
    };
    expect(flagPot(steps, 2, new Date('2026-11-19T15:30:00Z')).pot).toBe(200);
    expect(flagPot(steps, 2, new Date('2026-11-20T15:30:00Z')).pot).toBe(600);
  });
});

describe('the flag freeze', () => {
  async function dayWithFlags() {
    await crucible(
      1,
      'Completed',
      [TAG],
      [
        [11, 1, 1],
        [12, 2, 1],
      ]
    );
    const day = await swapFlagDay(EVENT, FLAGS, SWAP);
    if (!day) throw new Error('no flag day');
    return day;
  }

  it('pays each flag to the team with the most hats before the cut, once', async () => {
    const day = await dayWithFlags();
    const before = new Date(day.cutAt.getTime() - 60_000);
    await hats(day.id, 11, 201, 'Blue', 5, before);
    await hats(day.id, 11, 202, 'Pink', 1, before);
    await hats(day.id, 11, 203, 'Pink', 1, before);
    // After the cut: would hand Pink the flag if it counted.
    await hats(day.id, 11, 204, 'Pink', 10, new Date(day.cutAt.getTime() + 1));
    setFlags(FLAGS);

    expect(await freezeEventAwards(EVENT, SETTLE)).toBeGreaterThan(0);
    // 3 players before the cut: 2 at 100, 1 at 50.
    expect(await totals()).toEqual({ Blue: 250 });
    expect(await freezeEventAwards(EVENT, SETTLE)).toBe(0);
    expect(await totals()).toEqual({ Blue: 250 });
  });

  it('splits a tie, leans each share by its own catch-up, and never reprices', async () => {
    const day = await dayWithFlags();
    const before = new Date(day.cutAt.getTime() - 60_000);
    await hats(day.id, 12, 201, 'Blue', 5, before);
    await hats(day.id, 12, 202, 'Pink', 5, before);
    catchUp.Blue = 0.25;
    catchUp.Pink = 4;
    setFlags({ ...FLAGS, lean: 'sqrt' });

    await freezeEventAwards(EVENT, SETTLE);
    // Pot 200, 100 a side; sqrt leans 0.5 and 2.
    expect(await totals()).toEqual({ Blue: 50, Pink: 200 });
    catchUp.Blue = 4;
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = 202`);
    await freezeEventAwards(EVENT, SETTLE);
    expect(await totals()).toEqual({ Blue: 50, Pink: 200 });
  });

  it('keeps a frozen flag with its winner when a later ban would hand it to the other team', async () => {
    const day = await dayWithFlags();
    const before = new Date(day.cutAt.getTime() - 60_000);
    await hats(day.id, 11, 201, 'Blue', 5, before);
    await hats(day.id, 11, 202, 'Pink', 1, before);
    setFlags(FLAGS);
    await freezeEventAwards(EVENT, SETTLE);
    expect(await totals()).toEqual({ Blue: 200 });
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = 201`);
    expect(await freezeEventAwards(EVENT, new Date(SETTLE.getTime() + 3_600_000))).toBe(0);
    expect(await totals()).toEqual({ Blue: 200 });
  });

  it('pays each flag to its own winner, from its own players', async () => {
    const day = await dayWithFlags();
    const before = new Date(day.cutAt.getTime() - 60_000);
    await hats(day.id, 11, 201, 'Blue', 5, before);
    await hats(day.id, 12, 202, 'Pink', 1, before);
    await hats(day.id, 12, 203, 'Pink', 1, before);
    await hats(day.id, 12, 204, 'Pink', 1, before);
    setFlags(FLAGS);
    await freezeEventAwards(EVENT, SETTLE);
    // Flag 11: 1 player, 100. Flag 12: 3 players, 2 at 100 and 1 at 50.
    expect(await totals()).toEqual({ Blue: 100, Pink: 250 });
  });

  it.each([
    ['none', 100],
    ['sqrt', 200],
    ['full', 400],
  ] as const)('leans a winning share by catch-up when lean is %s', async (lean, points) => {
    const day = await dayWithFlags();
    await hats(day.id, 11, 201, 'Blue', 1, new Date(day.cutAt.getTime() - 60_000));
    catchUp.Blue = 4;
    setFlags({ ...FLAGS, lean });
    await freezeEventAwards(EVENT, SETTLE);
    expect(await totals()).toEqual({ Blue: points });
    // The catch-up is read at the cut, not at whenever the settle ran.
    expect(catchUpAt).toEqual([day.cutAt]);
  });

  it("counts an excluded or deleted player's hats for nobody", async () => {
    const day = await dayWithFlags();
    const before = new Date(day.cutAt.getTime() - 60_000);
    await hats(day.id, 11, 201, 'Blue', 1, before);
    await hats(day.id, 11, 202, 'Pink', 10, before);
    await hats(day.id, 12, 203, 'Pink', 10, before);
    await hats(day.id, 12, 201, 'Blue', 1, before);
    await db.query(`UPDATE "User" SET flags = $1 WHERE id = 202`, [
      UserFlag.ExcludeFromEventPoints,
    ]);
    await db.query(`UPDATE "User" SET "deletedAt" = now() WHERE id = 203`);
    setFlags(FLAGS);
    await freezeEventAwards(EVENT, SETTLE);
    expect(await totals()).toEqual({ Blue: 200 });
  });

  it('inserts nothing on a rerun, without failing', async () => {
    const day = await dayWithFlags();
    await hats(day.id, 11, 201, 'Blue', 1, new Date(day.cutAt.getTime() - 60_000));
    expect(await freezeFlagDays(EVENT, FLAGS, SETTLE)).toBeGreaterThan(0);
    // Called directly: freezeEventAwards would turn a throw into 0.
    await expect(freezeFlagDays(EVENT, FLAGS, SETTLE)).resolves.toBe(0);
  });

  it("counts a banned player's hats for nobody", async () => {
    const day = await dayWithFlags();
    const before = new Date(day.cutAt.getTime() - 60_000);
    await hats(day.id, 11, 201, 'Blue', 1, before);
    await hats(day.id, 11, 202, 'Pink', 10, before);
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = 202`);
    setFlags(FLAGS);
    await freezeEventAwards(EVENT, SETTLE);
    expect(await totals()).toEqual({ Blue: 100 });
  });

  it('freezes a zero-pot flag at 0 points and pays no team (the pre-launch tester flag)', async () => {
    const day = await dayWithFlags();
    const before = new Date(day.cutAt.getTime() - 60_000);
    await hats(day.id, 11, 201, 'Blue', 5, before);
    await hats(day.id, 12, 202, 'Pink', 5, before);
    const zero = {
      ...FLAGS,
      pot: {
        steps: [{ from: new Date('2026-11-01T00:00:00Z'), perPerson: 0, upTo: 0, after: 0 }],
        cap: 1,
      },
    };
    setFlags(zero);

    expect(await freezeEventAwards(EVENT, SETTLE)).toBeGreaterThan(0);
    const rows = await db.query<{ points: number }>(
      `SELECT points FROM "EventAwardResult" WHERE kind = 'flag' AND team IS NOT NULL`
    );
    expect(rows.rows.map((r) => r.points)).toEqual([0, 0]);
    expect(await totals()).toEqual({});
  });

  it('freezes nothing before the cut', async () => {
    const day = await dayWithFlags();
    await hats(day.id, 11, 201, 'Blue', 1, SWAP);
    setFlags(FLAGS);
    expect(await freezeEventAwards(EVENT, new Date(day.cutAt.getTime() - 1))).toBe(0);
    // Nor in the minute after it, while a placement that started before the cut may still commit.
    expect(await freezeEventAwards(EVENT, new Date(day.cutAt.getTime() + 30_000))).toBe(0);
    expect(await freezeEventAwards(EVENT, SETTLE)).toBeGreaterThan(0);
  });
});
