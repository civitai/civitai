import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The winners list (getCompletedChallengesWithWinners) shows only challenges the feed would: the
 * scan gates and the user-challenge flag hold here too, against real SQL.
 */
vi.mock('~/server/services/challenge-block.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getChallengeExcludedUserIds: async () => [],
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProfilePicturesForUsers: async () => ({}),
  getCosmeticsForUsers: async () => ({}),
}));

const { getCompletedChallengesWithWinners } = await import('~/server/services/challenge.service');

// id → what is wrong with it; each but VISIBLE fails one gate.
const VISIBLE = 1;
const NOT_SCANNED = 2;
const NO_COVER = 3;
const POI_COVER = 4;
const USER_COVER_UNSCANNED = 5;
const USER_SCANNED = 6;

let db: PGlite;
let calls = 0;
const run = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) => {
  const sql = Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);
  return db.query(sql.text, sql.values as unknown[]);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ChallengeStatus" AS ENUM ('Scheduled', 'Active', 'Completed', 'Cancelled');
    CREATE TYPE "ChallengeSource" AS ENUM ('System', 'Mod', 'User');
    CREATE TYPE "ChallengeIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked');
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked');
    CREATE TYPE "CommentEntityType" AS ENUM ('challenge', 'review');
    CREATE TABLE "User" (id int PRIMARY KEY, username text, image text, "deletedAt" timestamp, "profilePictureId" int);
    CREATE TABLE "ChallengeJudge" (id int PRIMARY KEY, name text, bio text, "userId" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, poi boolean DEFAULT false, ingestion "ImageIngestionStatus",
      "nsfwLevel" int DEFAULT 1, url text, "needsReview" text, "blockedFor" text, "userId" int);
    CREATE TABLE "Challenge" (
      id int PRIMARY KEY, title text, theme text, invitation text, "coverImageId" int,
      "startsAt" timestamp DEFAULT now(), "endsAt" timestamp DEFAULT now(),
      "visibleAt" timestamp DEFAULT now() - interval '1 day',
      status "ChallengeStatus" DEFAULT 'Completed', source "ChallengeSource" DEFAULT 'System',
      ingestion "ChallengeIngestionStatus" DEFAULT 'Scanned', "buzzType" text DEFAULT 'yellow',
      "prizePool" int DEFAULT 0, "nsfwLevel" int DEFAULT 1, "allowedNsfwLevel" int DEFAULT 1,
      "modelVersionIds" int[], "collectionId" int, "createdById" int DEFAULT 100,
      "judgeId" int, "eventId" int, metadata jsonb, "judgingCategories" jsonb
    );
    CREATE TABLE "ChallengeWinner" ("challengeId" int, place int, "userId" int, "imageId" int);
    CREATE TABLE "CollectionItem" ("collectionId" int, "imageId" int, status text, note text);
    CREATE TABLE "CommentV3" (
      "entityType" "CommentEntityType", "entityId" int, "parentId" int, "deletedAt" timestamp,
      "tosViolation" boolean DEFAULT false
    );

    INSERT INTO "User" (id, username) VALUES (100, 'creator');
    INSERT INTO "Image" (id, poi, ingestion) VALUES
      (10, false, 'Scanned'), (11, true, 'Scanned'), (12, false, 'Pending');
    INSERT INTO "Challenge" (id, "coverImageId", ingestion, source) VALUES
      (${VISIBLE}, 10, 'Scanned', 'System'),
      (${NOT_SCANNED}, 10, 'Pending', 'System'),
      (${NO_COVER}, NULL, 'Scanned', 'System'),
      (${POI_COVER}, 11, 'Scanned', 'System'),
      (${USER_COVER_UNSCANNED}, 12, 'Scanned', 'User'),
      (${USER_SCANNED}, 10, 'Scanned', 'User');
    INSERT INTO "ChallengeWinner" ("challengeId", place, "userId")
      SELECT id, 1, 100 FROM "Challenge";
  `);
  // Phase 1 runs against PGlite; the later batch reads see no rows, so only visibility is tested.
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => (calls++ === 0 ? (await run(first, values)).rows : [])) as never);
  vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([]);
});
afterAll(() => db.close());

const listed = async (canAccessUserChallenges: boolean) => {
  calls = 0;
  const { items } = await getCompletedChallengesWithWinners({
    limit: 20,
    isGreen: false,
    canAccessUserChallenges,
  });
  return items.map((c) => c.id).sort();
};

describe('getCompletedChallengesWithWinners visibility', () => {
  it('lists only scanned challenges with a scanned, non-POI cover', async () => {
    expect(await listed(true)).toEqual([VISIBLE, USER_SCANNED]);
  });

  it('leaves out user challenges while the user-challenge flag is off', async () => {
    expect(await listed(false)).toEqual([VISIBLE]);
  });
});
