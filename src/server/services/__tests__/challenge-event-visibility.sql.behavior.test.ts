import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import type * as UserService from '~/server/services/user.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// Event listings run the challenge feed's own visibility SQL, executed here against an in-process
// Postgres: which of an event's challenges a viewer is shown, and how many it counts.

const { hiddenUsers } = vi.hoisted(() => ({
  hiddenUsers: vi.fn(async () => [] as { id: number }[]),
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getChallengeConfig: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
  getCosmeticsForUsers: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const none = { getCached: vi.fn(async () => []) };
  return {
    ...(await importOriginal<typeof UserPreferencesService>()),
    HiddenUsers: { getCached: hiddenUsers },
    BlockedUsers: none,
    BlockedByUsers: none,
  };
});

const { getActiveEvents, getChallengeEventById } = await import(
  '~/server/services/challenge.service'
);

const pg = { db: null as unknown as PGlite };
const VIEWER = 333;
const OTHER = 444;
const EVENT = 7;

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TYPE "ChallengeIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked');
    CREATE TYPE "ChallengeSource" AS ENUM ('System', 'Mod', 'User');
    CREATE TYPE "ChallengeStatus" AS ENUM ('Scheduled', 'Active', 'Completing', 'Completed', 'Cancelled');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "nsfwLevel" int NOT NULL, poi boolean NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL
    );
    CREATE TABLE "Challenge" (
      id int PRIMARY KEY, "eventId" int, "nsfwLevel" int NOT NULL,
      ingestion "ChallengeIngestionStatus" NOT NULL, "coverImageId" int,
      source "ChallengeSource" NOT NULL, "buzzType" text NOT NULL, "createdById" int NOT NULL,
      "visibleAt" timestamp NOT NULL, status "ChallengeStatus" NOT NULL
    );
  `);
  const raw = pgliteRaw(pg.db);
  // Only the visibility queries touch the in-process database; every other read is empty.
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) =>
    strings.join('').includes('FROM "Challenge" c')
      ? raw.queryRaw(strings, ...values)
      : []) as never);
});

afterAll(async () => {
  await pg.db.close();
});

type Row = {
  nsfwLevel: number;
  ingestion: string;
  coverImageId: number | null;
  source: string;
  buzzType: string;
  createdById: number;
  visibleAt: string;
  status: string;
  cover: { nsfwLevel: number; poi: boolean; ingestion: string };
};

const visible: Row = {
  nsfwLevel: NsfwLevel.PG,
  ingestion: 'Scanned',
  coverImageId: 80,
  source: 'System',
  buzzType: 'yellow',
  createdById: OTHER,
  visibleAt: '2020-01-01',
  status: 'Active',
  cover: { nsfwLevel: NsfwLevel.PG, poi: false, ingestion: 'Scanned' },
};

async function seed(rows: Row[]) {
  await pg.db.exec(`DELETE FROM "Challenge"; DELETE FROM "Image";`);
  for (const [i, r] of rows.entries()) {
    const id = i + 1;
    await pg.db.query(`INSERT INTO "Image" VALUES ($1, $2, $3, $4)`, [
      80 + id,
      r.cover.nsfwLevel,
      r.cover.poi,
      r.cover.ingestion,
    ]);
    await pg.db.query(`INSERT INTO "Challenge" VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
      id,
      EVENT,
      r.nsfwLevel,
      r.ingestion,
      r.coverImageId == null ? null : 80 + id,
      r.source,
      r.buzzType,
      r.createdById,
      r.visibleAt,
      r.status,
    ]);
  }
  dbMock.dbRead.challengeEvent.findMany.mockResolvedValue([
    {
      id: EVENT,
      title: 'Event',
      description: null,
      titleColor: null,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2030-01-01'),
      coverImageId: null,
      challenges: rows.map((r, i) => ({
        id: i + 1,
        title: `c${i + 1}`,
        theme: null,
        invitation: null,
        coverImageId: r.coverImageId == null ? null : 80 + i + 1,
        startsAt: new Date('2026-01-01'),
        endsAt: new Date('2030-01-01'),
        status: r.status,
        source: r.source,
        buzzType: r.buzzType,
        nsfwLevel: r.nsfwLevel,
        allowedNsfwLevel: r.nsfwLevel,
        prizePool: 0,
        modelVersionIds: [],
        collectionId: null,
        createdById: r.createdById,
        judgeId: null,
      })),
    },
  ] as never);
  dbMock.dbRead.challengeEvent.findUnique.mockResolvedValue({
    id: EVENT,
    title: 'Event',
    description: null,
    titleColor: null,
    startDate: new Date('2026-01-01'),
    endDate: new Date('2030-01-01'),
    coverImageId: null,
    active: true,
    // What the event row's own challenge count would say, ungated.
    _count: { challenges: rows.length },
  } as never);
  dbMock.dbRead.user.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.image.findMany.mockResolvedValue([] as never);
}

