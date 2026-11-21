import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { getCurrentDailyChallenge } from '~/server/services/daily-challenge.service';

// `dailyChallenge.getCurrent` returns the active challenge's cover url from the challenge row
// query; here that query runs against Postgres, so the cover rule decides each case.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const PAST = '2026-01-01T00:00:00Z';
const FUTURE = '2999-01-01T00:00:00Z';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ChallengeStatus" AS ENUM ('Scheduled', 'Active', 'Completed', 'Cancelled');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3), availability "Availability" NOT NULL DEFAULT 'Public');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text, hash text, width int, height int, "userId" int NOT NULL DEFAULT 1,
      "nsfwLevel" int NOT NULL DEFAULT 0, "modelRestricted" boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false, "postId" int REFERENCES "Post"(id),
      "needsReview" text, minor boolean NOT NULL DEFAULT false, "acceptableMinor" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Challenge" (
      id int PRIMARY KEY, "startsAt" timestamp(3) NOT NULL DEFAULT now(), "endsAt" timestamp(3), "visibleAt" timestamp(3),
      title text NOT NULL DEFAULT 'Challenge', description text, theme text, invitation text, "coverImageId" int,
      "nsfwLevel" int, "allowedNsfwLevel" int, "modelVersionIds" int[], "collectionId" int, "judgeId" int,
      "judgingPrompt" text, "judgingEngine" text, "reviewPercentage" int, "maxReviews" int, "maxEntriesPerUser" int,
      prizes jsonb NOT NULL DEFAULT '[]', "entryPrize" jsonb, "entryPrizeRequirement" int NOT NULL DEFAULT 0,
      "prizePool" int, "prizeMode" text, "basePrizePool" int, "buzzPerAction" int, "poolTrigger" text,
      "maxPrizePool" int, "prizeDistribution" jsonb, "operationBudget" int, "operationSpent" int,
      "reviewCostType" text, "reviewCost" int, "createdById" int, source text, "buzzType" text,
      status "ChallengeStatus" NOT NULL DEFAULT 'Active', ingestion text, "scannedAt" timestamp(3),
      "entryFee" int, "maxParticipants" int, "judgingCategories" jsonb, "eventId" int, metadata jsonb NOT NULL DEFAULT '{}'
    );
    INSERT INTO "Post" (id, "publishedAt", availability) VALUES
      (1, '${PAST}', 'Public'), (2, NULL, 'Public'), (3, '${FUTURE}', 'Public'), (4, '${PAST}', 'Private');
  `);
  const { queryRaw } = pgliteRaw(db);
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(queryRaw as never);
});
afterAll(() => db?.close());

const CLEAN = {
  needsReview: null as string | null,
  tosViolation: false,
  acceptableMinor: false,
  minor: false,
  nsfwLevel: NsfwLevel.PG as number,
  postId: null as number | null,
};
let nextId = 1;

async function currentCoverUrl(cover: Partial<typeof CLEAN>) {
  const row = { ...CLEAN, ...cover };
  const id = nextId++;
  await db.query(
    `INSERT INTO "Image" (id, url, "nsfwLevel", "tosViolation", "postId", "needsReview", minor, "acceptableMinor")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      `cover-${id}`,
      row.nsfwLevel,
      row.tosViolation,
      row.postId,
      row.needsReview,
      row.minor,
      row.acceptableMinor,
    ]
  );
  await db.query('DELETE FROM "Challenge"');
  await db.query(`INSERT INTO "Challenge" (id, "coverImageId", "collectionId") VALUES (1, $1, 9)`, [
    id,
  ]);
  const [current] = await getCurrentDailyChallenge();
  return { url: `cover-${id}`, returned: current?.coverUrl };
}

beforeEach(() => {
  vi.mocked(dbMock.dbRead.$queryRaw).mockClear();
});

describe('dailyChallenge.getCurrent — the cover url', () => {
  it('is returned for a clean cover (control)', async () => {
    const { url, returned } = await currentCoverUrl({});
    expect(returned).toBe(url);
  });

  it('is returned for a clean cover in a published public post (control)', async () => {
    const { url, returned } = await currentCoverUrl({ postId: 1 });
    expect(returned).toBe(url);
  });

  it.each<[string, Partial<typeof CLEAN>]>([
    ['held for review', { needsReview: 'minor' }],
    ['a ToS removal', { tosViolation: true }],
    ['an acceptable-minor image', { acceptableMinor: true }],
    ['unrated', { nsfwLevel: 0 }],
    ['Blocked', { nsfwLevel: NsfwLevel.Blocked }],
    ['minor-flagged at R', { minor: true, nsfwLevel: NsfwLevel.R }],
    ['in an unpublished post', { postId: 2 }],
    ['in a scheduled post', { postId: 3 }],
    ['in a Private post', { postId: 4 }],
  ])('is withheld for a cover %s', async (_, cover) => {
    const { returned } = await currentCoverUrl(cover);
    expect(returned).toBe('');
  });
});
