import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The rating tool serves another user's image only when the shared single-image rule would show
 * it to someone who is not its uploader. Image rows live in an in-process Postgres.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { createCallerFactory } = await import('~/server/trpc');
const { researchRouter } = await import('~/server/routers/research.router');

const RATER = 20;
const CLEAN = 1;
const ACCEPTABLE_MINOR = 2;
const HELD = 3;
const BLOCKED_FOR = 4;
const TOS_VIOLATION = 5;

beforeAll(async () => {
  // The rater is mid-track at its start, so the read is the next page from the first image.
  redisMock.redis.hGetAll.mockResolvedValue({ currentTrack: 't1', 'track:t1': '0' });
  // Every fixture image is a sanity image, and the rater has no strikes.
  redisMock.sysRedis.sMembers.mockResolvedValue(['1', '2', '3', '4', '5']);
  redisMock.redis.hGet.mockResolvedValue('0');
  redisMock.sysRedis.hGetAll.mockResolvedValue({
    t1: JSON.stringify({ startingPoint: 0, startTime: '2020-01-01T00:00:00Z' }),
  });
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 5, "postId" int, url text NOT NULL,
      type text NOT NULL DEFAULT 'image', "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, metadata jsonb, "blockedFor" text,
      minor boolean NOT NULL DEFAULT false, "modelRestricted" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb,
      meta jsonb, "hideMeta" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 5, "publishedAt" timestamp,
      "collectionId" int, availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "bannerId" int, status text, "publishedAt" timestamp, ingestion text, availability "Availability" DEFAULT 'Public', "userId" int
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability");
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int);
    INSERT INTO "Post" (id, "publishedAt") VALUES (1, now() - interval '1 day');
    CREATE TABLE research_ratings ("userId" int, "imageId" int, "createdAt" timestamp);
    CREATE TABLE research_ratings_resets ("userId" int, "createdAt" timestamp);
    INSERT INTO "Image" (id, "postId", url, "acceptableMinor", "needsReview", "blockedFor", "tosViolation") VALUES
      (${CLEAN}, 1, 'img-clean', false, NULL, NULL, false),
      (${ACCEPTABLE_MINOR}, 1, 'img-acceptable-minor', true, NULL, NULL, false),
      (${HELD}, 1, 'img-held', false, 'minor', NULL, false),
      (${BLOCKED_FOR}, 1, 'img-blocked', false, NULL, 'tos', false),
      (${TOS_VIOLATION}, 1, 'img-tos', false, NULL, NULL, true);
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

const callerForRater = () =>
  createCallerFactory(researchRouter)({
    user: { id: RATER, onboarding: 15, emailVerified: new Date(0), meta: {} },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: { headers: {} },
    res: undefined,
  } as never);

const raterImages = async () =>
  (await callerForRater().raterGetImages({ level: 1 })).images.map((i) => i.id);
const sanityImages = async () =>
  (await callerForRater().raterGetStatus()).sanityImages.map((i) => i.id);

describe('research.raterGetImages', () => {
  it('serves a published, reviewed image (control)', async () => {
    expect(await raterImages()).toContain(CLEAN);
  });

  it.each([
    ['marked acceptable-minor', ACCEPTABLE_MINOR],
    ['held for review', HELD],
    ['carrying a block reason', BLOCKED_FOR],
    ['marked as a ToS violation', TOS_VIOLATION],
  ])("does not serve another user's image %s", async (_, id) => {
    expect(await raterImages()).not.toContain(id);
  });

  describe('sanity images', () => {
    it('serves a published, reviewed sanity image (control)', async () => {
      expect(await sanityImages()).toContain(CLEAN);
    });

    it.each([
      ['marked acceptable-minor', ACCEPTABLE_MINOR],
      ['held for review', HELD],
      ['carrying a block reason', BLOCKED_FOR],
      ['marked as a ToS violation', TOS_VIOLATION],
    ])('does not serve a sanity image %s', async (_, id) => {
      expect(await sanityImages()).not.toContain(id);
    });
  });
});
