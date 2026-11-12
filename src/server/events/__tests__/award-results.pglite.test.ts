import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { UserFlag } from '~/shared/constants/user-flags.constants';

/**
 * Crucible places frozen once into EventAwardResult on the settle, and read back as team awards. The
 * table is created from its own migration. Ids are invented, except 254, which the event file pays by
 * hand.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, clickhouseLongQueries: null }));

const { freezeEventAwards, flagRaceConfigKey } = await import(
  '~/server/events/scoring/award-results'
);
const { loadTeamAwards } = await import('~/server/events/scoring/team-awards');

const EVENT = {
  name: 'birthday2026',
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-12-01T00:00:00Z'),
  teams: ['Blue', 'Pink'],
  join: { claimKey: 'claimed', design: 'basic' },
  scoring: { teamAwards: [] },
};
const RALLY = 309;
const HAND_PAID = 254;
const BLUE = 101;
const PINK = 102;
const TEAMLESS = 103;
const EXCLUDED = 104;

let db: PGlite;
let config: string | null;

const totals = async () => {
  const byTeam: Record<string, number> = {};
  for (const a of await loadTeamAwards(EVENT, new Date('2026-11-30T00:00:00Z')))
    byTeam[a.team] = (byTeam[a.team] ?? 0) + a.points;
  return byTeam;
};
const setConfig = (crucibles: { id: number; prizes: number[] }[], on = true) => {
  config = JSON.stringify({ placements: { on, crucibles } });
};
async function crucible(id: number, status: string, places: [userId: number, position: number][]) {
  await db.query(`INSERT INTO "Crucible" VALUES ($1, $2, '2026-11-17T00:00:00Z')`, [id, status]);
  for (const [userId, position] of places)
    await db.query(
      `INSERT INTO "CrucibleEntry" ("crucibleId", "userId", position) VALUES ($1, $2, $3)`,
      [id, userId, position]
    );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "User" (
      id int PRIMARY KEY, "bannedAt" timestamptz, "deletedAt" timestamptz,
      "createdAt" timestamptz DEFAULT '2020-01-01', meta jsonb, flags int NOT NULL DEFAULT 0
    );
    CREATE TABLE "CreatorMilestone" (key text PRIMARY KEY, threshold numeric);
    CREATE TABLE "Crucible" (id int PRIMARY KEY, status "CrucibleStatus", "endAt" timestamptz);
    CREATE TABLE "CrucibleEntry" (
      id serial PRIMARY KEY, "crucibleId" int, "userId" int, position int
    );
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" (
      "userId" int, "cosmeticId" int, "claimKey" text, "obtainedAt" timestamptz DEFAULT now()
    );
    INSERT INTO "User" (id, flags) VALUES
      (${BLUE}, 0), (${PINK}, 0), (${TEAMLESS}, 0), (${EXCLUDED}, ${UserFlag.ExcludeFromEventPoints});
    INSERT INTO "Cosmetic" VALUES
      (11, 'ContentDecoration', '{"event": "birthday2026", "team": "Blue", "design": "basic"}'),
      (12, 'ContentDecoration', '{"event": "birthday2026", "team": "Pink", "design": "basic"}');
  `);
  await db.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20270103120000_event_award_result/migration.sql'
      ),
      'utf8'
    )
  );
});
afterAll(async () => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  config = null;
  await db.exec(`
    DELETE FROM "EventAwardResult"; DELETE FROM "CrucibleEntry"; DELETE FROM "Crucible";
    DELETE FROM "UserCosmetic";
    INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey") VALUES
      (${BLUE}, 11, 'claimed'), (${PINK}, 12, 'claimed'), (${EXCLUDED}, 11, 'claimed');
  `);
  const raw = pgliteRaw(db);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  redisMock.sysRedis.get.mockImplementation((async (key: string) =>
    key === flagRaceConfigKey(EVENT.name) ? config : null) as never);
});

describe('frozen crucible placements', () => {
  it('pays each place to its team once, and a rerun changes nothing', async () => {
    await crucible(RALLY, 'Completed', [
      [BLUE, 1],
      [PINK, 2],
      [BLUE, 3],
      [PINK, 4],
    ]);
    setConfig([{ id: RALLY, prizes: [50, 30, 20] }]);

    expect(await freezeEventAwards(EVENT)).toBe(3);
    expect(await totals()).toEqual({ Blue: 70, Pink: 30 });
    expect(await freezeEventAwards(EVENT)).toBe(0);
    expect(await totals()).toEqual({ Blue: 70, Pink: 30 });
  });

  it('records a teamless or excluded placer as unawarded, and never pays it later', async () => {
    await crucible(RALLY, 'Completed', [
      [TEAMLESS, 1],
      [EXCLUDED, 2],
      [PINK, 3],
    ]);
    setConfig([{ id: RALLY, prizes: [50, 30, 20] }]);
    expect(await freezeEventAwards(EVENT)).toBe(3);

    // Joining a team after the freeze changes nothing: the result is never computed again.
    await db.exec(`INSERT INTO "UserCosmetic" VALUES (${TEAMLESS}, 11, 'claimed')`);
    expect(await freezeEventAwards(EVENT)).toBe(0);
    expect(await totals()).toEqual({ Pink: 20 });
  });

  it('waits for the crucible to complete', async () => {
    await crucible(RALLY, 'Active', [[BLUE, 1]]);
    setConfig([{ id: RALLY, prizes: [50] }]);
    expect(await freezeEventAwards(EVENT)).toBe(0);

    await db.exec(`UPDATE "Crucible" SET status = 'Completed' WHERE id = ${RALLY}`);
    expect(await freezeEventAwards(EVENT)).toBe(1);
    expect(await totals()).toEqual({ Blue: 50 });
  });

  it('never freezes a crucible the event file pays by hand', async () => {
    await crucible(HAND_PAID, 'Completed', [[BLUE, 1]]);
    await crucible(RALLY, 'Completed', [[BLUE, 1]]);
    setConfig([
      { id: HAND_PAID, prizes: [50] },
      { id: RALLY, prizes: [1] },
    ]);
    expect(await freezeEventAwards(EVENT)).toBe(1);
    expect(await totals()).toEqual({ Blue: 1 });
  });

  it('turning placements off stops new freezes but keeps paying frozen ones', async () => {
    await crucible(RALLY, 'Completed', [[BLUE, 1]]);
    await crucible(310, 'Completed', [[PINK, 1]]);
    setConfig([{ id: RALLY, prizes: [50] }]);
    await freezeEventAwards(EVENT);

    setConfig(
      [
        { id: RALLY, prizes: [50] },
        { id: 310, prizes: [50] },
      ],
      false
    );
    expect(await freezeEventAwards(EVENT)).toBe(0);
    expect(await totals()).toEqual({ Blue: 50 });
  });

  it('freezes nothing on an unparseable key, and a voided result stops paying', async () => {
    await crucible(RALLY, 'Completed', [[BLUE, 1]]);
    config = '{"placements": {"on": "yes"}}';
    expect(await freezeEventAwards(EVENT)).toBe(0);

    setConfig([{ id: RALLY, prizes: [50] }]);
    expect(await freezeEventAwards(EVENT)).toBe(1);
    await db.exec(`UPDATE "EventAwardResult" SET "voidedAt" = now()`);
    expect(await totals()).toEqual({});
  });
});
