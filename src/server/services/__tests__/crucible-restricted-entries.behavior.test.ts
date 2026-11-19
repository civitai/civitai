import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import type * as EloService from '~/server/services/crucible-elo.service';
import { CrucibleIngestionStatus, CrucibleStatus } from '~/shared/utils/prisma/enums';

/**
 * An entry whose mature image was made with a base model that restricts mature images reaches only
 * its entrant: not the grid, not a judge. Runs the entry SQL as written against real Postgres.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const getAllEntryElos = vi.fn();
vi.mock('~/server/services/crucible-elo.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EloService>()),
  getAllEntryElos,
}));

const { getCrucibleEntries, getJudgingPair } = await import('~/server/services/crucible.service');

const CRUCIBLE = 1;
const ENTRANT = 7;
const JUDGE = 50;
const PG_R = 1 | 4;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'NotFound');
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3));
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, "deletedAt" timestamp(3), image text, "profilePictureId" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      url text, type text NOT NULL DEFAULT 'image', width int, height int,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text,
      "tosViolation" boolean NOT NULL DEFAULT false,
      "postId" int,
      "nsfwLevel" int NOT NULL,
      "modelRestricted" boolean NOT NULL DEFAULT false, "blockedFor" text);
    CREATE TABLE "CrucibleEntry" (
      id int PRIMARY KEY,
      "crucibleId" int NOT NULL,
      "userId" int NOT NULL,
      "imageId" int,
      score int NOT NULL DEFAULT 1500,
      position int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    INSERT INTO "Post" VALUES (1, now());
    INSERT INTO "User" (id, username) VALUES (100, 'a'), (101, 'b'), (102, 'c'), (${ENTRANT}, 'e');
    INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", "modelRestricted") VALUES
      (11, 100, 1, 1, true),
      (12, 101, 1, 4, false),
      (13, ${ENTRANT}, 1, 4, true),
      (14, 102, 1, 1, false);
    INSERT INTO "CrucibleEntry" (id, "crucibleId", "userId", "imageId") VALUES
      (1, ${CRUCIBLE}, 100, 11),        -- PG, so the restriction doesn't apply
      (2, ${CRUCIBLE}, 101, 12),        -- R, made with an unrestricted model
      (3, ${CRUCIBLE}, ${ENTRANT}, 13), -- R, made with a restricted model
      (4, ${CRUCIBLE}, 102, 14);
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await pg.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
  dbMock.dbRead.crucible.findUnique.mockResolvedValue({
    id: CRUCIBLE,
    status: CrucibleStatus.Active,
    endAt: new Date(Date.now() + 60 * 60_000),
    userId: 999,
    textNsfw: false,
    nsfwLevel: PG_R,
    ingestion: CrucibleIngestionStatus.Scanned,
    takenDownAt: null,
    minViewSeconds: null,
    prizePositions: [],
    image: { ingestion: 'Scanned', needsReview: null, tosViolation: false },
  } as never);
  dbMock.dbRead.crucibleEntry.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ id, image: { id: id * 10 } }))) as never);
  getAllEntryElos.mockResolvedValue({});
  redisMock.sysRedis.hGetAll.mockResolvedValue({});
  redisMock.sysRedis.sMembers.mockResolvedValue([]);
  redisMock.sysRedis.set.mockResolvedValue('OK');
});

const listedIds = async (userId?: number) =>
  (
    await getCrucibleEntries({
      crucibleId: CRUCIBLE,
      limit: 50,
      seed: 3,
      userId,
      browsingLevel: PG_R,
    })
  ).items
    .map(({ id }) => id)
    .sort();

describe('crucible entries made with a restricted model', () => {
  it('are left out of the grid for a signed-out viewer', async () => {
    expect(await listedIds()).toEqual([1, 2, 4]);
  });

  it('are left out of the grid for a moderator', async () => {
    const { items } = await getCrucibleEntries({
      crucibleId: CRUCIBLE,
      limit: 50,
      seed: 3,
      userId: JUDGE,
      browsingLevel: PG_R,
      isModerator: true,
    });
    expect(items.map(({ id }) => id).sort()).toEqual([1, 2, 4]);
  });

  it('stay in the grid for their entrant', async () => {
    expect(await listedIds(ENTRANT)).toEqual([1, 2, 3, 4]);
  });

  it('are never served to a judge', async () => {
    const served = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const pair = await getJudgingPair({
        crucibleId: CRUCIBLE,
        userId: JUDGE,
        browsingLevel: PG_R,
      });
      if (pair) [pair.left.id, pair.right.id].forEach((id) => served.add(id));
    }
    expect(served.size).toBeGreaterThan(0);
    expect(served.has(3)).toBe(false);
  });
});

describe('a podium winner made with a restricted model', () => {
  // Entry 3 (restricted R) won, entry 2 (unrestricted R) came second, entry 1 (restricted PG) third.
  beforeEach(async () => {
    await pg.exec(
      `UPDATE "CrucibleEntry" SET position = CASE id WHEN 3 THEN 1 WHEN 2 THEN 2 WHEN 1 THEN 3 END WHERE id IN (1, 2, 3)`
    );
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      id: CRUCIBLE,
      status: CrucibleStatus.Completed,
      userId: 999,
      textNsfw: false,
      nsfwLevel: PG_R,
      ingestion: CrucibleIngestionStatus.Scanned,
      takenDownAt: null,
      prizePositions: { 1: 50, 2: 30, 3: 20 },
      image: { ingestion: 'Scanned', needsReview: null, tosViolation: false },
    } as never);
  });

  afterEach(async () => {
    await pg.exec(`UPDATE "CrucibleEntry" SET position = NULL`);
  });

  /** Each podium entry id, and whether it came with its image. */
  const podiumImages = async (viewer: { userId?: number; isModerator?: boolean }) => {
    const { podium } = await getCrucibleEntries({
      crucibleId: CRUCIBLE,
      limit: 50,
      browsingLevel: PG_R,
      ...viewer,
    });
    return Object.fromEntries(podium.map(({ id, image }) => [id, image !== null]));
  };

  // A paid place never drops off the podium; only its image is withheld.
  it('keeps its place without its image for a signed-out viewer', async () => {
    expect(await podiumImages({})).toEqual({ 3: false, 2: true, 1: true });
  });

  it('keeps its place without its image for a moderator', async () => {
    expect(await podiumImages({ userId: JUDGE, isModerator: true })).toEqual({
      3: false,
      2: true,
      1: true,
    });
  });

  it('comes with its image for its entrant', async () => {
    expect(await podiumImages({ userId: ENTRANT })).toEqual({ 3: true, 2: true, 1: true });
  });
});
