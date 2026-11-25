import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { UserFlag } from '~/shared/constants/user-flags.constants';

/**
 * The end-of-event prizes on an in-process Postgres running the committed migrations: the Comeback Cup
 * frozen from the daily snapshot, and the scorer badges for it and the Champion.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, clickhouseLongQueries: null }));

const { awardEventPrizes, comebackCup } = await import('~/server/events/scoring/event-prizes');
const { comebackPace } = await import('~/server/events/scoring/comeback-pace');
const { loadTeamAwards } = await import('~/server/events/scoring/team-awards');
const { refreshStandings } = await import('~/server/events/scoring/cosmetic-placement.service');
const { eventSeasonKeys, LIVE_BUCKET_MS } = await import('~/server/events/points/keys');

const MIGRATIONS = [
  '20261012130000_event_cosmetic_placement',
  '20261015120000_event_points',
  '20270103120000_event_award_result',
].map((name) =>
  path.resolve(
    __dirname,
    `../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
  )
);

const event = {
  name: 'prizetest',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  teams: ['Blue', 'Pink'] as const,
  scoring: { teamAwards: [] },
};
const BASELINE = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-23T00:00:00.000Z' };
const WEEK = { from: '2026-11-24T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' };
const CUP_BADGE = 900;
const CHAMPION = { Blue: 901, Pink: 902 };

// Blue: one week scorer, one who scored only before the week, one banned since.
const BLUE_WEEK = 1;
const BLUE_EARLY = 2;
const BLUE_BANNED = 3;
const PINK = 4;
// Scored for Blue in the week, but excluded from event points.
const BLUE_EXCLUDED = 5;

const pg = { db: null as unknown as PGlite };
const award = (winner: string) =>
  awardEventPrizes(event, winner, config === null ? undefined : JSON.parse(config));
let config: string | null = null;
const comeback = (mode: string, overrides: Record<string, unknown> = {}) => ({
  mode,
  baseline: BASELINE,
  week: WEEK,
  floorPerDay: 10,
  badge: CUP_BADGE,
  ...overrides,
});
const setPrizes = (prizes: unknown) => {
  config = JSON.stringify({ mode: 'live', prizes });
};

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
    CREATE TABLE "UserCosmetic" (
      "userId" integer NOT NULL, "cosmeticId" integer NOT NULL, "claimKey" text NOT NULL DEFAULT 'claimed',
      "obtainedAt" timestamp(3) NOT NULL DEFAULT now(), "equippedAt" timestamp(3), "data" jsonb,
      "equippedToId" integer, "equippedToType" "CosmeticEntity",
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Article" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "CreatorMilestone" (key text PRIMARY KEY, threshold numeric);
    CREATE TABLE "User" (
      id integer PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3), meta jsonb,
      flags integer NOT NULL DEFAULT 0, "createdAt" timestamp(3) NOT NULL DEFAULT '2020-01-01'
    );
    INSERT INTO "User" (id) VALUES (${BLUE_WEEK}), (${BLUE_EARLY}), (${BLUE_BANNED}), (${PINK}), (${BLUE_EXCLUDED});
    UPDATE "User" SET flags = ${UserFlag.ExcludeFromEventPoints} WHERE id = ${BLUE_EXCLUDED};
  `);
  for (const file of MIGRATIONS) {
    const sql = readFileSync(file, 'utf8');
    const concurrent = sql.match(/CREATE INDEX CONCURRENTLY[^;]*;/g) ?? [];
    await pg.db.exec(concurrent.reduce((rest, statement) => rest.replace(statement, ''), sql));
    for (const statement of concurrent) await pg.db.exec(statement);
  }
});
afterAll(async () => pg.db.close());

const store = new Map<string, unknown>();
beforeEach(async () => {
  vi.clearAllMocks();
  config = null;
  store.clear();
  await pg.db.exec(`
    TRUNCATE "EventCosmeticScoreDaily"; DELETE FROM "EventAwardResult"; DELETE FROM "UserCosmetic";
    UPDATE "User" SET "bannedAt" = NULL WHERE id = ${BLUE_BANNED};
  `);
  const raw = pgliteRaw(pg.db);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  const sys = redisMock.sysRedis;
  // The referee has settled the whole season, so the standings count every award inside the event.
  const settledCut = String(Math.ceil(event.endDate.getTime() / LIVE_BUCKET_MS));
  sys.get.mockImplementation((async (key: string) =>
    key === eventSeasonKeys(event.name, 'live').cut ? settledCut : null) as never);
  sys.hGetAll.mockImplementation((async () => ({})) as never);
  sys.packed.set.mockImplementation((async (k: string, v: unknown) => {
    store.set(k, structuredClone(v));
    return 'OK';
  }) as never);
  sys.del.mockImplementation((async () => 0) as never);
  sys.hSet.mockImplementation((async () => 0) as never);
  sys.multi.mockImplementation((() => {
    const tx = { rename: () => tx, del: () => tx, exec: async () => [] };
    return tx;
  }) as never);

  // Pink scores steadily; Blue scores little before the week and a lot in it.
  const days: [string, number, string, number][] = [
    ['2026-11-05', PINK, 'Pink', 2200],
    ['2026-11-20', PINK, 'Pink', 2200],
    ['2026-11-25', PINK, 'Pink', 1000],
    ['2026-11-10', BLUE_EARLY, 'Blue', 440],
    ['2026-11-26', BLUE_WEEK, 'Blue', 700],
    ['2026-11-27', BLUE_BANNED, 'Blue', 300],
    ['2026-11-28', BLUE_EXCLUDED, 'Blue', 50],
  ];
  for (const [day, userId, team, points] of days)
    await pg.db.query(
      `INSERT INTO "EventCosmeticScoreDaily" (event, day, "userId", "cosmeticId", "claimKey", team, points, impressions)
       VALUES ($1, $2::date, $3, 11, 'claimed', $4, $5, 0)`,
      [event.name, day, userId, team, points]
    );
});

const holders = async (cosmeticId: number) =>
  (
    await pg.db.query<{ userId: number }>(
      `SELECT "userId" FROM "UserCosmetic" WHERE "cosmeticId" = $1 ORDER BY "userId"`,
      [cosmeticId]
    )
  ).rows.map((r) => r.userId);
const cupRows = async () =>
  (
    await pg.db.query<{ team: string | null; points: number; inputs: { winners: string[] } }>(
      `SELECT team, points, inputs FROM "EventAwardResult" WHERE kind = 'comeback'`
    )
  ).rows;
const standings = async () => {
  const { updatedAt: _, ...rest } = await refreshStandings(event, dbMock.dbWrite as never);
  return JSON.stringify(rest);
};

describe('comebackCup', () => {
  const windows = {
    baseline: comeback('live').baseline,
    week: comeback('live').week,
    floorPerDay: 10,
  };
  const parsed = {
    baseline: { from: new Date(BASELINE.from), to: new Date(BASELINE.to) },
    week: { from: new Date(WEEK.from), to: new Date(WEEK.to) },
    floorPerDay: windows.floorPerDay,
  };

  it('measures a near-zero baseline against the floor, so it cannot win on a tiny denominator', () => {
    // 22 baseline days at a floor of 10 a day: the floor is 220. Tiny's 1 baseline point would give a
    // ratio of 220; against the floor it is 1, below Steady's 1.5.
    const result = comebackCup(
      [
        { team: 'Tiny', baseline: 1, week: 70 },
        { team: 'Steady', baseline: 2200, week: 1050 },
      ],
      parsed
    );
    expect(result.winners).toEqual(['Steady']);
  });

  it('never divides by a zero baseline, and a team with no week points cannot win', () => {
    const result = comebackCup(
      [
        { team: 'Zero', baseline: 0, week: 700 },
        { team: 'Idle', baseline: 5000, week: 0 },
      ],
      parsed
    );
    expect(result.winners).toEqual(['Zero']);
    expect(Number.isFinite(result.teams[0].ratio)).toBe(true);
    expect(comebackCup([{ team: 'Idle', baseline: 5000, week: 0 }], parsed).winners).toEqual([]);
  });

  it('shares the Cup between teams on exactly the same ratio, and splits ones a hair apart', () => {
    expect(
      comebackCup(
        [
          { team: 'A', baseline: 3000, week: 1000 },
          { team: 'B', baseline: 9000, week: 3000 },
        ],
        parsed
      ).winners
    ).toEqual(['A', 'B']);
    // Past 2^53 a float ratio can no longer tell these apart; the exact compare still can.
    const big = 2 ** 53;
    expect(
      comebackCup(
        [
          { team: 'A', baseline: big, week: big },
          { team: 'B', baseline: big, week: big + 2 },
        ],
        parsed
      ).winners
    ).toEqual(['B']);
  });
});

describe('comebackPace', () => {
  it("ranks each team's week so far against its own pace, over the days played, and says no more", async () => {
    dbMock.dbRead.cosmetic.findMany.mockResolvedValue([
      { id: CUP_BADGE, data: { url: 'cup-badge', animated: true } },
    ] as never);
    const json = { mode: 'live', prizes: { comeback: comeback('shadow') } };
    // Six days in: Blue's 1000 over its 20 a day is +733%; Pink's 1000 over its 200 a day is -17%
    // (over the full seven days it would read -29%).
    const pace = await comebackPace(event, json, new Date('2026-11-30T00:00:00.000Z'));
    expect(pace).toEqual({
      teams: [
        { team: 'Blue', pct: 733 },
        { team: 'Pink', pct: -17 },
      ],
      week: WEEK,
      badge: { url: 'cup-badge', animated: true },
    });
    const pinkAt = async (now: string) =>
      (await comebackPace(event, json, new Date(now)))?.teams.find((t) => t.team === 'Pink')?.pct;
    // Ten minutes in, the points are spread over an hour; after the week, over all seven days.
    expect(await pinkAt('2026-11-24T00:10:00.000Z')).toBe(11900);
    expect(await pinkAt('2026-12-05T00:00:00.000Z')).toBe(-29);
    expect(await comebackPace(event, json, new Date('2026-11-23T12:00:00.000Z'))).toBeNull();
    const off = { mode: 'live', prizes: { comeback: comeback('off') } };
    expect(await comebackPace(event, off, new Date('2026-11-30T00:00:00.000Z'))).toBeNull();
  });
});

describe('awardEventPrizes', () => {
  it('freezes the Cup as a zero-point, team-less row and badges the winning team week scorers still eligible', async () => {
    setPrizes({ comeback: comeback('live') });

    expect(await award('Pink')).toEqual({ pending: false });

    const [row] = await cupRows();
    expect(row).toMatchObject({ team: null, points: 0 });
    expect(row.inputs.winners).toEqual(['Blue']);
    // Not BLUE_EARLY (scored only before the week), not PINK, not BLUE_EXCLUDED.
    expect(await holders(CUP_BADGE)).toEqual([BLUE_WEEK, BLUE_BANNED]);

    // Banned after the freeze: a rerun grants no one twice and nobody new.
    await pg.db.exec(`UPDATE "User" SET "bannedAt" = now() WHERE id = ${BLUE_BANNED}`);
    await pg.db.exec(`DELETE FROM "UserCosmetic" WHERE "userId" = ${BLUE_BANNED}`);
    await award('Pink');
    expect(await cupRows()).toHaveLength(1);
    expect(await holders(CUP_BADGE)).toEqual([BLUE_WEEK]);
  });

  describe('with an exclusion start (meta.eventPointsExcludedFrom)', () => {
    const blueCup = async () => {
      setPrizes({ comeback: comeback('live') });
      await award('Pink');
      const [row] = await cupRows();
      return (
        row.inputs as unknown as { teams: { team: string; baseline: number; week: number }[] }
      ).teams.find((t) => t.team === 'Blue');
    };
    const excludeFrom = (value: string | null) =>
      pg.db.query(`UPDATE "User" SET meta = $1::jsonb WHERE id = ${BLUE_EXCLUDED}`, [
        value === null ? null : JSON.stringify({ eventPointsExcludedFrom: value }),
      ]);
    const setFlag = (flags: number) =>
      pg.db.exec(`UPDATE "User" SET flags = ${flags} WHERE id = ${BLUE_EXCLUDED}`);
    beforeEach(() =>
      pg.db.query(
        `INSERT INTO "EventCosmeticScoreDaily" (event, day, "userId", "cosmeticId", "claimKey", team, points, impressions)
         VALUES ($1, '2026-11-15', $2, 11, 'claimed', 'Blue', 30, 0)`,
        [event.name, BLUE_EXCLUDED]
      )
    );
    afterEach(() => excludeFrom(null));

    it('counts their points before it for the standings, but none of them for the Cup or its badge', async () => {
      await excludeFrom('2026-11-29T00:00:00.000Z');
      await setFlag(0);
      const unflagged = await standings();
      await setFlag(UserFlag.ExcludeFromEventPoints);
      expect(await standings()).toBe(unflagged);

      expect(await blueCup()).toMatchObject({ baseline: 440, week: 700 + 300 });
      expect(await holders(CUP_BADGE)).not.toContain(BLUE_EXCLUDED);

      // Control: the standings comparison sees their points once the start is before them.
      await excludeFrom('2026-11-01T00:00:00.000Z');
      expect(await standings()).not.toBe(unflagged);
    });
  });

  it('leaves the standings, their winner and the team awards byte-identical', async () => {
    const before = await standings();
    const awardsBefore = await loadTeamAwards(event, event.endDate);
    setPrizes({ comeback: comeback('live'), champion: { mode: 'live', badges: CHAMPION } });

    await award('Pink');

    expect(await cupRows()).toHaveLength(1);
    expect(await standings()).toBe(before);
    expect(await loadTeamAwards(event, event.endDate)).toEqual(awardsBefore);

    // Control: the comparison sees a row that does pay a team.
    await pg.db.exec(
      `UPDATE "EventAwardResult" SET team = 'Blue', points = 1, at = '2026-11-30' WHERE kind = 'comeback'`
    );
    expect(await standings()).not.toBe(before);
  });

  it("gives the Champion badge in the winner's colour to everyone on the winning team whose hats scored", async () => {
    setPrizes({ champion: { mode: 'live', badges: CHAMPION } });

    await award('Blue');

    expect(await holders(CHAMPION.Blue)).toEqual([BLUE_WEEK, BLUE_EARLY, BLUE_BANNED]);
    expect(await holders(CHAMPION.Pink)).toEqual([]);
  });

  it('in shadow writes and grants nothing and stays pending, then grants once live', async () => {
    // Each prize alone, so neither one's shadow can stand in for the other's.
    setPrizes({ comeback: comeback('shadow') });
    expect(await award('Blue')).toEqual({ pending: true });
    setPrizes({ champion: { mode: 'shadow', badges: CHAMPION } });
    expect(await award('Blue')).toEqual({ pending: true });
    expect(await cupRows()).toEqual([]);
    expect(await holders(CUP_BADGE)).toEqual([]);
    expect(await holders(CHAMPION.Blue)).toEqual([]);

    setPrizes({ comeback: comeback('live'), champion: { mode: 'live', badges: CHAMPION } });
    expect(await award('Blue')).toEqual({ pending: false });
    expect(await holders(CUP_BADGE)).toEqual([BLUE_WEEK, BLUE_BANNED]);
    expect(await holders(CHAMPION.Blue)).toEqual([BLUE_WEEK, BLUE_EARLY, BLUE_BANNED]);
  });

  it('refuses a Champion grant when the winner has no badge configured', async () => {
    setPrizes({ champion: { mode: 'live', badges: { Pink: CHAMPION.Pink } } });
    await expect(award('Blue')).rejects.toThrow('No Champion badge');
    expect(await holders(CHAMPION.Pink)).toEqual([]);
  });

  it('refuses to grant from a Cup frozen with other windows, and waits for prizes to be configured', async () => {
    setPrizes({ comeback: comeback('live') });
    await award('Pink');
    await pg.db.exec('DELETE FROM "UserCosmetic"');

    setPrizes({
      comeback: comeback('live', {
        baseline: { from: BASELINE.from, to: '2026-11-24T00:00:00.000Z' },
      }),
    });
    await expect(award('Pink')).rejects.toThrow('other windows');
    expect(await holders(CUP_BADGE)).toEqual([]);

    setPrizes({
      comeback: comeback('live', { week: { from: '2026-11-25T00:00:00.000Z', to: WEEK.to } }),
    });
    await expect(award('Pink')).rejects.toThrow('other windows');
    expect(await holders(CUP_BADGE)).toEqual([]);

    // Not configured at all: stays pending, so a badge set up late is still granted.
    config = JSON.stringify({ mode: 'live' });
    expect(await award('Pink')).toEqual({ pending: true });
    setPrizes({});
    expect(await award('Pink')).toEqual({ pending: false });
    expect(await holders(CUP_BADGE)).toEqual([]);
  });

  it('throws on an invalid prizes field instead of reading it as none', async () => {
    setPrizes({ comeback: comeback('live', { floorPerDay: 0 }) });
    await expect(award('Pink')).rejects.toThrow();
  });
});
