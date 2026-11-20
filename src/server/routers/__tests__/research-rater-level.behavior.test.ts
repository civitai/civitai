import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { createCallerFactory } = await import('~/server/trpc');
const { researchRouter } = await import('~/server/routers/research.router');

const ALL = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;

beforeAll(async () => {
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
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 5, "postId" int, url text NOT NULL,
      type text NOT NULL DEFAULT 'image', "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, metadata jsonb, "blockedFor" text,
      minor boolean NOT NULL DEFAULT false, "modelRestricted" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb, meta jsonb, "hideMeta" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT 5, "publishedAt" timestamp,
      "collectionId" int, availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "bannerId" int, status text, "publishedAt" timestamp, ingestion text
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability");
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int);
    CREATE TABLE research_ratings ("userId" int, "imageId" int, "createdAt" timestamp);
    CREATE TABLE research_ratings_resets ("userId" int, "createdAt" timestamp);
    INSERT INTO "Post" (id, "publishedAt") VALUES (1, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", url, "nsfwLevel") VALUES
      (1, 1, 'pg', ${NsfwLevel.PG}),
      (2, 1, 'pg13', ${NsfwLevel.PG13}),
      (3, 1, 'r', ${NsfwLevel.R}),
      (4, 1, 'x', ${NsfwLevel.X}),
      (5, 1, 'xxx', ${NsfwLevel.XXX});
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

const caller = ({
  showNsfw,
  browsingLevel,
  canViewNsfw = true,
}: {
  showNsfw: boolean;
  browsingLevel: number;
  canViewNsfw?: boolean;
}) =>
  createCallerFactory(researchRouter)({
    user: {
      id: 20,
      onboarding: 15,
      emailVerified: new Date(0),
      meta: {},
      showNsfw,
      browsingLevel,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { canViewNsfw, isGreen: !canViewNsfw },
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: { headers: {} },
    res: undefined,
  } as never);

const sanityImageIds = async (who: Parameters<typeof caller>[0]) =>
  (await caller(who).raterGetStatus()).sanityImages.map((i) => i.id).sort();

const levelsServed = async (who: Parameters<typeof caller>[0], level: number) =>
  (await caller(who).raterGetImages({ level })).images.map((i) => i.nsfwLevel);

describe('research.raterGetImages level', () => {
  it('serves a mature-browsing user every level they ask for (control)', async () => {
    expect(await levelsServed({ showNsfw: true, browsingLevel: ALL }, ALL)).toEqual([
      NsfwLevel.PG,
      NsfwLevel.PG13,
      NsfwLevel.R,
      NsfwLevel.X,
      NsfwLevel.XXX,
    ]);
  });

  it('serves a mature-browsing user an X request', async () => {
    expect(await levelsServed({ showNsfw: true, browsingLevel: ALL }, NsfwLevel.X)).toEqual([
      NsfwLevel.X,
    ]);
  });

  it('serves nothing mature to a user with mature content off, whatever they ask for', async () => {
    expect(await levelsServed({ showNsfw: false, browsingLevel: ALL }, ALL)).toEqual([
      NsfwLevel.PG,
    ]);
    expect(await levelsServed({ showNsfw: false, browsingLevel: ALL }, NsfwLevel.X)).toEqual([]);
  });

  it('holds a mature-browsing user to their own saved level', async () => {
    const own = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R;
    expect(await levelsServed({ showNsfw: true, browsingLevel: own }, ALL)).toEqual([
      NsfwLevel.PG,
      NsfwLevel.PG13,
      NsfwLevel.R,
    ]);
  });

  it('caps a caller on the SFW domain at PG-13', async () => {
    expect(
      await levelsServed({ showNsfw: true, browsingLevel: ALL, canViewNsfw: false }, ALL)
    ).toEqual([NsfwLevel.PG, NsfwLevel.PG13]);
  });

  describe('sanity images', () => {
    it('serves a mature-browsing user every sanity image (control)', async () => {
      expect(await sanityImageIds({ showNsfw: true, browsingLevel: ALL })).toEqual([1, 2, 3, 4, 5]);
    });

    it('serves a user with mature content off only PG sanity images', async () => {
      expect(await sanityImageIds({ showNsfw: false, browsingLevel: ALL })).toEqual([1]);
    });

    it('caps a caller on the SFW domain at PG-13', async () => {
      expect(
        await sanityImageIds({ showNsfw: true, browsingLevel: ALL, canViewNsfw: false })
      ).toEqual([1, 2]);
    });
  });
});