type Viewer = { isGreen: boolean; viewerId?: number; userChallenges?: boolean };

async function shown(row: Partial<Row>, viewer: Viewer) {
  await seed([{ ...visible, ...row, cover: { ...visible.cover, ...row.cover } }]);
  const site = { isGreen: viewer.isGreen, viewerId: viewer.viewerId };
  const flag = viewer.userChallenges ?? true;
  const [event] = await getActiveEvents(site, flag);
  return event.challenges.length === 1;
}

const greenOut: Viewer = { isGreen: true };
const greenIn: Viewer = { isGreen: true, viewerId: VIEWER };
const mature: Viewer = { isGreen: false, viewerId: VIEWER };

beforeEach(() => {
  hiddenUsers.mockResolvedValue([]);
});

describe('event listings apply the challenge feed visibility rules', () => {
  it('shows a scanned, rated, visible challenge to everyone', async () => {
    for (const viewer of [greenOut, greenIn, mature]) expect(await shown({}, viewer)).toBe(true);
  });

  it("hides a challenge rated above the green site's level", async () => {
    expect(await shown({ nsfwLevel: NsfwLevel.R }, greenIn)).toBe(false);
    expect(await shown({ nsfwLevel: NsfwLevel.PG13 }, greenOut)).toBe(false);
    expect(await shown({ nsfwLevel: NsfwLevel.PG13 }, greenIn)).toBe(true);
  });

  it("hides a challenge whose cover is above the green site's level", async () => {
    expect(await shown({ cover: { ...visible.cover, nsfwLevel: NsfwLevel.R } }, greenIn)).toBe(
      false
    );
  });

  it('keeps a mature challenge on the mature site', async () => {
    expect(
      await shown(
        { nsfwLevel: NsfwLevel.X, cover: { ...visible.cover, nsfwLevel: NsfwLevel.X } },
        mature
      )
    ).toBe(true);
  });

  it.each(['Pending', 'Blocked', 'Error'])(
    'hides a challenge whose text scan is %s',
    async (ingestion) => {
      expect(await shown({ ingestion }, mature)).toBe(false);
    }
  );

  it('hides a challenge whose cover depicts a real person', async () => {
    expect(await shown({ cover: { ...visible.cover, poi: true } }, mature)).toBe(false);
  });

  it("hides a user challenge whose cover hasn't been scanned", async () => {
    const user = { source: 'User', buzzType: 'green' };
    expect(
      await shown({ ...user, cover: { ...visible.cover, ingestion: 'Pending' } }, greenIn)
    ).toBe(false);
  });

  it("hides a user challenge from the other site's currency", async () => {
    expect(await shown({ source: 'User', buzzType: 'yellow' }, greenIn)).toBe(false);
    expect(await shown({ source: 'User', buzzType: 'yellow' }, mature)).toBe(true);
  });

  it('hides user challenges while user challenges are off', async () => {
    expect(await shown({ source: 'User' }, { ...mature, userChallenges: false })).toBe(false);
  });

  it('hides a challenge before it is visible', async () => {
    expect(await shown({ visibleAt: '2999-01-01' }, mature)).toBe(false);
  });

  it('hides a challenge with no cover', async () => {
    expect(await shown({ coverImageId: null }, mature)).toBe(false);
  });

  it('hides a user challenge whose creator the viewer has hidden', async () => {
    hiddenUsers.mockResolvedValue([{ id: OTHER }]);
    expect(await shown({ source: 'User' }, mature)).toBe(false);
  });

  it('shows a creator their own unscanned, above-level challenge', async () => {
    expect(
      await shown(
        {
          createdById: VIEWER,
          source: 'User',
          buzzType: 'green',
          ingestion: 'Pending',
          nsfwLevel: NsfwLevel.R,
        },
        greenIn
      )
    ).toBe(true);
  });

  it('counts only the challenges it lists', async () => {
    await seed([visible, { ...visible, ingestion: 'Blocked' }]);
    const site = { isGreen: false, viewerId: VIEWER };
    const [event] = await getActiveEvents(site, true);
    const { challengeCount } = await getChallengeEventById(EVENT, site, true);
    expect(event.challenges).toHaveLength(1);
    expect(challengeCount).toBe(1);
  });

  it("shows a scanned user challenge in the site's own currency on the green site", async () => {
    expect(await shown({ source: 'User', buzzType: 'green' }, greenIn)).toBe(true);
  });

  it('shows a creator their own challenge before it is visible', async () => {
    expect(await shown({ createdById: VIEWER, visibleAt: '2999-01-01' }, mature)).toBe(true);
  });

  it('leaves cancelled challenges out of the count', async () => {
    await seed([visible, { ...visible, status: 'Cancelled' }]);
    const { challengeCount } = await getChallengeEventById(EVENT, { isGreen: false }, true);
    expect(challengeCount).toBe(1);
  });
});
