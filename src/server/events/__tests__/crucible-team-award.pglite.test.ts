import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Push from '~/server/events/points/push';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Team points per accepted crucible entrant: the hook that grants and revokes against real Postgres
 * rows, the ledger rows it writes kept in memory, and the settle's read of them. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const EVENT = {
  name: 'birthday2026',
  startDate: new Date('2020-06-01T00:00:00Z'),
  endDate: new Date('2099-12-01T00:00:00Z'),
  teams: ['Blue', 'Pink'],
  join: { claimKey: 'claimed', design: 'basic' },
  scoring: { teamAwards: [] },
};
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => [EVENT] }));
const markEventTeamsDirty = vi.hoisted(() => vi.fn(() => true));
vi.mock('~/server/events/points/push', async (importOriginal) => ({
  ...(await importOriginal<typeof Push>()),
  markEventTeamsDirty,
}));

// The ledger: what the hook inserts, read back by the settle's one query (event and type only; the
// rest is the code under test).
type LedgerRow = Record<string, unknown> & { event: string; type: string };
const ledger = vi.hoisted(() => [] as LedgerRow[]);
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: async ({ values }: { values: LedgerRow[] }) => void ledger.push(...values),
    query: async ({ query_params }: { query_params: { event: string; type: string } }) => ({
      json: async () =>
        ledger.filter((r) => r.event === query_params.event && r.type === query_params.type),
    }),
  },
}));

const { acceptCrucibleEntry, revokeCrucibleEntry, sweepAcceptedCrucibleEntries } = await import(
  '~/server/services/crucible-entry-accepted'
);
const { crucibleTeamAwardSubscriber } = await import('~/server/events/crucible-team-award');
const { loadTeamAwards } = await import('~/server/events/scoring/team-awards');

const RALLY = 7;
const UNTAGGED = 8;
const BLUE = 101;
const TEAMLESS = 102;
const BANNED = 103;

let db: PGlite;
const hashes = new Map<string, Map<string, string>>();

const entryRef = (entryId: number, userId = BLUE, crucibleId = RALLY) => ({
  entryId,
  crucibleId,
  userId,
});
const settled = async () =>
  (await loadTeamAwards(EVENT, new Date('2099-01-01T00:00:00Z'))).reduce(
    (sum, a) => sum + a.points,
    0
  );
const adds = () => ledger.filter((r) => r.op === 'add').length;
const liveIncrements = () =>
  redisMock.sysRedis.hIncrBy.mock.calls.filter(([, team]) => team === 'Blue').length;

async function enter(entryId: number, userId = BLUE, crucibleId = RALLY) {
  await db.query(`INSERT INTO "Image" (id, "postId") VALUES ($1, 1)`, [entryId + 1000]);
  await db.query(
    `INSERT INTO "CrucibleEntry" (id, "crucibleId", "userId", "imageId") VALUES ($1, $2, $3, $4)`,
    [entryId, crucibleId, userId, entryId + 1000]
  );
  return entryRef(entryId, userId, crucibleId);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');
    CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
    CREATE TABLE "User" (
      id int PRIMARY KEY, "bannedAt" timestamptz, "deletedAt" timestamptz,
      "createdAt" timestamptz DEFAULT '2020-01-01', meta jsonb,
      "excludeFromLeaderboards" boolean DEFAULT false
    );
    CREATE TABLE "CreatorMilestone" (key text PRIMARY KEY, threshold numeric);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamptz);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "tosViolation" boolean DEFAULT false, "needsReview" text, "nsfwLevel" int DEFAULT 1
    );
    CREATE TABLE "Crucible" (
      id int PRIMARY KEY, status "CrucibleStatus", "endAt" timestamptz, "nsfwLevel" int,
      "eventTags" text[]
    );
    CREATE TABLE "CrucibleEntry" (
      id int PRIMARY KEY, "crucibleId" int, "userId" int, "imageId" int
    );
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" (
      "userId" int, "cosmeticId" int, "claimKey" text, "createdAt" timestamptz DEFAULT now()
    );

    INSERT INTO "User" (id, "bannedAt") VALUES (${BLUE}, NULL), (${TEAMLESS}, NULL), (${BANNED}, now());
    INSERT INTO "Post" VALUES (1, '2026-10-01');
    INSERT INTO "Crucible" VALUES
      (${RALLY}, 'Active', '2099-01-01', 3, '{birthday2026-rally}'),
      (${UNTAGGED}, 'Active', '2099-01-01', 3, '{}');
    INSERT INTO "Cosmetic" VALUES
      (11, 'ContentDecoration', '{"event": "birthday2026", "team": "Blue", "design": "basic"}');
    INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey") VALUES
      (${BLUE}, 11, 'claimed'), (${BANNED}, 11, 'claimed');
  `);
});
afterAll(async () => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  hashes.clear();
  ledger.length = 0;
  await db.exec(`DELETE FROM "CrucibleEntry"; DELETE FROM "Image";`);
  const raw = pgliteRaw(db);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw as never);
    client.$executeRaw.mockImplementation(raw.executeRaw as never);
    client.crucible.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) => {
      const { rows } = await db.query<{ eventTags: string[] }>(
        'SELECT "eventTags" FROM "Crucible" WHERE id = $1',
        [where.id]
      );
      return rows[0] ?? null;
    }) as never);
  }
  const { sysRedis } = redisMock;
  sysRedis.hExists.mockImplementation(
    (async (key: string, field: string) => hashes.get(key)?.has(field) ?? false) as never
  );
  sysRedis.hSet.mockImplementation((async (key: string, field: string, value: string) => {
    const hash = hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    hashes.set(key, hash);
    return 1;
  }) as never);
  sysRedis.hGetAll.mockImplementation((async (key: string) =>
    Object.fromEntries(hashes.get(key) ?? [])) as never);
  sysRedis.hDel.mockImplementation((async (key: string, field: string) =>
    hashes.get(key)?.delete(field) ? 1 : 0) as never);
  sysRedis.hIncrBy.mockResolvedValue(1000 as never);
  sysRedis.expire.mockResolvedValue(true as never);
});

describe('team points for accepted crucible entrants', () => {
  it("gives the entrant's team 1,000 once, live and at the settle", async () => {
    const entry = await enter(1);

    expect(await acceptCrucibleEntry(entry)).toBe(true);

    expect(ledger).toEqual([
      expect.objectContaining({
        event: 'birthday2026',
        type: 'crucibleTeamAward',
        op: 'add',
        actorId: BLUE,
        entityType: 'Crucible',
        entityId: RALLY,
        team: 'Blue',
        sourceId: 'crucibleEntry:1',
      }),
    ]);
    expect(liveIncrements()).toBe(1);
    expect(redisMock.sysRedis.hIncrBy).toHaveBeenCalledWith(expect.any(String), 'Blue', 1000);
    expect(markEventTeamsDirty).toHaveBeenCalledTimes(1);
    expect(await settled()).toBe(1000);
  });

  it('the sweep grants each judgeable entrant of a tagged crucible once, and takes back a deleted image', async () => {
    await enter(1);
    await enter(2, BLUE, UNTAGGED);

    expect(await sweepAcceptedCrucibleEntries()).toMatchObject({ accepted: 1 });
    expect(await sweepAcceptedCrucibleEntries()).toMatchObject({ accepted: 0 });
    expect(adds()).toBe(1);

    await db.query('UPDATE "CrucibleEntry" SET "imageId" = NULL WHERE id = 1');
    expect(await sweepAcceptedCrucibleEntries()).toMatchObject({ revoked: 1 });
    expect(await settled()).toBe(0);
  });

  it('counts a repeated accept of one entry once', async () => {
    const entry = await enter(1);
    await acceptCrucibleEntry(entry);
    // The hook delivers at least once: a second delivery writes a second add.
    await crucibleTeamAwardSubscriber.accept({ ...entry, acceptedAt: new Date() });

    expect(adds()).toBe(2);
    expect(await settled()).toBe(1000);
  });

  it('keeps the award while a second entry of the same entrant stays, and counts the crucible once', async () => {
    await acceptCrucibleEntry(await enter(1));
    await acceptCrucibleEntry(await enter(2));
    expect(await settled()).toBe(1000);

    await db.query('UPDATE "CrucibleEntry" SET "imageId" = NULL WHERE id = 1');
    await revokeCrucibleEntry(entryRef(1));
    expect(await settled()).toBe(1000);

    await db.query('UPDATE "CrucibleEntry" SET "imageId" = NULL WHERE id = 2');
    await revokeCrucibleEntry(entryRef(2));
    expect(await settled()).toBe(0);
  });

  it('counts an entry again once it is accepted again after a revoke', async () => {
    const entry = await enter(1);
    await acceptCrucibleEntry(entry);
    await revokeCrucibleEntry(entry);
    expect(await settled()).toBe(0);

    // A later accept writes a later add.
    await new Promise((r) => setTimeout(r, 5));
    expect(await acceptCrucibleEntry(entry)).toBe(true);
    expect(await settled()).toBe(1000);
  });

  it('stops counting an entry hidden later without a removal, and counts it again once shown', async () => {
    await acceptCrucibleEntry(await enter(1));
    expect(await settled()).toBe(1000);

    await db.query('UPDATE "Image" SET "tosViolation" = true WHERE id = 1001');
    expect(await settled()).toBe(0);

    await db.query('UPDATE "Image" SET "tosViolation" = false WHERE id = 1001');
    expect(await settled()).toBe(1000);
  });

  it.each([
    ['its image is deleted', 'UPDATE "CrucibleEntry" SET "imageId" = NULL WHERE id = 1'],
    ['its entry row is gone', 'DELETE FROM "CrucibleEntry" WHERE id = 1'],
    ['its entrant is banned', `UPDATE "User" SET "bannedAt" = now() WHERE id = ${BLUE}`],
    [
      'its entrant deletes their account',
      `UPDATE "User" SET "deletedAt" = now() WHERE id = ${BLUE}`,
    ],
    [
      'its entrant is excluded from leaderboards',
      `UPDATE "User" SET "excludeFromLeaderboards" = true WHERE id = ${BLUE}`,
    ],
  ])('stops counting an entry at the next settle once %s', async (_, change) => {
    await acceptCrucibleEntry(await enter(1));
    expect(await settled()).toBe(1000);

    await db.query(change);

    expect(await settled()).toBe(0);
    await db.query(
      `UPDATE "User" SET "bannedAt" = NULL, "deletedAt" = NULL, "excludeFromLeaderboards" = false
       WHERE id = ${BLUE}`
    );
  });

  it('gives nothing to an entrant with no team, or one who may not earn', async () => {
    await acceptCrucibleEntry(await enter(1, TEAMLESS));
    await acceptCrucibleEntry(await enter(2, BANNED));

    expect(ledger).toEqual([]);
    expect(redisMock.sysRedis.hIncrBy).not.toHaveBeenCalled();
  });

  it('gives nothing for a crucible without the rally tag', async () => {
    const entry = await enter(1, BLUE, UNTAGGED);
    await crucibleTeamAwardSubscriber.accept({ ...entry, acceptedAt: new Date() });

    expect(ledger).toEqual([]);
  });
});
